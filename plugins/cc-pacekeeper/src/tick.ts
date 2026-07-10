#!/usr/bin/env bun
import { bootstrapConfigIfMissing, isProjectDenied, loadConfig, type Config } from './config';
import { contextPercent, readContextTokens, readMostRecentModel, resolveUsableContextWindow } from './ctx-tokens';
import { emitAdditionalContext, emitBlock, emitEmpty, readStdinJson } from './hook-io';
import { laneOf, listActive } from './checkpoint';
import {
    computeSnapshot,
    formatArbitrageNudge,
    formatBridgeDirective,
    formatDirective,
    formatMeterSegment,
    formatStatusLine,
    type Snapshot
} from './thresholds';
import { keepaliveDirective, scanKeepaliveState, scanMarkerCreates, pingGate, KEEPALIVE_MARKER } from './keepalive';
import { peekLevel, shouldInjectAndRecord, stateKey, type Level, type Meter } from './state';
import { touchSession, updateSession, getSessionEntry, type SessionEntry } from './session-state';
import { detectAfkReturn, formatTimeSegment } from './timeline';
import { liveSessionCount } from './live-sessions';
import { fetchUsageData, readUsageCacheFile } from './vendor/usage-fetch';
import type { UsageData } from './vendor/usage-types';
import { fetchAndCacheMaxInputTokens, readCachedMaxInputTokens } from './model-info';
import {
    effectivePause,
    formatPauseDirective,
    formatSubagentContract,
    listHandoffs,
    hasHandoff,
    RESUME_MARKER
} from './agent-budget';

