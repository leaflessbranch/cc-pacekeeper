import type { Config } from './config';
import type { SessionEntry } from './session-state';

/**
 * Pure time-formatting helpers for the pacekeeper status line. No I/O — callers
 * pass in the session entry and the current time.
 */

function formatDuration(ms: number): string {
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 1) return '<1m';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m}m`;
    return `${h}h${m.toString().padStart(2, '0')}m`;
}

/**
 * `Fri 2026-07-04 18:42 IST · session 2h13m[ · idle 47m]`.
 * Local wall-clock via Intl; session duration from sessionStartedAt; idle
 * segment appended only when the gap since lastEventAt exceeds the threshold.
 */
export function formatTimeSegment(now: number, entry: SessionEntry, cfg: Config): string {
    const d = new Date(now);
    const parts = new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZoneName: 'short'
    }).formatToParts(d);
    const pick = (t: string): string => parts.find(p => p.type === t)?.value ?? '';
    const wall = `${pick('weekday')} ${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')} ${pick('timeZoneName')}`;

    const segments = [wall, `session ${formatDuration(now - entry.sessionStartedAt)}`];

    const idleMs = now - entry.lastEventAt;
    if (idleMs >= cfg.time.idle_threshold_min * 60000) {
        segments.push(`idle ${formatDuration(idleMs)}`);
    }
    return segments.join(' · ');
}

/**
 * One-shot AFK-return line, e.g. `⏱ You were away 3h12m — welcome back.`
 * Returns null when the gap is below threshold. `gapMs` is the measured idle
 * gap for this event (previousEventAt → now).
 */
export function detectAfkReturn(gapMs: number, cfg: Config): string | null {
    if (gapMs < cfg.time.idle_threshold_min * 60000) return null;
    return `⏱ You were away ${formatDuration(gapMs)} — welcome back.`;
}
