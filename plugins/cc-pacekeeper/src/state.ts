import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

export type Meter = 'context' | 'five_hour' | 'weekly' | 'weekly_sonnet' | 'weekly_opus';
export type Level = 'none' | 'notify' | 'warn' | 'critical';

const LEVEL_ORDER: Record<Level, number> = { none: 0, notify: 1, warn: 2, critical: 3 };

export function levelGte(a: Level, b: Level): boolean {
    return LEVEL_ORDER[a] >= LEVEL_ORDER[b];
}

export function levelGt(a: Level, b: Level): boolean {
    return LEVEL_ORDER[a] > LEVEL_ORDER[b];
}

/**
 * Composite key for per-session-or-agent state: `sid` for the main thread,
 * `sid:agentId` for a subagent. All hook state was previously keyed by
 * session_id alone, shared by main + every subagent under it — the main
 * thread's ticks starved subagent injections since they shared one debounce
 * entry. Keys are opaque to callers (state.ts, session-state.ts); the existing
 * 7-day prune in session-state.ts bounds agent entries same as session ones.
 */
export function stateKey(sessionId: string, agentId?: string): string {
    return agentId ? `${sessionId}:${agentId}` : sessionId;
}

const MeterStateSchema = z.object({
    lastLevel: z.enum(['none', 'notify', 'warn', 'critical']),
    lastInjectedAt: z.number()
});

const DebounceStateSchema = z.record(
    z.string(),                     // session_id
    z.record(z.string(), MeterStateSchema)  // meter -> state
);

type DebounceState = z.infer<typeof DebounceStateSchema>;

function home(): string {
    return process.env.HOME ?? os.homedir();
}

export function stateDir(): string {
    return path.join(home(), '.cache', 'cc-pacekeeper');
}

export function debounceFile(): string {
    return path.join(stateDir(), 'debounce.json');
}

function ensureStateDir(): void {
    const d = stateDir();
    if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
    }
}

function readDebounceState(): DebounceState {
    try {
        const parsed = DebounceStateSchema.safeParse(JSON.parse(fs.readFileSync(debounceFile(), 'utf8')));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

function writeDebounceState(state: DebounceState): void {
    try {
        ensureStateDir();
        fs.writeFileSync(debounceFile(), JSON.stringify(state));
    } catch {
        // Non-fatal; debounce just resets next call.
    }
}

export interface DebounceDecision {
    shouldInject: boolean;
    isTransitionUp: boolean;
    previousLevel: Level;
}

/**
 * Decide whether to inject for a given (session, meter) at the current level,
 * and update on-disk state if the answer is yes.
 *
 * Rule: inject when the level strictly increases (transition up),
 *       OR when the same non-none level persists past `debounce_seconds`.
 *       `none` always = no injection.
 */
export function shouldInjectAndRecord(
    sessionId: string,
    meter: Meter,
    currentLevel: Level,
    nowSeconds: number,
    debounceSeconds: number
): DebounceDecision {
    const all = readDebounceState();
    const session = all[sessionId] ?? {};
    const meterEntry = session[meter];
    const previousLevel: Level = (meterEntry?.lastLevel ?? 'none') as Level;
    const previousAt = meterEntry?.lastInjectedAt ?? 0;

    if (currentLevel === 'none') {
        // Reset to none without firing.
        if (previousLevel !== 'none') {
            session[meter] = { lastLevel: 'none', lastInjectedAt: nowSeconds };
            all[sessionId] = session;
            writeDebounceState(all);
        }
        return { shouldInject: false, isTransitionUp: false, previousLevel };
    }

    const isTransitionUp = levelGt(currentLevel, previousLevel);
    const sameLevelDebounced = currentLevel === previousLevel && (nowSeconds - previousAt) > debounceSeconds;
    const shouldInject = isTransitionUp || sameLevelDebounced;

    if (shouldInject) {
        session[meter] = { lastLevel: currentLevel, lastInjectedAt: nowSeconds };
        all[sessionId] = session;
        writeDebounceState(all);
    } else if (currentLevel !== previousLevel) {
        // Transition down: record the new (lower) level so the next up-transition
        // is detected correctly, but don't inject.
        session[meter] = { lastLevel: currentLevel, lastInjectedAt: previousAt };
        all[sessionId] = session;
        writeDebounceState(all);
    }

    return { shouldInject, isTransitionUp, previousLevel };
}

/** Peek without modifying state. Used by Stop hook to know if anything escalated this turn. */
export function peekLevel(sessionId: string, meter: Meter): Level {
    const all = readDebounceState();
    return (all[sessionId]?.[meter]?.lastLevel ?? 'none') as Level;
}