async function main(): Promise<void> {
    const stdin = await readStdinJson();
    const event = stdin.hook_event_name ?? '';
    const cwd = stdin.cwd ?? process.cwd();
    const sessionId = stdin.session_id ?? 'unknown';
    // agent_id is present only inside subagent hook calls (any tool event, any
    // nesting depth) — its absence is how every main-only branch below (AFK,
    // idle/keepalive, arbitrage, SessionStart banner, auto-loop) tells itself
    // apart from a subagent tick. key is the agent-scoped state key: opaque to
    // state.ts/session-state.ts, but keeps a subagent's debounce/session entry
    // from being starved by (or clobbering) the main thread's shared session_id.
    const agentId = stdin.agent_id;
    const agentType = stdin.agent_type;
    const key = stateKey(sessionId, agentId);
    const isMainThread = agentId === undefined;

    bootstrapConfigIfMissing();
    const cfg = loadConfig();

    if (isProjectDenied(cwd, cfg)) {
        emitEmpty();
        return;
    }

    if (event === 'SubagentStart') {
        emitAdditionalContext(event, await buildSubagentStartContext(stdin, cfg, sessionId, agentId, agentType));
        return;
    }

    if (event === 'SubagentStop') {
        emitAdditionalContext(event, buildSubagentStopContext(cfg, sessionId, agentId, cwd));
        return;
    }

    // ── Keepalive pings are system events, not user activity. A ping arrives as
    //    a UserPromptSubmit carrying the marker; if we let it fall through it
    //    would overwrite lastEventAt (destroying the real idle-start time) and
    //    surface a bogus "you were away" line. Short-circuit before any state
    //    mutation so the ping is transparent to idle tracking. Main thread only
    //    — subagents never see UserPromptSubmit (no user prompts at that depth). ──
    if (isMainThread && event === 'UserPromptSubmit' && (stdin.prompt ?? '').includes(KEEPALIVE_MARKER)) {
        // The ping is where idle is actually measurable. Read (don't mutate) the
        // session entry: gap = now - lastEventAt is the true idle time.
        const entry = getSessionEntry(sessionId);
        if (entry) {
            const gapMs = Date.now() - entry.lastEventAt;
            const gate = pingGate(gapMs, cfg);
            if (gate === 'block') {
                // User is active — suppress the ping hook-side. Zero context cost.
                // The recurring job persists; nothing to reschedule or delete.
                emitBlock('[pacekeeper] keepalive ping suppressed — user active');
                return;
            }
            // Total idle accumulates across ping turns: each passthrough ping
            // ends in a Stop that bumps lastEventAt, so gapMs alone tops out
            // around interval_min. Anchor to the first idle moment instead.
            const idleSince = entry.keepalive?.idleSince ?? entry.lastEventAt;
            const idleMs = Date.now() - idleSince;
            updateSession(sessionId, Date.now(), { keepalive: { ...entry.keepalive, idleSince } });
            const maxIdleMs = cfg.keepalive.max_idle_hours * 3600_000;
            if (idleMs > maxIdleMs) {
                const hours = Math.floor(idleMs / 3600_000);
                const idleLabel = hours >= 1 ? `${hours} hours` : `${Math.floor(idleMs / 60_000)} minutes`;
                const state = stdin.transcript_path ? scanKeepaliveState(stdin.transcript_path) : { hasPending: false };
                const jobRef = state.pendingTaskId
                    ? `the keepalive cron job with id ${state.pendingTaskId}`
                    : `the keepalive cron job whose prompt contains ${KEEPALIVE_MARKER} (use CronList to find it)`;
                const guidance = `${KEEPALIVE_MARKER} User has been idle over ${idleLabel}. Delete ${jobRef} via CronDelete, then reply with a single word.`;
                emitAdditionalContext(event, guidance);
                return;
            }
            const mins = cfg.keepalive.interval_min;
            const idleMin = Math.floor(idleMs / 60_000);
            const guidance = `${KEEPALIVE_MARKER} User idle ${idleMin}m. Reply with a single word; the recurring keepalive job stays scheduled every ~${mins}m — do NOT create or delete any cron jobs.`;
            emitAdditionalContext(event, guidance);
            return;
        }
        emitEmpty();
        return;
    }

    // ── Update per-session timeline state on every event. previousEventAt is
    //    the prior event's time, used to detect an AFK gap. Keyed by `key`
    //    (agent-scoped) so a subagent's timeline doesn't clobber or starve on
    //    the main thread's shared session_id. ──
    const nowMs = Date.now();
    const { previousEventAt, entry: sessionEntry } = touchSession(key, nowMs);

    // ── SessionStart: surface active checkpoint(s) + orphan handoffs if
    //    present, then continue. Main thread only — SubagentStart has its own
    //    early-return branch above. ──
    let sessionStartBlock = '';
    if (isMainThread && event === 'SessionStart') {
        sessionStartBlock = buildSessionStartContext(cwd, cfg.checkpoint_dir_name);
    }

    // ── Compute meters from cached usage + transcript. Hot path. The only API
    //    calls are a once-per-model context-window fetch on cache-miss (below)
    //    and, on SessionStart, a usage refetch when the cache is detectably
    //    stale (further below). ──
    const ctxTokens = stdin.transcript_path ? readContextTokens(stdin.transcript_path) : null;
    const model = stdin.model
        ?? ctxTokens?.model
        ?? (stdin.transcript_path ? readMostRecentModel(stdin.transcript_path) : null)
        ?? undefined;

    // If we have a model id but no cached max_input_tokens yet, fetch it now so
    // this tick reports an accurate context %. One accurate tick beats one wrong
    // one, and the fetch happens at most once per model (the cache is eternal).
    // This must run for every event, not just SessionStart: a model first seen
    // mid-session (a model switch, or a resume/compact SessionStart that omits
    // `model`) would otherwise stay on the 200k fallback for the rest of the
    // session. The PostToolUse refresh also populates this cache in the
    // background, but this guarantees correctness on the very next tick.
    if (model && readCachedMaxInputTokens(model) === null) {
        try { await fetchAndCacheMaxInputTokens(model); } catch { /* fall through to 200k */ }
    }

    const usableWindow = resolveUsableContextWindow(model, cfg.context_window_size);
    const ctxPct = ctxTokens ? contextPercent(ctxTokens.contextLength, usableWindow) : null;

    let usage: UsageData | null = readUsageCacheFile();
    if (event === 'SessionStart' && hasStaleReset(usage)) {
        // Last block ended while no Claude session was running, so nothing
        // refreshed the cache. Force a synchronous refetch before computing
        // the snapshot — SessionStart fires once, latency is acceptable.
        try {
            usage = await fetchUsageData();
        } catch {
            // computeSnapshot will drop stale-reset readings.
        }
    }

    const snap = computeSnapshot({ contextPercent: ctxPct, usage }, cfg);

    // ── Decide injection based on event type. ──
    const nowSec = Math.floor(Date.now() / 1000);
    let injection = '';

    // ── [G4] ctx auto-save, crossing-based re-arm. Runs on every event for
    //    both main thread and subagents (each has its own key/entry), ahead of
    //    the per-event branches so it can fold into whichever injection they
    //    produce. Fires once per climb: arm when ctx crosses into critical,
    //    disarm once a later tick sees ctx back below warn (compaction ran). ──
    let ctxAutoSaveDirective: string | null = null;
    {
        const ctxReading = snap.readings.find(r => r.meter === 'context');
        const armed = sessionEntry.ctxAutoSaveArmed ?? false;
        if (ctxReading && ctxReading.level === 'critical' && !armed) {
            ctxAutoSaveDirective = formatCtxAutoSaveDirective(snap);
            updateSession(key, nowMs, { ctxAutoSaveArmed: true });
        } else if (ctxReading && ctxReading.level !== 'warn' && ctxReading.level !== 'critical' && armed) {
            updateSession(key, nowMs, { ctxAutoSaveArmed: false });
        }
    }

    // ── Auto-loop (main thread only): autonomous block renewal. Fires once
    //    per block (idempotency keyed on the block's own resetsAt, not time)
    //    when 5h reaches five_hour_pct. Takes precedence over the bridge/
    //    checkpoint directives on this same tick — one save covers everything,
    //    and only the 5h path arms a wake. ──
    let autoDirective: string | null = null;
    if (isMainThread && cfg.auto.enabled) {
        const five = snap.readings.find(r => r.meter === 'five_hour');
        // Idempotency key is resetsAt rounded to the minute: the usage API
        // jitters the same block's resetsAt at sub-second precision across
        // fetches, and an exact-string compare re-fires the directive on
        // every jitter (observed live: 6 re-fires in one block).
        const resetKey = five?.resetsAt ? String(Math.floor(Date.parse(five.resetsAt) / 60_000)) : undefined;
        if (five && five.percent >= cfg.auto.five_hour_pct && resetKey
            && sessionEntry.lastAutoFireResetAt !== resetKey) {
            autoDirective = formatAutoLoopDirective(snap, cfg, five.resetsAt!);
            updateSession(key, nowMs, { lastAutoFireResetAt: resetKey, ctxAutoSaveArmed: true });
            ctxAutoSaveDirective = null; // combined into autoDirective already
        }
    }

    if (event === 'SessionStart') {
        // Always-allow snapshot at notify+ on SessionStart so Claude knows where it stands.
        if (snap.maxLevel !== 'none') {
            injection = formatStatusLine(snap);
            // Update debounce state without spamming.
            updateAllDebounce(key, snap, nowSec, cfg.debounce_seconds);
        }
    } else if (event === 'UserPromptSubmit') {
        // RESUME_MARKER prompts are the real work trigger after an auto-wake:
        // NOT suppressed like keepalive pings — inject fresh orientation
        // (meters + active lane + pending handoffs) instead of the normal
        // per-prompt heartbeat.
        if (isMainThread && (stdin.prompt ?? '').includes(RESUME_MARKER)) {
            injection = buildResumeOrientation(cwd, cfg, snap);
        } else {
            // Always inject the combined time + meter line, plus any AFK-return note
            // and any debounced warn/critical directive. This is the per-prompt
            // heartbeat: the user sees where time and budget stand every turn.
            const afk = afkLine(key, previousEventAt, sessionEntry, nowMs, cfg);
            const directive = autoDirective ?? ctxAutoSaveDirective ?? directiveIfEscalated(key, snap, nowSec, cfg);
            const extras: string[] = [];
            // No keepalive handling on a real prompt: the chain self-terminates at
            // ping-fire time, so there is nothing to cancel here.
            const arb = isMainThread ? formatArbitrageNudge(snap, model) : null;
            if (arb) extras.push(arb);
            injection = composeLine(nowMs, sessionEntry, snap, cfg, afk, directive, extras);
            // A real prompt ends the idle window: drop the keepalive idle anchor.
            const keepalive = sessionEntry.keepalive?.idleSince !== undefined
                ? { ...sessionEntry.keepalive, idleSince: undefined }
                : sessionEntry.keepalive;
            updateSession(key, nowMs, { lastTimestampInjectedAt: nowMs, keepalive });
        }
    } else if (event === 'PreToolUse') {
        if (isMainThread) {
            // Dispatch advisory: caution (never deny) before spawning a subagent
            // when 5h is already at warn+ — the tree below would inherit a
            // budget that's already tight.
            const dispatchNote = (stdin.tool_name === 'Agent' || stdin.tool_name === 'Task')
                ? formatDispatchAdvisory(snap)
                : null;

            // Inject the time+status line only once per `time.tool_tick_min` to
            // keep tool-loop overhead minimal; warn/critical directives still
            // fire on their own debounce regardless of the tick gate.
            const lastInj = sessionEntry.lastTimestampInjectedAt ?? 0;
            const tickDue = nowMs - lastInj >= cfg.time.tool_tick_min * 60000;
            const directive = autoDirective ?? ctxAutoSaveDirective ?? directiveIfEscalated(key, snap, nowSec, cfg);
            if (tickDue) {
                injection = composeLine(nowMs, sessionEntry, snap, cfg, null, directive);
                updateSession(key, nowMs, { lastTimestampInjectedAt: nowMs });
            } else if (directive) {
                injection = directive;
            }
            if (dispatchNote) {
                injection = [injection, dispatchNote].filter(s => s && s.trim() !== '').join('\n\n');
            }
        } else {
            // Subagent PreToolUse: compact tick line, agent-keyed debounce.
            // Escalation (at/above effective pause, or any meter critical)
            // replaces the compact line with the pause directive.
            const blockPctAtStart = sessionEntry.blockPctAtStart;
            const five = snap.readings.find(r => r.meter === 'five_hour');
            const pausePct = blockPctAtStart !== undefined ? effectivePause(cfg, blockPctAtStart) : cfg.auto.subagent_pause_pct;
            const shouldEscalate = snap.maxLevel === 'critical'
                || (five !== undefined && five.percent >= pausePct);
            const lastInj = sessionEntry.lastTimestampInjectedAt ?? 0;
            const tickDue = nowMs - lastInj >= cfg.time.tool_tick_min * 60000;
            if (shouldEscalate) {
                injection = formatPauseDirective(snap, agentId!, pausePct);
            } else if (tickDue) {
                injection = formatSubagentTickLine(snap, pausePct);
                updateSession(key, nowMs, { lastTimestampInjectedAt: nowMs });
            }
        }
    } else if (event === 'Stop') {
        const stopLines: string[] = [];
        if (autoDirective) stopLines.push(autoDirective);
        else if (ctxAutoSaveDirective) stopLines.push(ctxAutoSaveDirective);
        // If any meter is currently at warn+ AND last-injected level for any meter
        // shows an escalation persisted, give a soft end-of-turn reminder. Don't
        // re-fire every turn — debounce same-level.
        const escalated = snap.readings.some(r => {
            if (r.level !== 'warn' && r.level !== 'critical') return false;
            // The level is already recorded in debounce state by earlier hooks this turn.
            return peekLevel(key, r.meter) === r.level;
        });
        if (escalated && stopLines.length === 0) {
            const fireMeters = applyDebounce(key, snap, nowSec, cfg.debounce_seconds);
            if (fireMeters.length > 0) {
                stopLines.push(
                    formatStatusLine(snap),
                    '',
                    'End-of-turn reminder: limits remain elevated. Consider saving a checkpoint via /cc-pacekeeper:checkpoint save before starting the next big step.'
                );
            }
        }
        // Stop fires at every turn-end. Ensure a keepalive job exists —
        // idempotently, so it emits at most once per interval, not every turn.
        // Main thread only: subagents have no idle concept of their own.
        // Debounced hook-side too: if Claude ignores the directive (no CronCreate
        // shows up in the transcript), keepaliveDirective alone would re-emit on
        // every single Stop forever, so also gate on time since the last actual
        // emission.
        // Don't re-arm a job that the give-up path just tore down: while
        // keepalive.idleSince shows idleness past max_idle_hours, the teardown
        // turn's own Stop would otherwise immediately re-emit the schedule
        // directive (hasPending is false right after the CronDelete), looping
        // schedule → give-up → reschedule for as long as the user is away.
        // The next real prompt clears idleSince and re-enables keepalive.
        if (isMainThread) {
            const idleSince = sessionEntry.keepalive?.idleSince;
            const gaveUp = idleSince !== undefined
                && nowMs - idleSince > cfg.keepalive.max_idle_hours * 3600_000;
            if (stdin.transcript_path && !gaveUp) {
                const lastDirectiveAt = sessionEntry.lastKeepaliveDirectiveAt ?? 0;
                const debounceDue = nowMs - lastDirectiveAt >= cfg.keepalive.interval_min * 60_000;
                if (debounceDue) {
                    const ka = keepaliveDirective({
                        cfg, snap, state: scanKeepaliveState(stdin.transcript_path),
                        nowMs
                    });
                    if (ka.directive) {
                        if (stopLines.length > 0) stopLines.push('');
                        stopLines.push(ka.directive);
                        updateSession(key, nowMs, { lastKeepaliveDirectiveAt: nowMs });
                    }
                }
            }
        }
        if (stopLines.length > 0) injection = stopLines.join('\n');
    }

    const fullText = [sessionStartBlock, injection].filter(s => s && s.trim() !== '').join('\n\n');

    if (fullText.trim() === '') {
        emitEmpty();
    } else {
        emitAdditionalContext(event || 'UnknownEvent', fullText);
    }
}

