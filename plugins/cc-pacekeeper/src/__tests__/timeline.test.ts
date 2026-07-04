import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../config';
import { detectAfkReturn, formatTimeSegment } from '../timeline';
import type { SessionEntry } from '../session-state';

const cfg = DEFAULT_CONFIG; // idle_threshold_min: 10

describe('formatTimeSegment', () => {
    test('includes wall clock and session duration, no idle when fresh', () => {
        const now = Date.UTC(2026, 6, 4, 12, 0, 0);
        const entry: SessionEntry = { sessionStartedAt: now - 2 * 3600_000 - 13 * 60_000, lastEventAt: now };
        const s = formatTimeSegment(now, entry, cfg);
        expect(s).toContain('session 2h13m');
        expect(s).not.toContain('idle');
        expect(s).toContain('2026-07-04');
    });

    test('appends idle segment past threshold', () => {
        const now = Date.UTC(2026, 6, 4, 12, 0, 0);
        const entry: SessionEntry = { sessionStartedAt: now - 3600_000, lastEventAt: now - 47 * 60_000 };
        const s = formatTimeSegment(now, entry, cfg);
        expect(s).toContain('idle 47m');
    });

    test('no idle segment just under threshold', () => {
        const now = Date.UTC(2026, 6, 4, 12, 0, 0);
        const entry: SessionEntry = { sessionStartedAt: now - 3600_000, lastEventAt: now - 9 * 60_000 };
        expect(formatTimeSegment(now, entry, cfg)).not.toContain('idle');
    });
});

describe('detectAfkReturn', () => {
    test('null below threshold', () => {
        expect(detectAfkReturn(5 * 60_000, cfg)).toBeNull();
    });
    test('formats gap above threshold', () => {
        const line = detectAfkReturn(3 * 3600_000 + 12 * 60_000, cfg);
        expect(line).toContain('3h12m');
        expect(line).toContain('away');
    });
});
