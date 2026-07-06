#!/usr/bin/env bun
import { bootstrapConfigIfMissing, isProjectDenied, loadConfig } from './config';
import { contextPercent, readContextTokens, readMostRecentModel, resolveUsableContextWindow } from './ctx-tokens';
import { emitAdditionalContext, emitBlock, emitEmpty, readStdinJson } from './hook-io';
import { laneOf, listActive } from './checkpoint';
import {
    computeSnapshot,
    formatArbitrageNudge,
    formatBridgeDirective,
    formatDirective,
    formatMeterSegment,
    formatStatusLine
} from './thresholds';
import { keepaliveDirective, scanKeepaliveState, pingGate, KEEPALIVE_MARKER } from './keepalive';
import { peekLevel, shouldInjectAndRecord, type Level, type Meter } from './state';
import { touchSession, updateSession, getSessionEntry, type SessionEntry } from './session-state';
import { detectAfkReturn, formatTimeSegment } from './timeline';
import { liveSessionCount } from './live-sessions';
import { fetchUsageData, readUsageCacheFile } from './vendor/usage-fetch';
import type { UsageData } from './vendor/usage-types';
import { fetchAndCacheMaxInputTokens, readCachedMaxInputTokens } from './model-info';

async function main(): Promise<void> {
    const stdin = await readStdinJson();
    const event = stdin.hook_event_name ?? '';
    const cwd = stdin.cwd ?? process.cwd();
    const sessionId = stdin.session_id ?? 'unknown';

    bootstrapConfigIfMissing();
    const cfg = loadConfig();

    if (isProjectDenied(cwd, cfg)) {
        emitEmpty();
        return;
    }

    // ── Keepalive pings are system events, not user activity. A ping arrives as
    //    a UserPromptSubmit carrying the marker; if we let it fall through it
    //    would overwrite lastEventAt (destroying the real idle-start time) and
    //    surface a bogus "you were away" line. Short-circuit before any state
    //    mutation so the ping is transparent to idle tracking. ──
    if (event === 'UserPromptSubmit' && (stdin.prompt ?? '').includes(KEEPALIVE_MARKER)) {
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
    //    the prior event's time, used to detect an AFK gap. ──
    const nowMs = Date.now();
    const { previousEventAt, entry: sessionEntry } = touchSession(sessionId, nowMs);

    // ── SessionStart: surface active checkpoint(s) if present, then continue. ──
    let sessionStartBlock = '';
    if (event === 'SessionStart') {
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

    if (event === 'SessionStart') {
        // Always-allow snapshot at notify+ on SessionStart so Claude knows where it stands.
        if (snap.maxLevel !== 'none') {
            injection = formatStatusLine(snap);
            // Update debounce state without spamming.
            updateAllDebounce(sessionId, snap, nowSec, cfg.debounce_seconds);
        }
    } else if (event === 'UserPromptSubmit') {
        // Always inject the combined time + meter line, plus any AFK-return note
        // and any debounced warn/critical directive. This is the per-prompt
        // heartbeat: the user sees where time and budget stand every turn.
        const afk = afkLine(sessionId, previousEventAt, sessionEntry, nowMs, cfg);
        const directive = directiveIfEscalated(sessionId, snap, nowSec, cfg);
        const extras: string[] = [];
        // No keepalive handling on a real prompt: the chain self-terminates at
        // ping-fire time, so there is nothing to cancel here.
        const arb = formatArbitrageNudge(snap, model);
        if (arb) extras.push(arb);
        injection = composeLine(nowMs, sessionEntry, snap, cfg, afk, directive, extras);
        // A real prompt ends the idle window: drop the keepalive idle anchor.
        const keepalive = sessionEntry.keepalive?.idleSince !== undefined
            ? { ...sessionEntry.keepalive, idleSince: undefined }
            : sessionEntry.keepalive;
        updateSession(sessionId, nowMs, { lastTimestampInjectedAt: nowMs, keepalive });
    } else if (event === 'PreToolUse') {
        // Inject the time+status line only once per `time.tool_tick_min` to keep
        // tool-loop overhead minimal; warn/critical directives still fire on
        // their own debounce regardless of the tick gate.
        const lastInj = sessionEntry.lastTimestampInjectedAt ?? 0;
        const tickDue = nowMs - lastInj >= cfg.time.tool_tick_min * 60000;
        const directive = directiveIfEscalated(sessionId, snap, nowSec, cfg);
        if (tickDue) {
            injection = composeLine(nowMs, sessionEntry, snap, cfg, null, directive);
            updateSession(sessionId, nowMs, { lastTimestampInjectedAt: nowMs });
        } else if (directive) {
            injection = directive;
        }
    } else if (event === 'Stop') {
        const stopLines: string[] = [];
        // If any meter is currently at warn+ AND last-injected level for any meter
        // shows an escalation persisted, give a soft end-of-turn reminder. Don't
        // re-fire every turn — debounce same-level.
        const escalated = snap.readings.some(r => {
            if (r.level !== 'warn' && r.level !== 'critical') return false;
            // The level is already recorded in debounce state by earlier hooks this turn.
            return peekLevel(sessionId, r.meter) === r.level;
        });
        if (escalated) {
            const fireMeters = applyDebounce(sessionId, snap, nowSec, cfg.debounce_seconds);
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
                    updateSession(sessionId, nowMs, { lastKeepaliveDirectiveAt: nowMs });
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
    const head = meters ? `[pacekeeper] ${time} · ${meters}${live}` : `[pacekeeper] ${time}${live}`;
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
    if (active.length === 0) return '';
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
    } else {
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
