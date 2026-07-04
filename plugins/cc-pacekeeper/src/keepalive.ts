import * as fs from 'fs';
import { z } from 'zod';
import type { Config } from './config';
import type { Snapshot } from './thresholds';

/**
 * AFK cache keepalive. When the user goes idle, a short scheduled one-shot fires
 * a trivial turn to keep the prompt cache (and, near a 5h block boundary, the
 * block) warm. This module is the ground truth for "is a keepalive scheduled":
 * it reconstructs pending state from the transcript rather than trusting
 * mutable local state, so it survives restarts and crashes.
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
    /** Whether a keepalive one-shot appears scheduled and not yet deleted. */
    hasPending: boolean;
    /**
     * The task id of the pending keepalive one-shot, if it could be recovered
     * from the CronCreate tool_result. Undefined is normal — CronCreate's INPUT
     * carries no id (it's system-assigned and only appears in the result), so
     * this is best-effort. Callers must not require it.
     */
    pendingTaskId?: string;
    /** ISO/string timestamp the pending one-shot was created, if known. */
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
 * Reconstruct keepalive state from the transcript (forward in time). A keepalive
 * one-shot is "pending" when the newest marker-carrying CronCreate has not been
 * followed by a CronDelete of the job id it returned.
 *
 * NOTE: CronCreate's INPUT has no id — the id is only in its tool_result — so we
 * best-effort correlate create→result→delete. When the id can't be recovered we
 * still report hasPending=true (marker present) but leave pendingTaskId unset.
 */
export function scanKeepaliveState(transcriptPath: string): KeepaliveState {
    let raw: string;
    try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return { hasPending: false }; }

    // First pass forward: collect keepalive CronCreate tool_use ids, and map
    // every tool_use_id → its result text, and every deleted job id.
    const keepaliveCreates: { toolUseId?: string; createdAt?: string }[] = [];
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
                if (typeof prompt === 'string' && prompt.includes(KEEPALIVE_MARKER)) {
                    keepaliveCreates.push({ toolUseId: use.id, createdAt: ts });
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

    if (keepaliveCreates.length === 0) return { hasPending: false };

    // The most recent keepalive create wins.
    const latest = keepaliveCreates[keepaliveCreates.length - 1]!;
    const jobId = latest.toolUseId ? extractJobId(resultByUseId.get(latest.toolUseId) ?? '') : undefined;
    if (jobId && deletedJobIds.has(jobId)) return { hasPending: false };

    return { hasPending: true, pendingTaskId: jobId, createdAt: latest.createdAt };
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
 * Decide the keepalive directive given current state.
 * - When the user has returned (not idle) and a task is pending → instruct delete.
 * - When idle-eligible and no fresh pending one-shot → instruct (re)schedule.
 */
export function keepaliveDirective(args: {
    cfg: Config;
    snap: Snapshot;
    state: KeepaliveState;
    userIsIdle: boolean;
    nowMs: number;
}): KeepaliveDecision {
    const { cfg, snap, state, userIsIdle, nowMs } = args;
    if (!cfg.keepalive.enabled) return { directive: null };
    if (onUsageCredits(snap)) return { directive: null };
    // Keepalive only makes sense with a readable subscription usage cache.
    if (!snap.readings.some(r => r.meter === 'five_hour' || r.meter.startsWith('weekly'))) {
        return { directive: null };
    }

    if (!userIsIdle) {
        // User is active. If a keepalive is still pending, cancel it.
        if (state.hasPending) {
            const target = state.pendingTaskId
                ? `call CronDelete with id "${state.pendingTaskId}"`
                : `run CronList to find the [pacekeeper-keepalive] job, then CronDelete it by id`;
            return { directive: `${KEEPALIVE_MARKER} You are active again; cancel the pending keepalive one-shot: ${target}.` };
        }
        return { directive: null };
    }

    // User is idle. Schedule/refresh a one-shot if none pending or it's stale.
    const staleMs = 10 * 60 * 1000;
    const createdMs = state.createdAt ? Date.parse(state.createdAt) : NaN;
    const fresh = state.hasPending && Number.isFinite(createdMs) && (nowMs - createdMs) < staleMs;
    if (fresh) return { directive: null };

    const mins = cfg.keepalive.interval_min;
    return {
        directive: [
            `${KEEPALIVE_MARKER} The user is idle. To keep the prompt cache warm, schedule a one-shot ~${mins} minutes out via CronCreate (recurring: false; pin the cron minute/hour to ~${mins}m from now).`,
            state.hasPending ? `First cancel the stale pending keepalive (CronList → CronDelete by id).` : '',
            `The one-shot's prompt MUST contain the literal marker ${KEEPALIVE_MARKER} and instruct: reply with a single word, then, if the user is still idle, reschedule another ${mins}-minute one-shot; if the user has returned, do nothing.`
        ].filter(Boolean).join(' ')
    };
}
