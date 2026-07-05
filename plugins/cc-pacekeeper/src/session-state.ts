import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { stateDir } from './state';

/**
 * Per-session mutable state (timestamps, AFK/keepalive bookkeeping), kept in
 * ~/.cache/cc-pacekeeper/session-state.json — same dir + conventions as
 * state.ts (safeParse → {} fallback, non-fatal writes). Keyed by session_id.
 */

const AfkSchema = z.object({
    awayFrom: z.number(),   // epoch ms of lastEventAt when the gap opened
    surfaced: z.boolean()   // whether the AFK-return line was already shown
});

const KeepaliveSchema = z.object({
    pendingTaskId: z.string().optional(),
    scheduledAt: z.number().optional(),
    // Idle-start anchor for the give-up check. Each passthrough ping turn ends
    // with a Stop that bumps lastEventAt, so `now - lastEventAt` alone never
    // grows past ~interval_min; this survives across ping turns and is cleared
    // by the next real user prompt.
    idleSince: z.number().optional()
});

const SessionEntrySchema = z.object({
    sessionStartedAt: z.number(),
    lastEventAt: z.number(),
    lastTimestampInjectedAt: z.number().optional(),
    afk: AfkSchema.optional(),
    keepalive: KeepaliveSchema.optional(),
    // Last time the Stop branch actually emitted a keepalive schedule directive.
    // Debounces re-emission so an ignored directive doesn't re-fire every turn.
    lastKeepaliveDirectiveAt: z.number().optional()
});

export type SessionEntry = z.infer<typeof SessionEntrySchema>;

const SessionStateSchema = z.record(z.string(), SessionEntrySchema);
type SessionState = z.infer<typeof SessionStateSchema>;

const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionStateFile(): string {
    return path.join(stateDir(), 'session-state.json');
}

function readState(): SessionState {
    try {
        const parsed = SessionStateSchema.safeParse(JSON.parse(fs.readFileSync(sessionStateFile(), 'utf8')));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

function writeState(state: SessionState, now: number): void {
    // Prune stale sessions on write to bound the file.
    for (const [sid, entry] of Object.entries(state)) {
        if (now - entry.lastEventAt > PRUNE_AFTER_MS) delete state[sid];
    }
    try {
        const d = stateDir();
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(sessionStateFile(), JSON.stringify(state));
    } catch {
        // Non-fatal; state just resets next call.
    }
}

/** Read a session's entry without mutating. */
export function getSessionEntry(sessionId: string): SessionEntry | undefined {
    return readState()[sessionId];
}

/**
 * Record an event for this session and return the entry as it was *before*
 * this event's lastEventAt was bumped (so callers can compute the idle gap),
 * plus the updated entry.
 */
export interface TouchResult {
    /** lastEventAt before this touch, or null if the session is new. */
    previousEventAt: number | null;
    entry: SessionEntry;
}

export function touchSession(sessionId: string, now: number): TouchResult {
    const state = readState();
    const existing = state[sessionId];
    const previousEventAt = existing ? existing.lastEventAt : null;
    const entry: SessionEntry = existing
        ? { ...existing, lastEventAt: now }
        : { sessionStartedAt: now, lastEventAt: now };
    state[sessionId] = entry;
    writeState(state, now);
    return { previousEventAt, entry };
}

/** Merge fields into a session entry and persist. Creates the entry if absent. */
export function updateSession(sessionId: string, now: number, patch: Partial<SessionEntry>): SessionEntry {
    const state = readState();
    const existing = state[sessionId] ?? { sessionStartedAt: now, lastEventAt: now };
    const entry: SessionEntry = { ...existing, ...patch };
    state[sessionId] = entry;
    writeState(state, now);
    return entry;
}