/**
 * Build the combined `[pacekeeper]` heartbeat line: time segment + meter
 * segment, with an optional AFK-return note above and an optional warn/critical
 * directive below.
 */
function composeLine(
    nowMs: number,
    entry: SessionEntry,
    snap: ReturnType<typeof computeSnapshot>,
    cfg: ReturnType<typeof loadConfig>,
    afk: string | null,
    directive: string | null,
    extras: string[] = []
): string {
    const time = formatTimeSegment(nowMs, entry, cfg);
    const meters = formatMeterSegment(snap);
    const count = liveSessionCount();
    const live = (count !== null && count > 1) ? ` · ${count} live sessions sharing budget` : '';
    // Cumulative subagent burn this block, if any — approximate (parallel
    // subagent deltas overlap in wall-clock time), hence the tilde.
    const burn = (entry.agentBurnPct ?? 0) > 0 ? ` · agents ~${Math.round(entry.agentBurnPct!)}%` : '';
    const head = meters ? `[pacekeeper] ${time} · ${meters}${burn}${live}` : `[pacekeeper] ${time}${burn}${live}`;
    const lines: string[] = [];
    if (afk) lines.push(afk);
    lines.push(head);
    if (directive) lines.push('', directive);
    for (const extra of extras) lines.push('', extra);
    return lines.join('\n');
}

