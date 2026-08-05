import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { Config } from './config';

/**
 * Proactive presence detection. Today's AFK signal (`timeline.detectAfkReturn`)
 * is retroactive: it measures the gap between two hook events, so "the user is
 * away" is only knowable once they come back. This module probes the machine
 * directly so absence is observable while it is happening.
 *
 * Linux-first. Every probe is individually guarded and reports `unavailable`
 * rather than throwing, so a box without tmux/systemd/ssh simply detects less.
 * macOS support is deliberately deferred (no test environment) — the non-Linux
 * path degrades to the caller's own hook-gap signal.
 */

const CACHE_DIR = path.join(os.homedir(), '.cache', 'cc-pacekeeper');
const CACHE_FILE = path.join(CACHE_DIR, 'presence.json');
const STATE_FILE = path.join(CACHE_DIR, 'presence-state.json');
const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 1500;

export type ProbeState = 'active' | 'idle' | 'unavailable';

export type Signal = {
    name: string;
    state: ProbeState;
    /** Epoch ms of the most recent activity this probe observed. */
    lastActivityMs?: number;
    detail?: string;
};

export type PresenceState = 'online' | 'afk' | 'unknown';

export type Presence = {
    state: PresenceState;
    signals: Signal[];
    lastActivityMs: number | null;
};

const CachedPresenceSchema = z.object({
    checkedAt: z.number(),
    state: z.enum(['online', 'afk', 'unknown']),
    signals: z.array(z.object({
        name: z.string(),
        state: z.enum(['active', 'idle', 'unavailable']),
        lastActivityMs: z.number().optional(),
        detail: z.string().optional()
    })),
    lastActivityMs: z.number().nullable()
});

type CachedPresence = z.infer<typeof CachedPresenceSchema>;

