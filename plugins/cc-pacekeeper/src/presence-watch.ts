#!/usr/bin/env bun
import * as fs from 'fs';
import * as path from 'path';
import { bootstrapConfigIfMissing, loadConfig } from './config';
import { recordCrash } from './crash-log';
import { fuse, presenceStateFile, probeAll, type PresenceState } from './presence';

/**
 * Presence monitor. Declared as a plugin monitor (see monitors/monitors.json),
 * so Claude Code starts it automatically for the session's lifetime; every line
 * printed here is delivered to Claude as a notification.
 *
 * This exists because hook events only fire while a session is doing something.
 * The moment the user walks away, hooks stop — so a hook can never observe a
 * *departure*, only infer one retroactively once the user returns. A monitor
 * polls independently and closes that gap.
 *
 * Output is deliberately sparse: one line per genuine state transition, never a
 * heartbeat. Each line costs Claude a turn, and this plugin exists to conserve
 * quota, so a chatty monitor would undercut its own purpose.
 */

const POLL_MS = 20_000;

/**
 * Cross-session transition claim.
 *
 * Presence is a property of the machine, not of a session: one AFK signal is
 * confirmed absence, and a second observer adds nothing. But Claude Code runs
 * one monitor per session, so N open sessions means N watchers seeing the same
 * departure — and, without coordination, N notifications for one event.
 *
 * The shared state file is the arbiter. A watcher announces a transition only
 * if it is the one that recorded it; the losers of the race stay silent. This
 * is a lock-free compare-and-set: the write is small enough to be atomic in
 * practice, and a lost race costs a duplicate line, not corruption.
 */
function claimTransition(state: PresenceState, nowMs: number): boolean {
    const file = presenceStateFile();
    try {
        const prev = JSON.parse(fs.readFileSync(file, 'utf8')) as { state?: string };
        if (prev.state === state) return false;   // already announced by someone
    } catch {
        // No file yet, or unreadable — treat as first observation.
    }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ state, at: new Date(nowMs).toISOString() }));
        return true;
    } catch {
        return false;   // can't record it, so don't announce it
    }
}

async function main(): Promise<void> {
    bootstrapConfigIfMissing();

    if (!loadConfig().presence.enabled) return;   // exit quietly; nothing to watch

    // Seed from the shared file so a session opening while the user is already
    // away doesn't announce a transition that another watcher reported earlier.
    let last: PresenceState | null = null;
    try {
        const seeded = JSON.parse(fs.readFileSync(presenceStateFile(), 'utf8')) as { state?: PresenceState };
        if (seeded.state) last = seeded.state;
    } catch { /* first run */ }

    for (;;) {
        // Re-read config each cycle so toggling `enabled` takes effect without
        // restarting the session that owns this process.
        const cfg = loadConfig();
        if (!cfg.presence.enabled) return;

        const now = Date.now();
        const signals = probeAll(cfg, now);
        const presence = fuse(signals, null, cfg.presence.idle_minutes * 60_000);

        // `unknown` means no probe could report — absence of information, not
        // information about absence. Announcing it would be noise.
        if (presence.state !== 'unknown' && presence.state !== last) {
            if (claimTransition(presence.state, now)) {
                const detail = signals.map(s => `${s.name}:${s.state}`).join(' ');
                console.log(`[pacekeeper-presence] ${presence.state} — ${detail}`);
            }
            last = presence.state;
        }

        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

main().catch(err => {
    // A dead monitor is silent, and silence is indistinguishable from "the user
    // is present" — so leave a breadcrumb rather than vanishing. `doctor`
    // surfaces this.
    recordCrash('presence-watch', err);
});