/**
 * The AFK-return line, surfaced once per gap. Marks it surfaced in session
 * state so a later tick in the same idle window doesn't repeat it.
 */
function afkLine(
    sessionId: string,
    previousEventAt: number | null,
    entry: SessionEntry,
    nowMs: number,
    cfg: ReturnType<typeof loadConfig>
): string | null {
    if (previousEventAt === null) return null;
    const gap = nowMs - previousEventAt;
    const line = detectAfkReturn(gap, cfg);
    if (!line) return null;
    // Guard against double-surfacing within the same gap: only show if the
    // recorded afk marker doesn't already cover this away-window.
    if (entry.afk?.surfaced && entry.afk.awayFrom === previousEventAt) return null;
    updateSession(sessionId, nowMs, { afk: { awayFrom: previousEventAt, surfaced: true } });
    return line;
}

/**
 * Return the warn/critical directive for this event if the debounce fires and
 * the level warrants it; otherwise null. Mirrors the prior PreToolUse gate.
 */
function directiveIfEscalated(
    sessionId: string,
    snap: ReturnType<typeof computeSnapshot>,
    nowSec: number,
    cfg: ReturnType<typeof loadConfig>
): string | null {
    const fired = applyDebounce(sessionId, snap, nowSec, cfg.debounce_seconds);
    if (fired.length === 0) return null;
    if (snap.maxLevel !== 'warn' && snap.maxLevel !== 'critical') return null;
    // Prefer the 5h block-reset bridge over the checkpoint directive when a
    // short reset is imminent: waiting it out beats a checkpoint/resume cycle.
    if (cfg.bridge.enabled) {
        const bridge = formatBridgeDirective(snap, cfg.bridge.max_wait_min);
        if (bridge) return bridge;
    }
    return formatDirective(snap);
}

