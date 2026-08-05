import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_CONFIG, type Config } from '../config';
import { computeSnapshot } from '../thresholds';
import { coveredLevel, reminderMetersToFire } from '../tick';
import { saveCheckpoint } from '../checkpoint';
import type { SessionEntry } from '../session-state';

/**
 * Unit-level coverage of the once-per-level gate, isolated from applyDebounce
 * and the tick binary. Drives coveredLevel/reminderMetersToFire directly.
 */

let CWD = '';
beforeEach(() => { CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-unit-')); });
afterEach(() => { try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* ignore */ } });

const cfg: Config = { ...DEFAULT_CONFIG };

function weeklySnap(pct: number, resetInMs = 3 * 24 * 3600_000) {
    return computeSnapshot(
        { contextPercent: 10, usage: { sessionUsage: 10, weeklyUsage: pct, weeklyResetAt: new Date(Date.now() + resetInMs).toISOString() } },
        cfg
    );
}

function weeklyReading(snap: ReturnType<typeof computeSnapshot>) {
    const r = snap.readings.find(x => x.meter === 'weekly');
    if (!r) throw new Error('no weekly reading');
    return r;
}

function keyFor(reading: { resetsAt?: string }): string {
    const t = Date.parse(reading.resetsAt!);
    return String(Math.floor(t / 60_000));
}

describe('coveredLevel', () => {
    test('none when nothing covers it', () => {
        const snap = weeklySnap(72);
        const r = weeklyReading(snap);
        expect(coveredLevel(undefined, r, keyFor(r), CWD, cfg)).toBe('none');
    });

    test('reminderCoverage marker covers its level within the same window', () => {
        const snap = weeklySnap(72);
        const r = weeklyReading(snap);
        const entry: SessionEntry = {
            sessionStartedAt: 0, lastEventAt: 0,
            reminderCoverage: { weekly: { level: 'warn', resetKey: keyFor(r) } }
        };
        expect(coveredLevel(entry, r, keyFor(r), CWD, cfg)).toBe('warn');
    });

    test('marker from a different window does not cover', () => {
        const snap = weeklySnap(72);
        const r = weeklyReading(snap);
        const entry: SessionEntry = {
            sessionStartedAt: 0, lastEventAt: 0,
            reminderCoverage: { weekly: { level: 'critical', resetKey: 'some-other-key' } }
        };
        expect(coveredLevel(entry, r, keyFor(r), CWD, cfg)).toBe('none');
    });

    test('a this-window checkpoint covers the level it was saved at', () => {
        const snap = weeklySnap(72);
        const r = weeklyReading(snap);
        saveCheckpoint({
            cwd: CWD, checkpointDirName: '.claude-checkpoints',
            frontmatter: { name: 'l', meters: { weekly_pct: 72, weekly_resets_at: r.resetsAt } },
            body: 'x'
        });
        expect(coveredLevel(undefined, r, keyFor(r), CWD, cfg)).toBe('warn');
    });

    test('a warn-band checkpoint does not cover a critical reading', () => {
        const critSnap = weeklySnap(88);
        const critR = weeklyReading(critSnap);
        saveCheckpoint({
            cwd: CWD, checkpointDirName: '.claude-checkpoints',
            frontmatter: { name: 'l', meters: { weekly_pct: 72, weekly_resets_at: critR.resetsAt } },
            body: 'x'
        });
        expect(coveredLevel(undefined, critR, keyFor(critR), CWD, cfg)).toBe('warn');
        // covered is warn < current critical → still warrants a reminder.
    });
});

describe('reminderMetersToFire', () => {
    test('fires weekly at warn when uncovered', () => {
        const snap = weeklySnap(72);
        const fire = reminderMetersToFire(undefined, snap, CWD, cfg);
        expect(fire.map(r => r.meter)).toContain('weekly');
    });

    test('silent when the marker already covers the level', () => {
        const snap = weeklySnap(72);
        const r = weeklyReading(snap);
        const entry: SessionEntry = {
            sessionStartedAt: 0, lastEventAt: 0,
            reminderCoverage: { weekly: { level: 'warn', resetKey: keyFor(r) } }
        };
        expect(reminderMetersToFire(entry, snap, CWD, cfg)).toHaveLength(0);
    });

    test('re-arms in a new window even at a lower level than before', () => {
        // Window 1 covered at critical; window 2 (different reset) at warn.
        const w2 = weeklySnap(72, 6 * 24 * 3600_000);
        const r2 = weeklyReading(w2);
        const entry: SessionEntry = {
            sessionStartedAt: 0, lastEventAt: 0,
            reminderCoverage: { weekly: { level: 'critical', resetKey: 'window-1-key' } }
        };
        // Different resetKey → the critical marker doesn't apply → warn fires.
        expect(reminderMetersToFire(entry, w2, CWD, cfg).map(r => r.meter)).toContain('weekly');
        expect(keyFor(r2)).not.toBe('window-1-key');
    });

    test('ignores stale readings', () => {
        // Reset in the past → five_hour reading is stale, level none.
        const snap = computeSnapshot(
            { contextPercent: 10, usage: { sessionUsage: 94, sessionResetAt: new Date(Date.now() - 60_000).toISOString(), weeklyUsage: 10 } },
            cfg
        );
        expect(reminderMetersToFire(undefined, snap, CWD, cfg)).toHaveLength(0);
    });
});
