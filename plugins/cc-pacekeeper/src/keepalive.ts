import * as fs from 'fs';
import { z } from 'zod';
import type { Config } from './config';
import type { Snapshot } from './thresholds';

/**
 * AFK cache keepalive. A single recurring cron job (scheduled once per session)
 * fires a trivial turn every ~interval_min minutes to keep the prompt cache
 * (and, near a 5h block boundary, the block) warm. Pings are gated hook-side:
 * blocked while the user is active, passed through while idle, and the job is
 * torn down after max_idle_hours. This module is the ground truth for "is a
 * keepalive scheduled": it reconstructs pending state from the transcript
 * rather than trusting mutable local state, so it survives restarts and crashes.
 */

export const KEEPALIVE_MARKER = '[pacekeeper-keepalive]';

/** A tool_use block in an assistant turn. */
const ToolUseSchema = z.object({
    type: z.literal('tool_use'),
    id: z.string().optional(),           // the tool_use id (correlates to its result)
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional()
});

// Any transcript entry with a message.content array (assistant OR user turn).
const EntrySchema = z.object({
    timestamp: z.string().optional(),
    message: z.object({
        content: z.array(z.unknown()).optional()
    }).optional()
});

/** A tool_result block (in a user turn) carrying a tool's output text. */
const ToolResultSchema = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional()
});

export interface KeepaliveState {
    /** Whether a keepalive recurring job appears scheduled and not yet deleted. */
    hasPending: boolean;
    /**
     * The task id of the pending keepalive job, if it could be recovered
     * from the CronCreate tool_result. Undefined is normal — CronCreate's INPUT
     * carries no id (it's system-assigned and only appears in the result), so
     * this is best-effort. Callers must not require it.
     */
    pendingTaskId?: string;
    /** ISO/string timestamp the pending job was created, if known. */
    createdAt?: string;
}

interface ToolUse { id?: string; name: string; input: Record<string, unknown> }

function blocksOf(obj: unknown): { uses: ToolUse[]; results: { toolUseId?: string; text: string }[] } {
    const uses: ToolUse[] = [];
    const results: { toolUseId?: string; text: string }[] = [];
    const entry = EntrySchema.safeParse(obj);
    const content = entry.success ? (entry.data.message?.content ?? []) : [];
    for (const block of content) {
        const u = ToolUseSchema.safeParse(block);
        if (u.success) { uses.push({ id: u.data.id, name: u.data.name, input: u.data.input ?? {} }); continue; }
        const r = ToolResultSchema.safeParse(block);
        if (r.success) {
            const text = typeof r.data.content === 'string'
                ? r.data.content
                : JSON.stringify(r.data.content ?? '');
            results.push({ toolUseId: r.data.tool_use_id, text });
        }
    }
    return { uses, results };
}

// A cron job id is the 8-char token CronCreate returns. Pull it out of a result
// blob heuristically (e.g. "Scheduled job abc12345" / "id: abc12345").
function extractJobId(text: string): string | undefined {
    const m = /\b([a-zA-Z0-9]{8})\b/.exec(text.replace(/[a-f0-9]{16,}/gi, ' '));
    return m ? m[1] : undefined;
}

/**
 * Reconstruct marker-scoped cron state from the transcript (forward in time).
 * A job is "pending" when the newest marker-carrying CronCreate has not been
 * followed by a CronDelete of the job id it returned. Generalized from the
 * keepalive-only version so the same forward-scan logic serves both the
 * keepalive marker and RESUME_MARKER (auto-loop wake scheduling) without
 * duplicating the create→result→delete correlation dance.
 *
 * NOTE: CronCreate's INPUT has no id — the id is only in its tool_result — so we
 * best-effort correlate create→result→delete. When the id can't be recovered we
 * still report hasPending=true (marker present) but leave pendingTaskId unset.
 */
export function scanMarkerCreates(transcriptPath: string, marker: string): KeepaliveState {
    let raw: string;
    try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return { hasPending: false }; }

    // First pass forward: collect marker-carrying CronCreate tool_use ids, and
    // map every tool_use_id → its result text, and every deleted job id.
    const markerCreates: { toolUseId?: string; createdAt?: string }[] = [];
    const resultByUseId = new Map<string, string>();
    const deletedJobIds = new Set<string>();

    for (const line of raw.split('\n')) {
        if (!line) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }
        const ts = (obj as { timestamp?: string }).timestamp;
        const { uses, results } = blocksOf(obj);
        for (const use of uses) {
            if (use.name === 'CronCreate') {
                const prompt = use.input.prompt;
                if (typeof prompt === 'string' && prompt.includes(marker)) {
                    markerCreates.push({ toolUseId: use.id, createdAt: ts });
                }
            } else if (use.name === 'CronDelete') {
                const id = use.input.id;
                if (typeof id === 'string') deletedJobIds.add(id);
            }
        }
        for (const res of results) {
            if (res.toolUseId) resultByUseId.set(res.toolUseId, res.text);
        }
    }

    if (markerCreates.length === 0) return { hasPending: false };

    // The most recent marker create wins.
    const latest = markerCreates[markerCreates.length - 1]!;
    const jobId = latest.toolUseId ? extractJobId(resultByUseId.get(latest.toolUseId) ?? '') : undefined;
    if (jobId && deletedJobIds.has(jobId)) return { hasPending: false };

    return { hasPending: true, pendingTaskId: jobId, createdAt: latest.createdAt };
}

/** Keepalive-specific wrapper over scanMarkerCreates, kept for callers/tests
 * that only care about the keepalive marker. */
export function scanKeepaliveState(transcriptPath: string): KeepaliveState {
    return scanMarkerCreates(transcriptPath, KEEPALIVE_MARKER);
}