function applyDebounce(
    sessionId: string,
    snap: ReturnType<typeof computeSnapshot>,
    nowSec: number,
    debounceSec: number
): Meter[] {
    const fired: Meter[] = [];
    for (const r of snap.readings) {
        const d = shouldInjectAndRecord(sessionId, r.meter, r.level, nowSec, debounceSec);
        if (d.shouldInject) fired.push(r.meter);
    }
    return fired;
}

function updateAllDebounce(
    sessionId: string,
    snap: ReturnType<typeof computeSnapshot>,
    nowSec: number,
    debounceSec: number
): void {
    for (const r of snap.readings) {
        shouldInjectAndRecord(sessionId, r.meter, r.level, nowSec, debounceSec);
    }
}

function hasStaleReset(usage: UsageData | null): boolean {
    if (!usage) return false;
    const now = Date.now();
    const resets: (string | undefined)[] = [
        usage.sessionResetAt,
        usage.weeklyResetAt,
        usage.weeklySonnetResetAt,
        usage.weeklyOpusResetAt
    ];
    for (const iso of resets) {
        if (!iso) continue;
        const t = Date.parse(iso);
        if (Number.isFinite(t) && t <= now) return true;
    }
    return false;
}

/** First line of a checkpoint body's Goal section, or undefined if absent. */
function firstGoalLine(body: string): string | undefined {
    const goalMatch = /(^|\n)## Goal\s*\n([\s\S]*?)(?=\n## |\n*$)/.exec(body);
    if (!goalMatch) return undefined;
    const goal = (goalMatch[2] ?? '').trim();
    return goal ? goal.split('\n')[0] : undefined;
}

