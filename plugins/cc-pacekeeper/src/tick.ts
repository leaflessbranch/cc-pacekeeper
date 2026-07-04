#!/usr/bin/env bun
import { bootstrapConfigIfMissing, isProjectDenied, loadConfig } from './config';
import { contextPercent, readContextTokens, readMostRecentModel, resolveUsableContextWindow } from './ctx-tokens';
import { emitAdditionalContext, emitEmpty, readStdinJson } from './hook-io';
import { listActive } from './checkpoint';
import {
    computeSnapshot,
    formatArbitrageNudge,
    formatBridgeDirective,
    formatDirective,
    formatMeterSegment,
    formatStatusLine
} from './thresholds';
import { keepaliveDirective, scanKeepaliveState, pingContinuation, KEEPALIVE_MARKER } from './keepalive';
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
    //    would overwrite lastEventAt (destroying the real idle-start time),
    //    surface a bogus "you were away" line, and emit a cancel directive that
    //    fights the ping's own reschedule instruction. Short-circuit before any
    //    state mutation so the ping is transparent to idle tracking. ──
    if (event === 'UserPromptSubmit' && (stdin.prompt ?? '').includes(KEEPALIVE_MARKER)) {
        // The ping is where idle is actually measurable. Read (don't mutate) the
        // session entry: gap = now - lastEventAt is the true idle time. Tell the
        // chain to reschedule (still idle) or stop (user active again). This is
        // the one place with real data — Stop can't know future idleness.
        const entry = getSessionEntry(sessionId);
        if (entry) {
            const gapMs = Date.now() - entry.lastEventAt;
            const { reschedule } = pingContinuation(gapMs, cfg);
            const mins = cfg.keepalive.interval_min;
            const guidance = reschedule
                ? `${KEEPALIVE_MARKER} User still idle. Reply with a single word, then schedule another ${mins}-minute one-shot via CronCreate whose prompt contains ${KEEPALIVE_MARKER}.`
                : `${KEEPALIVE_MARKER} User is active again. Reply with a single word and do NOT reschedule.`;
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
        updateSession(sessionId, nowMs, { lastTimestampInjectedAt: nowMs });
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
        // Stop fires at every turn-end. Rather than guess idleness (impossible
        // here), just ensure a keepalive chain exists — idempotently, so it emits
        // at most once per interval, not every turn. The chain decides at ping-fire
        // time (with real idle data) whether to continue or stop.
        if (stdin.transcript_path) {
            const ka = keepaliveDirective({
                cfg, snap, state: scanKeepaliveState(stdin.transcript_path),
                nowMs
            });
            if (ka.directive) {
                if (stopLines.length > 0) stopLines.push('');
                stopLines.push(ka.directive);
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

function buildSessionStartContext(cwd: string, checkpointDirName: string): string {
    const active = listActive(cwd, checkpointDirName);
    if (active.length === 0) return '';
    const newest = active[0]!;
    const lines: string[] = [];
    lines.push(`📌 Active checkpoint found in ${cwd}/${checkpointDirName}/:`);
    lines.push(`   ${newest.path}`);
    lines.push(`   Created: ${newest.frontmatter.created_at}`);
    // Pull the Goal section out of the body if present.
    const goalMatch = /(^|\n)## Goal\s*\n([\s\S]*?)(?=\n## |\n*$)/.exec(newest.body);
    if (goalMatch) {
        const goal = (goalMatch[2] ?? '').trim();
        if (goal) lines.push(`   Goal: ${goal.split('\n')[0]}`);
    }
    lines.push('');
    if (active.length === 1) {
        lines.push('Run `/cc-pacekeeper:checkpoint resume` to orient from it, or carry on.');
    } else {
        lines.push(`${active.length - 1} additional active checkpoint(s) exist. Use \`/cc-pacekeeper:checkpoint list\` to review or \`/cc-pacekeeper:checkpoint cleanup\` to tidy.`);
    }
    return lines.join('\n');
}

main().catch((err) => {
    // Never break Claude's workflow on hook error; emit empty + write debug log.
    try {
        process.stderr.write(`pacekeeper-tick error: ${err instanceof Error ? err.message : String(err)}\n`);
    } catch { /* ignore */ }
    emitEmpty();
});
