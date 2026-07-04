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
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional()
});

const AssistantEntrySchema = z.object({
    type: z.literal('assistant').optional(),
    timestamp: z.string().optional(),
    message: z.object({
        content: z.array(z.unknown()).optional()
    }).optional()
});

export interface KeepaliveState {
    /** The task id of the most recent still-pending keepalive one-shot, if any. */
    pendingTaskId?: string;
    /** ISO/string timestamp the pending one-shot was created, if known. */
    createdAt?: string;
}

function toolUses(obj: unknown): { name: string; input: Record<string, unknown> }[] {
    const parsed = AssistantEntrySchema.safeParse(obj);
    if (!parsed.success) return [];
    const content = parsed.data.message?.content ?? [];
    const out: { name: string; input: Record<string, unknown> }[] = [];
    for (const block of content) {
        const b = ToolUseSchema.safeParse(block);
        if (b.success) out.push({ name: b.data.name, input: b.data.input ?? {} });
    }
    return out;
}

/**
 * Walk the transcript backwards. Find the newest CronCreate whose prompt carries
 * the keepalive marker; if a later CronDelete removed that same task id, treat
 * it as no longer pending. Returns {} when nothing keepalive-related is found.
 *
 * We collect deleted ids on the way down (newest-first) so that when we reach a
 * CronCreate we can tell whether it was subsequently deleted.
 */
export function scanKeepaliveState(transcriptPath: string): KeepaliveState {
    let raw: string;
    try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return {}; }
    const lines = raw.split('\n');

    const deletedIds = new Set<string>();
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || line.length === 0) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }

        const ts = (obj as { timestamp?: string }).timestamp;
        for (const use of toolUses(obj)) {
            if (use.name === 'CronDelete') {
                const id = use.input.id ?? use.input.taskId ?? use.input.cronId;
                if (typeof id === 'string') deletedIds.add(id);
            } else if (use.name === 'CronCreate') {
                const prompt = use.input.prompt;
                if (typeof prompt === 'string' && prompt.includes(KEEPALIVE_MARKER)) {
                    // Newest matching create found. If it was later deleted, this
                    // whole session has no pending keepalive → return {} (a delete
                    // seen below-in-scan means above-in-time, i.e. after create).
                    const id = use.input.id;
                    if (typeof id === 'string' && deletedIds.has(id)) return {};
                    return { pendingTaskId: typeof id === 'string' ? id : undefined, createdAt: ts };
                }
            }
        }
    }
    return {};
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
        if (state.pendingTaskId) {
            return {
                directive: `${KEEPALIVE_MARKER} You are active again; cancel the pending keepalive one-shot: `
                    + `call CronDelete with id "${state.pendingTaskId}".`
            };
        }
        return { directive: null };
    }

    // User is idle. Schedule/refresh a one-shot if none pending or it's stale.
    const staleMs = 10 * 60 * 1000;
    const createdMs = state.createdAt ? Date.parse(state.createdAt) : NaN;
    const fresh = state.pendingTaskId && Number.isFinite(createdMs) && (nowMs - createdMs) < staleMs;
    if (fresh) return { directive: null };

    const mins = cfg.keepalive.interval_min;
    return {
        directive: [
            `${KEEPALIVE_MARKER} The user is idle. To keep the prompt cache warm, schedule a one-shot ~${mins} minutes out via CronCreate.`,
            state.pendingTaskId ? `First CronDelete the stale pending one (id "${state.pendingTaskId}").` : '',
            `The one-shot's prompt MUST contain the literal marker ${KEEPALIVE_MARKER} and instruct: reply with a single word, then, if the user is still idle, reschedule another ${mins}-minute one-shot; if the user has returned, do nothing.`
        ].filter(Boolean).join(' ')
    };
}