function ageLabel(createdAt: string): string {
    const created = Date.parse(createdAt);
    if (Number.isNaN(created)) return '';
    const days = (Date.now() - created) / (24 * 60 * 60 * 1000);
    return `${days.toFixed(1)}d`;
}

export function buildSessionStartContext(cwd: string, checkpointDirName: string): string {
    const active = listActive(cwd, checkpointDirName);
    const handoffs = listHandoffs(cwd, checkpointDirName);
    if (active.length === 0 && handoffs.length === 0) return '';
    const lines: string[] = [];

    if (active.length === 1) {
        const newest = active[0]!;
        lines.push(`📌 Active checkpoint found in ${cwd}/${checkpointDirName}/:`);
        lines.push(`   ${newest.path}`);
        lines.push(`   Created: ${newest.frontmatter.created_at}`);
        const goal = firstGoalLine(newest.body);
        if (goal) lines.push(`   Goal: ${goal}`);
        lines.push('');
        lines.push('Run `/cc-pacekeeper:checkpoint resume` to orient from it, or carry on.');
    } else if (active.length > 1) {
        lines.push(`📌 ${active.length} active checkpoint lanes found in ${cwd}/${checkpointDirName}/:`);
        for (const ckpt of active) {
            const name = laneOf(ckpt.frontmatter);
            const branch = ckpt.frontmatter.git_branch ?? '?';
            const goal = firstGoalLine(ckpt.body) ?? '(no goal)';
            lines.push(`   ${name} · ${branch} · ${ageLabel(ckpt.frontmatter.created_at)} · ${goal}`);
        }
        lines.push('');
        lines.push('Run `pacekeeper-checkpoint resume <name>` (or `/cc-pacekeeper:checkpoint resume <name>`) to orient from a specific lane.');
    }

    if (handoffs.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`📎 ${handoffs.length} paused subagent handoff(s) waiting in ${checkpointDirName}/handoffs/:`);
        for (const h of handoffs) {
            lines.push(`   ${h.frontmatter.agent_id} · ${h.frontmatter.agent_type ?? '?'} · ${h.frontmatter.trigger} · ${ageLabel(h.frontmatter.created_at)}`);
        }
        lines.push('');
        lines.push('Re-dispatch the paused work, then archive each via `pacekeeper-checkpoint handoffs archive <agent_id>` once absorbed.');
    }
    return lines.join('\n');
}

/**
 * SubagentStart injection: the budget contract for a freshly spawned agent.
 * Snapshots the block % at spawn time into the agent's OWN keyed session
 * entry (blockPctAtStart) so its later PreToolUse ticks and SubagentStop can
 * compute the effective pause point and burn delta.
 */
