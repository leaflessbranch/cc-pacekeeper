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

// CronCreate's input has NO id; the id comes back in the tool_result. We model
// both the assistant tool_use (with a tool_use id) and the user tool_result.
const cronCreate = (toolUseId: string, marker: boolean, ts: string): unknown => ({
    type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'CronCreate', input: { cron: '7 * * * *', recurring: false, prompt: (marker ? KEEPALIVE_MARKER + ' ' : '') + 'do a tiny turn' } }] }
});
const createResult = (toolUseId: string, jobId: string): unknown => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Scheduled job ${jobId}, fires at :07.` }] }
});
const cronDelete = (jobId: string, ts: string): unknown => ({
    type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', id: 'del-1', name: 'CronDelete', input: { id: jobId } }] }
});

describe('scanKeepaliveState', () => {
    test('finds newest marker CronCreate as pending, recovers job id from result', () => {
        const p = transcript([
            cronCreate('tu-1', true, '2026-07-04T10:00:00Z'),
            createResult('tu-1', 'abc12345')
        ]);
        const s = scanKeepaliveState(p);
        expect(s.hasPending).toBe(true);
        expect(s.pendingTaskId).toBe('abc12345');
    });

    test('pending true even when job id not recoverable', () => {
        const p = transcript([cronCreate('tu-1', true, '2026-07-04T10:00:00Z')]);
        const s = scanKeepaliveState(p);
        expect(s.hasPending).toBe(true);
        expect(s.pendingTaskId).toBeUndefined();
    });

    test('a later CronDelete of the recovered id clears pending', () => {
        const p = transcript([
            cronCreate('tu-1', true, '2026-07-04T10:00:00Z'),
            createResult('tu-1', 'abc12345'),
            cronDelete('abc12345', '2026-07-04T10:05:00Z')
        ]);
        expect(scanKeepaliveState(p).hasPending).toBe(false);
    });

    test('ignores non-marker CronCreate', () => {
        const p = transcript([cronCreate('tu-1', false, '2026-07-04T10:00:00Z')]);
        expect(scanKeepaliveState(p).hasPending).toBe(false);
    });

    test('missing transcript → not pending', () => {
        expect(scanKeepaliveState(path.join(TMP, 'nope.jsonl')).hasPending).toBe(false);
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

    // The directive ensures a keepalive chain exists (schedule once, idempotent).
    // It never cancels — the chain self-terminates at ping-fire time. So the only
    // outputs are "schedule" or null.

    test('no pending → schedule directive', () => {
        const d = keepaliveDirective({ cfg: DEFAULT_CONFIG, snap: base, state: { hasPending: false }, nowMs: 0 });
        expect(d.directive).toContain('CronCreate');
        expect(d.directive).toContain(KEEPALIVE_MARKER);
    });

    test('fresh pending → nothing (idempotent)', () => {
        const now = Date.parse('2026-07-04T10:00:00Z');
        // interval_min=30 default → freshness window 35m. Created 2m ago → fresh.
        const d = keepaliveDirective({
            cfg: DEFAULT_CONFIG, snap: base,
            state: { hasPending: true, pendingTaskId: 'abc12345', createdAt: '2026-07-04T09:58:00Z' },
            nowMs: now
        });
        expect(d.directive).toBeNull();
    });

    test('stale pending (older than interval+5m) → re-schedule', () => {
        const now = Date.parse('2026-07-04T10:00:00Z');
        // 40m old > 35m window → stale → re-emit.
        const d = keepaliveDirective({
            cfg: DEFAULT_CONFIG, snap: base,
            state: { hasPending: true, pendingTaskId: 'abc12345', createdAt: '2026-07-04T09:20:00Z' },
            nowMs: now
        });
        expect(d.directive).toContain('CronCreate');
    });

    test('pending with unrecoverable id → treated as fresh (fail quiet)', () => {
        const now = Date.parse('2026-07-04T10:00:00Z');
        // hasPending but no createdAt/id: do NOT re-emit forever.
        const d = keepaliveDirective({
            cfg: DEFAULT_CONFIG, snap: base,
            state: { hasPending: true },
            nowMs: now
        });
        expect(d.directive).toBeNull();
    });

    test('never emits a cancel directive', () => {
        const d = keepaliveDirective({ cfg: DEFAULT_CONFIG, snap: base, state: { hasPending: true, pendingTaskId: 'abc12345', createdAt: new Date().toISOString() }, nowMs: Date.now() });
        // fresh → null; and even when it does emit, it's a schedule, never a delete.
        if (d.directive) expect(d.directive).not.toContain('CronDelete');
    });

    test('disabled config → nothing', () => {
        const cfg = { ...DEFAULT_CONFIG, keepalive: { ...DEFAULT_CONFIG.keepalive, enabled: false } };
        const d = keepaliveDirective({ cfg, snap: base, state: { hasPending: false }, nowMs: 0 });
        expect(d.directive).toBeNull();
    });

    test('on usage credits → nothing', () => {
        const credits = snapWith([{ meter: 'five_hour', percent: 100, level: 'critical' }], { enabled: true });
        const d = keepaliveDirective({ cfg: DEFAULT_CONFIG, snap: credits, state: { hasPending: false }, nowMs: 0 });
        expect(d.directive).toBeNull();
    });
});