/** True when the account is drawing on usage credits and the cache TTL is short
 * (5m) rather than the subscription 1h — keepalive is pointless/off then.
 * Heuristic (user-approved): extra usage enabled AND a plan meter is exhausted. */
export function onUsageCredits(snap: Snapshot): boolean {
    if (!snap.extraUsage?.enabled) return false;
    return snap.readings.some(r =>
        (r.meter === 'five_hour' || r.meter === 'weekly' || r.meter === 'weekly_sonnet' || r.meter === 'weekly_opus')
        && r.percent >= 100
    );
}

export interface KeepaliveDecision {
    /** Directive text to inject, or null for nothing. */
    directive: string | null;
}

/**
 * At ping-fire time, idle is measurable: gapMs = now - lastEventAt is the true
 * gap since the last real event. Decide whether the ping should be suppressed
 * hook-side (user active — costs zero context) or passed through to Claude.
 *
 * The gate is min(idle_threshold_min, interval_min * 0.8): normally the idle
 * threshold, but never above the ping interval itself, so a short interval_min
 * can't make every ping read as "active".
 */
export function pingGate(gapMs: number, cfg: Config): 'block' | 'passthrough' {
    const thresholdMin = Math.min(
        cfg.time.idle_threshold_min,
        cfg.keepalive.interval_min * 0.8
    );
    return gapMs < thresholdMin * 60_000 ? 'block' : 'passthrough';
}

/**
 * Block-reason strings shown when a keepalive ping is suppressed because the
 * user is active. Claude Code renders the block as an alarming yellow "operation
 * blocked by hook" banner that the plugin can't restyle — so the wording carries
 * the whole "this is routine, nothing is broken" message. Rotated for variety.
 *
 * Every line must keep the [pacekeeper] status marker but must NOT start with the
 * KEEPALIVE_MARKER, or it would trip the prompt-start marker gates in tick.ts.
 */
export const PING_SUPPRESSED_REASONS = [
    "[pacekeeper] you're active. Ping dismissed with prejudice.",
    "[pacekeeper] ping suppressed. You're alive. Good talk.",
    "[pacekeeper] busy detected. ping yeeted.",
    "[pacekeeper] keepalive ping: read, ignored. wai.",
    "[pacekeeper] ping went to knock, you answered the door. nvm.",
    "[pacekeeper] ping suppressed — this is not the error you're looking for.",
    "[pacekeeper] you're awake, so this ping can go home.",
    "[pacekeeper] ping suppressed. all systems nominal, carry on.",
    "[pacekeeper] ping suppressed. touch grass? no — you're touching keyboard.",
    "[pacekeeper] you're typing, I checked. ping returned to sender.",
    "[pacekeeper] ping self-destructed on contact with a live user.",
    "[pacekeeper] no pulse check needed, pulse detected. ping voided.",
    "[pacekeeper] ping suppressed. working as designed, unlike most things."
] as const;

/**
 * Pick a suppression reason. Pure and state-free by design: the block path in
 * tick.ts deliberately mutates no state, so rotation is derived from the clock
 * (pings fire minutes apart → the minute bucket varies between them) rather than
 * a persisted counter. Deterministic in `now`, so it unit-tests cleanly.
 */
export function pingSuppressedReason(now: number): string {
    const i = Math.floor(now / 60_000) % PING_SUPPRESSED_REASONS.length;
    return PING_SUPPRESSED_REASONS[i]!;
}

/**
 * Ensure a keepalive job exists. Emits a schedule directive when none is
 * pending, and null otherwise. The job is recurring (scheduled once per
 * session) so there is no reschedule/cancel churn — pings just fire on their
 * own cadence and are gated hook-side (see pingGate) rather than by Claude
 * deciding whether to reschedule.
 *
 * Called on Stop, which fires every turn-end. The idempotency (pending → null)
 * is what keeps it from re-emitting on every turn during active work; tick.ts
 * additionally debounces emission by interval_min so an ignored directive
 * doesn't re-fire every Stop forever.
 */
export function keepaliveDirective(args: {
    cfg: Config;
    snap: Snapshot;
    state: KeepaliveState;
    nowMs: number;
    hasPendingWork?: boolean;
}): KeepaliveDecision {
    const { cfg, snap, state } = args;
    if (!cfg.keepalive.enabled) return { directive: null };
    if (cfg.keepalive.require_pending && args.hasPendingWork === false) return { directive: null };
    if (onUsageCredits(snap)) return { directive: null };
    // Keepalive only makes sense with a readable subscription usage cache.
    if (!snap.readings.some(r => r.meter === 'five_hour' || r.meter.startsWith('weekly'))) {
        return { directive: null };
    }
    if (state.hasPending) return { directive: null };

    const mins = cfg.keepalive.interval_min;
    return {
        directive: [
            `${KEEPALIVE_MARKER} To keep the prompt cache warm while the user is idle, ensure a RECURRING keepalive job exists.`,
            `First call CronList: if a recurring job whose prompt contains ${KEEPALIVE_MARKER} already exists, do NOT create another (and CronDelete extras so exactly one remains — jobs can outlive /clear, so CronList is the ground truth, not this conversation).`,
            `Otherwise schedule one via CronCreate (recurring: true) firing every ~${mins} minutes — use fixed minute marks (e.g. "13,43 * * * *"), not a "*/N" minute step, which fires at uneven wall-clock gaps; its prompt MUST START WITH the literal marker ${KEEPALIVE_MARKER}.`,
            `When it fires, reply with a single word and follow the injected pacekeeper guidance. Do not reschedule or recreate it on later turns.`
        ].join(' ')
    };
}