async function buildSubagentStartContext(
    stdin: Awaited<ReturnType<typeof readStdinJson>>,
    cfg: ReturnType<typeof loadConfig>,
    sessionId: string,
    agentId: string | undefined,
    agentType: string | undefined
): Promise<string> {
    if (!agentId) return '';
    const nowMs = Date.now();
    const key = stateKey(sessionId, agentId);
    touchSession(key, nowMs);

    const usage = readUsageCacheFile();
    const ctxTokens = stdin.transcript_path ? readContextTokens(stdin.transcript_path) : null;
    const model = stdin.model ?? ctxTokens?.model ?? (stdin.transcript_path ? readMostRecentModel(stdin.transcript_path) : null) ?? undefined;
    const usableWindow = resolveUsableContextWindow(model, cfg.context_window_size);
    const ctxPct = ctxTokens ? contextPercent(ctxTokens.contextLength, usableWindow) : null;
    const snap = computeSnapshot({ contextPercent: ctxPct, usage }, cfg);

    const five = snap.readings.find(r => r.meter === 'five_hour');
    const blockPctAtStart = five?.percent ?? 0;
    updateSession(key, nowMs, { blockPctAtStart });

    return formatSubagentContract(snap, cfg, agentId, agentType, blockPctAtStart);
}

/**
 * SubagentStop: compute the burn delta (current 5h% − blockPctAtStart) and
 * accumulate it into the MAIN session entry (agentBurnPct/agentRuns), so the
 * main tick line can surface `· agents ~N%` (approximate — parallel deltas
 * overlap). Also notes when a handoff exists for this agent id.
 */
function buildSubagentStopContext(
    cfg: ReturnType<typeof loadConfig>,
    sessionId: string,
    agentId: string | undefined,
    cwd: string
): string {
    if (!agentId) return '';
    const nowMs = Date.now();
    const key = stateKey(sessionId, agentId);
    const agentEntry = getSessionEntry(key);
    const blockPctAtStart = agentEntry?.blockPctAtStart;

    const usage = readUsageCacheFile();
    const snap = computeSnapshot({ contextPercent: null, usage }, cfg);
    const five = snap.readings.find(r => r.meter === 'five_hour');

    if (five && blockPctAtStart !== undefined) {
        const delta = Math.max(0, five.percent - blockPctAtStart);
        const mainEntry = getSessionEntry(sessionId);
        const agentBurnPct = (mainEntry?.agentBurnPct ?? 0) + delta;
        const agentRuns = (mainEntry?.agentRuns ?? 0) + 1;
        updateSession(sessionId, nowMs, { agentBurnPct, agentRuns });
    }

    const hasHandoffFile = hasHandoff(cwd, cfg.checkpoint_dir_name, agentId);
    if (hasHandoffFile) {
        return `[pacekeeper] Subagent ${agentId} paused on budget — handoff at ${cfg.checkpoint_dir_name}/handoffs/${agentId}.md`;
    }
    return '';
}

/** Compact PreToolUse tick line for subagents: no ctx clause (step 0: this
 * plugin's transcript_path is shared with the parent, so a subagent's own ctx
 * can't be distinguished from the main thread's — see PR description). */
function formatSubagentTickLine(snap: Snapshot, pausePct: number): string {
    const five = snap.readings.find(r => r.meter === 'five_hour');
    const pct = five ? five.percent.toFixed(0) : '?';
    const mins = five?.resetsAt ? formatMinutesUntil(five.resetsAt) : '';
    const resetPart = mins ? ` (${mins})` : '';
    return `[pacekeeper] 5h ${pct}%${resetPart} · pause at ${pausePct.toFixed(0)}%`;
}

