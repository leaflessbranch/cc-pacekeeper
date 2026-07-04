import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KEEPALIVE_MARKER, keepaliveDirective, onUsageCredits, scanKeepaliveState } from '../keepalive';
import { DEFAULT_CONFIG } from '../config';
import type { Snapshot } from '../thresholds';

let TMP = '';
beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-test-')); });
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

function transcript(entries: unknown[]): string {
    const p = path.join(TMP, 't.jsonl');
    fs.writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    return p;
}

const cronCreate = (id: string, marker: boolean, ts: string): unknown => ({
    type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', name: 'CronCreate', input: { id, prompt: (marker ? KEEPALIVE_MARKER + ' ' : '') + 'do a tiny turn' } }] }
});
const cronDelete = (id: string, ts: string): unknown => ({
    type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', name: 'CronDelete', input: { id } }] }
});

describe('scanKeepaliveState', () => {
    test('finds newest marker CronCreate as pending', () => {
        const p = transcript([cronCreate('task-1', true, '2026-07-04T10:00:00Z')]);
        expect(scanKeepaliveState(p).pendingTaskId).toBe('task-1');
    });

    test('a later CronDelete clears pending', () => {
        const p = transcript([
            cronCreate('task-1', true, '2026-07-04T10:00:00Z'),
            cronDelete('task-1', '2026-07-04T10:05:00Z')
        ]);
        expect(scanKeepaliveState(p).pendingTaskId).toBeUndefined();
    });

    test('ignores non-marker CronCreate', () => {
        const p = transcript([cronCreate('other', false, '2026-07-04T10:00:00Z')]);
        expect(scanKeepaliveState(p)).toEqual({});
    });

    test('missing transcript → empty', () => {
        expect(scanKeepaliveState(path.join(TMP, 'nope.jsonl'))).toEqual({});
    });
});

function snapWith(readings: Snapshot['readings'], extra?: Snapshot['extraUsage']): Snapshot {
    return { readings, maxLevel: 'none', extraUsage: extra };
}

describe('onUsageCredits', () => {
    test('true when extra enabled and a plan meter maxed', () => {
        const s = snapWith([{ meter: 'five_hour', percent: 100, level: 'critical' }], { enabled: true });
        expect(onUsageCredits(s)).toBe(true);
    });
    test('false when extra disabled', () => {
        const s = snapWith([{ meter: 'five_hour', percent: 100, level: 'critical' }], { enabled: false });
        expect(onUsageCredits(s)).toBe(false);
    });
    test('false when no meter maxed', () => {
        const s = snapWith([{ meter: 'five_hour', percent: 80, level: 'warn' }], { enabled: true });
        expect(onUsageCredits(s)).toBe(false);
    });
});

describe('keepaliveDirective', () => {
    const base = snapWith([{ meter: 'five_hour', percent: 40, level: 'none' }]);

    test('active user with pending task → cancel', () => {
        const d = keepaliveDirective({ cfg: DEFAULT_CONFIG, snap: base, state: { pendingTaskId: 'x' }, userIsIdle: false, nowMs: 0 });
        expect(d.directive).toContain('CronDelete');
        expect(d.directive).toContain('x');
    });

    test('active user no pending → nothing', () => {
        const d = keepaliveDirective({ cfg: DEFAULT_CONFIG, snap: base, state: {}, userIsIdle: false, nowMs: 0 });
        expect(d.directive).toBeNull();
    });

    test('idle no pending → schedule', () => {
        const d = keepaliveDirective({ cfg: DEFAULT_CONFIG, snap: base, state: {}, userIsIdle: true, nowMs: 0 });
        expect(d.directive).toContain('CronCreate');
        expect(d.directive).toContain(KEEPALIVE_MARKER);
    });

    test('idle with fresh pending → nothing', () => {
        const now = Date.parse('2026-07-04T10:00:00Z');
        const d = keepaliveDirective({
            cfg: DEFAULT_CONFIG, snap: base,
            state: { pendingTaskId: 'x', createdAt: '2026-07-04T09:58:00Z' },
            userIsIdle: true, nowMs: now
        });
        expect(d.directive).toBeNull();
    });

    test('disabled config → nothing', () => {
        const cfg = { ...DEFAULT_CONFIG, keepalive: { ...DEFAULT_CONFIG.keepalive, enabled: false } };
        const d = keepaliveDirective({ cfg, snap: base, state: { pendingTaskId: 'x' }, userIsIdle: false, nowMs: 0 });
        expect(d.directive).toBeNull();
    });

    test('on usage credits → nothing', () => {
        const credits = snapWith([{ meter: 'five_hour', percent: 100, level: 'critical' }], { enabled: true });
        const d = keepaliveDirective({ cfg: DEFAULT_CONFIG, snap: credits, state: {}, userIsIdle: true, nowMs: 0 });
        expect(d.directive).toBeNull();
    });
});