/** Run a command, returning stdout, or null on any failure. Never throws. */
function run(cmd: string, args: string[]): string | null {
    try {
        return execFileSync(cmd, args, {
            encoding: 'utf8',
            timeout: PROBE_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch {
        return null;
    }
}

function unavailable(name: string, detail?: string): Signal {
    return { name, state: 'unavailable', detail };
}

/**
 * Classify a probe's observed activity timestamp against the idle threshold.
 * A probe that saw activity within the window is `active`; older is `idle`.
 */
function classify(name: string, lastActivityMs: number, nowMs: number, idleMs: number): Signal {
    const state: ProbeState = (nowMs - lastActivityMs) <= idleMs ? 'active' : 'idle';
    return { name, state, lastActivityMs };
}

/**
 * tmux clients. Presence requires an *attached* client with recent activity —
 * a detached session (laptop closed, session persists server-side) is not the
 * user being present, so it reports `idle` rather than `active`.
 */
export function probeTmux(nowMs: number, idleMs: number): Signal {
    const out = run('tmux', ['list-clients', '-F', '#{client_activity}']);
    if (out === null) return unavailable('tmux', 'tmux not running or not installed');
    if (out === '') return { name: 'tmux', state: 'idle', detail: 'no attached clients' };

    const stamps = out.split('\n')
        .map(line => Number(line.trim()))
        .filter(n => Number.isFinite(n) && n > 0);
    if (stamps.length === 0) return unavailable('tmux', 'unparseable client_activity');

    // tmux reports seconds; take the most recently active client.
    return classify('tmux', Math.max(...stamps) * 1000, nowMs, idleMs);
}

/**
 * Controlling terminal atime. Reading from a tty updates its access time, so
 * this catches a bare-SSH or local-console user who is typing outside tmux.
 */
export function probeTty(nowMs: number, idleMs: number, ttyPath?: string): Signal {
    const tty = ttyPath ?? run('tty', []);
    if (!tty || !tty.startsWith('/dev/')) return unavailable('tty', 'no controlling terminal');
    try {
        const st = fs.statSync(tty);
        return classify('tty', st.atimeMs, nowMs, idleMs);
    } catch {
        return unavailable('tty', `cannot stat ${tty}`);
    }
}

/**
 * Extract the ttys of genuinely *remote* logins from `who` output.
 *
 * `who` puts an origin in trailing parens, but only some of those are remote
 * hosts. Real output from a local box running tmux under X:
 *
 *   user  pts/0   ... (192.0.2.10)       ← remote, counts
 *   user  pts/1   ... (tmux(3816).%3)    ← a tmux pane, not a login
 *   user  seat0   ... (login screen)     ← local console
 *   user  :1      ... (:1)               ← X display
 *
 * Counting the last three as SSH would fabricate remote presence on a purely
 * local machine, so only a bare hostname or IP qualifies.
 */
export function parseWhoRemoteTtys(whoOutput: string): string[] {
    return whoOutput.split('\n')
        .map(line => {
            const m = /^\S+\s+(\S+)\s+.*\(([^)]+)\)\s*$/.exec(line);
            if (!m) return null;
            const [, tty, origin] = m;
            if (!tty || !origin) return null;
            if (origin.startsWith(':') || origin.includes('tmux') || origin.includes(' ')) return null;
            return tty;
        })
        .filter((t): t is string => t !== null);
}

/**
 * SSH logins, via `who`, whose idle column we derive from each login tty's
 * atime.
 *
 * The nesting rule matters here: a live SSH *connection* is the most tempting
 * signal and the one that lies, because the socket lingers for minutes after a
 * laptop closes. So mere connection existence never votes `active` — only
 * recent activity on the login's tty does. An SSH session with no recent
 * activity beneath it reports `idle`, contributing nothing toward `online`.
 */
export function probeSsh(nowMs: number, idleMs: number): Signal {
    const out = run('who', []);
    if (out === null) return unavailable('ssh', 'who unavailable');

    const remoteTtys = parseWhoRemoteTtys(out);

    if (remoteTtys.length === 0) return { name: 'ssh', state: 'idle', detail: 'no remote logins' };

    let newest = 0;
    for (const t of remoteTtys) {
        try {
            newest = Math.max(newest, fs.statSync(path.join('/dev', t)).atimeMs);
        } catch {
            // Unreadable tty contributes nothing.
        }
    }
    if (newest === 0) {
        return { name: 'ssh', state: 'idle', detail: `${remoteTtys.length} login(s), no readable tty` };
    }
    return classify('ssh', newest, nowMs, idleMs);
}

/** systemd-logind idle hint for the current session. */
export function probeLoginctl(nowMs: number, idleMs: number): Signal {
    const out = run('loginctl', ['show-session', 'self', '-p', 'IdleHint', '-p', 'IdleSinceHint']);
    if (out === null) return unavailable('loginctl', 'logind unavailable');

    const fields = new Map<string, string>();
    for (const line of out.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
    }

    const hint = fields.get('IdleHint');
    if (hint === undefined) return unavailable('loginctl', 'no IdleHint');
    if (hint === 'no') return { name: 'loginctl', state: 'active', lastActivityMs: nowMs };

    // IdleSinceHint is microseconds since epoch; 0 means "unset".
    const since = Number(fields.get('IdleSinceHint') ?? 0);
    if (Number.isFinite(since) && since > 0) {
        return classify('loginctl', since / 1000, nowMs, idleMs);
    }
    return { name: 'loginctl', state: 'idle' };
}

/**
 * Fuse probe results into a single verdict.
 *
 * The ladder is deliberately asymmetric: an *unavailable* probe never votes
 * `afk`. Degradation has to fail toward "assume present", because a false `afk`
 * reroutes output away from a user who is sitting right there watching — a far
 * worse outcome than a missed notification.
 *
 * 1. A hook event in this session within the window → `online`. The user
 *    demonstrably typed *here*, which outranks every machine-level signal.
 * 2. Any probe reporting recent activity → `online`.
 * 3. No probe available at all → `unknown`.
 * 4. Every available probe idle → `afk`.
 */
export function fuse(signals: Signal[], hookGapMs: number | null, idleMs: number): Presence {
    const lastActivityMs = signals.reduce<number | null>((acc, s) => {
        if (s.lastActivityMs === undefined) return acc;
        return acc === null ? s.lastActivityMs : Math.max(acc, s.lastActivityMs);
    }, null);

    if (hookGapMs !== null && hookGapMs <= idleMs) {
        return { state: 'online', signals, lastActivityMs };
    }
    if (signals.some(s => s.state === 'active')) {
        return { state: 'online', signals, lastActivityMs };
    }
    if (signals.every(s => s.state === 'unavailable')) {
        return { state: 'unknown', signals, lastActivityMs };
    }
    return { state: 'afk', signals, lastActivityMs };
}

function readCache(): CachedPresence | null {
    try {
        const parsed = CachedPresenceSchema.safeParse(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function writeCache(entry: CachedPresence): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(entry));
    } catch {
        // Best-effort.
    }
}

/**
 * Run every enabled probe. Exported for the doctor check, which wants the raw
 * per-probe availability regardless of caching.
 */
export function probeAll(cfg: Config, nowMs: number): Signal[] {
    const idleMs = cfg.presence.idle_minutes * 60_000;
    const enabled = cfg.presence.probes;
    const signals: Signal[] = [];

    // Non-Linux has none of these; skip rather than shelling out pointlessly.
    if (process.platform !== 'linux') {
        return [unavailable('platform', `${process.platform}: probes are Linux-only`)];
    }

    if (enabled.tmux) signals.push(probeTmux(nowMs, idleMs));
    if (enabled.tty) signals.push(probeTty(nowMs, idleMs));
    if (enabled.ssh) signals.push(probeSsh(nowMs, idleMs));
    if (enabled.loginctl) signals.push(probeLoginctl(nowMs, idleMs));

    return signals;
}

/**
 * Whether the last observed transition was into `afk`.
 *
 * A plain file read, deliberately: this is called from the Stop hook, which is
 * on the hot path, and the monitor has already done the probing. Absent or
 * unreadable state means "not known to be away" — the same fail-toward-present
 * bias as the fusion ladder, since a wrong `true` reroutes output away from a
 * user who is sitting right there.
 */
export function isAway(): boolean {
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { state?: string };
        return raw.state === 'afk';
    } catch {
        return false;
    }
}

/**
 * True only when presence is explicitly `online`. Deliberately NOT `!isAway()`:
 * an `unknown` or unreadable state must not count as "returned", or it would
 * prematurely clear the away-routing episode marker while the user is still
 * gone. Same fail-toward-caution bias as the fusion ladder.
 */
export function isOnline(): boolean {
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { state?: string };
        return raw.state === 'online';
    } catch {
        return false;
    }
}

/**
 * Path to the cross-session transition record. The monitor
 * (`presence-watch.ts`) uses it to decide whether *it* is the watcher that
 * announces a given transition — presence is a property of the machine, so N
 * open sessions must not produce N notifications for one departure.
 */
export function presenceStateFile(): string {
    return STATE_FILE;
}

/**
 * Cached presence read. `hookGapMs` is the caller's own measure of time since
 * the last hook event in this session (null if unknown) — it is applied fresh
 * on every call, never cached, since it is free to compute and is the highest
 * rung of the ladder.
 */
export function getPresence(cfg: Config, nowMs: number, hookGapMs: number | null): Presence {
    const idleMs = cfg.presence.idle_minutes * 60_000;

    const cached = readCache();
    if (cached && (nowMs - cached.checkedAt) < CACHE_TTL_MS) {
        return fuse(cached.signals, hookGapMs, idleMs);
    }

    const signals = probeAll(cfg, nowMs);
    const presence = fuse(signals, hookGapMs, idleMs);
    writeCache({
        checkedAt: nowMs,
        state: presence.state,
        signals: presence.signals,
        lastActivityMs: presence.lastActivityMs
    });
    return presence;
}