function formatMinutesUntil(resetsAt: string): string {
    const t = Date.parse(resetsAt);
    if (!Number.isFinite(t)) return '';
    const deltaSec = Math.max(0, Math.floor((t - Date.now()) / 1000));
    const h = Math.floor(deltaSec / 3600);
    const m = Math.floor((deltaSec % 3600) / 60);
    return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`;
}

/** Advisory-only (never deny) caution before dispatching a subagent when the
 * 5h block is already at warn+ — the tree below would inherit a tight budget. */
function formatDispatchAdvisory(snap: Snapshot): string | null {
    const five = snap.readings.find(r => r.meter === 'five_hour');
    if (!five || (five.level !== 'warn' && five.level !== 'critical')) return null;
    return `[pacekeeper] Note: 5-hour block already at ${five.percent.toFixed(0)}% — the dispatched agent tree will inherit this budget and may need to pause partway; it carries its own budget contract.`;
}

/**
 * [G4] The combined ctx-critical auto-save directive (context alone, no 5h
 * involvement). Distinct from the auto-loop directive, which folds this in
 * when both fire on the same tick.
 */
function formatCtxAutoSaveDirective(snap: Snapshot): string {
    const status = formatStatusLine(snap);
    return [
        status,
        '',
        '🛑 Context window at critical — save now, do not ask: run /cc-pacekeeper:checkpoint save immediately, then continue on small steps until compaction runs.'
    ].join('\n');
}

/**
 * [G6] Autonomous block-renewal directive: fires once per block when the 5h
 * meter reaches auto.five_hour_pct. Opens with a precedence line (overrides
 * any keepalive single-word instruction), then: (1) save now, no asking;
 * (2) schedule a wake one-shot at reset+wake_delay_min via CronCreate whose
 * prompt starts with RESUME_MARKER; (3) continue on small steps only until
 * renewal. Folds in the ctx-critical directive when both fire on the same
 * tick — only this (the 5h) path arms a wake.
 */
function formatAutoLoopDirective(snap: Snapshot, cfg: Config, blockResetsAt: string): string {
    const status = formatStatusLine(snap);
    const wakeDelayMin = cfg.auto.wake_delay_min;
    const wakeAtIso = new Date(Date.parse(blockResetsAt) + wakeDelayMin * 60_000).toISOString();
    const ctxReading = snap.readings.find(r => r.meter === 'context');
    const ctxAlsoCritical = ctxReading?.level === 'critical';

    return [
        status,
        '',
        'This overrides any keepalive single-word instruction — perform these steps now, then reply briefly.',
        `🔁 5-hour block auto-renewal (≥ ${cfg.auto.five_hour_pct}%${ctxAlsoCritical ? '; context also critical — one save covers both' : ''}):`,
        '  1. Save to the current lane NOW via /cc-pacekeeper:checkpoint save — do not ask the user first.',
        `     Include --wake-at ${wakeAtIso} --wake-prompt "${RESUME_MARKER} <lane name> — resume and re-dispatch any pending handoffs".`,
        `  2. Schedule a ONE-SHOT CronCreate at ${wakeAtIso} (reset + ${wakeDelayMin}m) whose prompt starts with the literal marker ${RESUME_MARKER}, naming the saved lane and the pending-handoff count.`,
        '  3. Continue only on small steps until renewal; defer heavy work or new subagent dispatches until the wake prompt arrives.'
    ].join('\n');
}

/**
 * [G5] Orientation injected on a RESUME_MARKER UserPromptSubmit — the real
 * work trigger after an auto-wake (not suppressed like a keepalive ping).
 * Instructs consuming the checkpoint via `resume` (even in-session — it
 * archives the consumed checkpoint so it isn't re-surfaced) and re-dispatching
 * + archiving any paused handoffs.
 */
function buildResumeOrientation(cwd: string, cfg: ReturnType<typeof loadConfig>, snap: Snapshot): string {
    const status = formatStatusLine(snap);
    const active = listActive(cwd, cfg.checkpoint_dir_name);
    const handoffs = listHandoffs(cwd, cfg.checkpoint_dir_name);
    const lines = [
        status,
        '',
        `${RESUME_MARKER} Auto-wake fired. Run \`pacekeeper-checkpoint resume <lane>\` now (even in-session — this archives the consumed checkpoint so it isn't re-surfaced next session), then re-dispatch any paused handoffs, archiving each via \`pacekeeper-checkpoint handoffs archive <agent_id>\` once absorbed.`
    ];
    if (active.length > 0) {
        lines.push('', `Active lane(s): ${active.map(c => laneOf(c.frontmatter)).join(', ')}`);
    }
    if (handoffs.length > 0) {
        lines.push('', `Pending handoffs: ${handoffs.map(h => h.frontmatter.agent_id).join(', ')}`);
    }
    return lines.join('\n');
}

// Guarded so tests can import buildSessionStartContext without triggering a live run.
if (import.meta.main) {
    main().catch((err) => {
        // Never break Claude's workflow on hook error; emit empty + write debug log.
        try {
            process.stderr.write(`pacekeeper-tick error: ${err instanceof Error ? err.message : String(err)}\n`);
        } catch { /* ignore */ }
        emitEmpty();
    });
}
