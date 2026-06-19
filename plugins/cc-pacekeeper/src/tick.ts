#!/usr/bin/env bun
import { bootstrapConfigIfMissing, isProjectDenied, loadConfig } from './config';
import { contextPercent, readContextTokens, readMostRecentModel, resolveUsableContextWindow } from './ctx-tokens';
import { emitAdditionalContext, emitEmpty, readStdinJson } from './hook-io';
import { listActive } from './checkpoint';
import {
    computeSnapshot,
    formatDirective,
    formatStatusLine
} from './thresholds';
import { peekLevel, shouldInjectAndRecord, type Level, type Meter } from './state';
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
        // Inject a status line whenever any meter ≥ notify; debounced.
        if (snap.maxLevel !== 'none') {
            const fireMeters = applyDebounce(sessionId, snap, nowSec, cfg.debounce_seconds);
            if (fireMeters.length > 0) {
                injection = snap.maxLevel === 'notify'
                    ? formatStatusLine(snap)
                    : formatDirective(snap);
            }
        }
    } else if (event === 'PreToolUse') {
        // Only fire on transitions or persistence past debounce. Silent at notify
        // unless a transition just happened, to keep tool-loop overhead minimal.
        const fireMeters = applyDebounce(sessionId, snap, nowSec, cfg.debounce_seconds);
        if (fireMeters.length > 0) {
            // Skip noisy notify-only injections in the tool loop; let warn/critical drive.
            if (snap.maxLevel === 'warn' || snap.maxLevel === 'critical') {
                injection = formatDirective(snap);
            }
        }
    } else if (event === 'Stop') {
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
                injection = [
                    formatStatusLine(snap),
                    '',
                    'End-of-turn reminder: limits remain elevated. Consider saving a checkpoint via /cc-pacekeeper:checkpoint save before starting the next big step.'
                ].join('\n');
            }
        }
    }

    const fullText = [sessionStartBlock, injection].filter(s => s && s.trim() !== '').join('\n\n');

    if (fullText.trim() === '') {
        emitEmpty();
    } else {
        emitAdditionalContext(event || 'UnknownEvent', fullText);
    }
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
