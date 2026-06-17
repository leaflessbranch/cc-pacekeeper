import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// We override HOME so state.ts writes its debounce.json into a sandbox.
let TMP_HOME = '';
const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
    TMP_HOME = path.join(os.tmpdir(), `cc-pacekeeper-state-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(TMP_HOME, { recursive: true });
    process.env.HOME = TMP_HOME;
    // bust module cache so state.ts re-resolves STATE_DIR
    delete require.cache[require.resolve('../state')];
});

afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

let counter = 0;
const newSid = (): string => `sess-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

describe('shouldInjectAndRecord', () => {
    test('first-time at notify: transition up, fires', async () => {
        const { shouldInjectAndRecord } = await import('../state');
        const s = newSid();
        const d = shouldInjectAndRecord(s, 'context', 'notify', 1000, 60);
        expect(d.shouldInject).toBe(true);
        expect(d.isTransitionUp).toBe(true);
        expect(d.previousLevel).toBe('none');
    });

    test('same level within debounce: no inject', async () => {
        const { shouldInjectAndRecord } = await import('../state');
        const s = newSid();
        shouldInjectAndRecord(s, 'context', 'notify', 1000, 60);
        const d = shouldInjectAndRecord(s, 'context', 'notify', 1030, 60);
        expect(d.shouldInject).toBe(false);
    });

    test('same level past debounce: fires again', async () => {
        const { shouldInjectAndRecord } = await import('../state');
        const s = newSid();
        shouldInjectAndRecord(s, 'context', 'notify', 1000, 60);
        const d = shouldInjectAndRecord(s, 'context', 'notify', 1100, 60);
        expect(d.shouldInject).toBe(true);
    });

    test('escalate notify → warn: fires immediately', async () => {
        const { shouldInjectAndRecord } = await import('../state');
        const s = newSid();
        shouldInjectAndRecord(s, 'context', 'notify', 1000, 60);
        const d = shouldInjectAndRecord(s, 'context', 'warn', 1005, 60);
        expect(d.shouldInject).toBe(true);
        expect(d.isTransitionUp).toBe(true);
    });

    test('de-escalate warn → notify: silent but recorded', async () => {
        const { shouldInjectAndRecord, peekLevel } = await import('../state');
        const s = newSid();
        shouldInjectAndRecord(s, 'context', 'warn', 1000, 60);
        const d = shouldInjectAndRecord(s, 'context', 'notify', 1010, 60);
        expect(d.shouldInject).toBe(false);
        expect(peekLevel(s, 'context')).toBe('notify');
    });

    test('drop to none: silent and resets', async () => {
        const { shouldInjectAndRecord, peekLevel } = await import('../state');
        const s = newSid();
        shouldInjectAndRecord(s, 'context', 'warn', 1000, 60);
        const d = shouldInjectAndRecord(s, 'context', 'none', 1010, 60);
        expect(d.shouldInject).toBe(false);
        expect(peekLevel(s, 'context')).toBe('none');
    });

    test('independent per (session, meter)', async () => {
        const { shouldInjectAndRecord } = await import('../state');
        const s1 = newSid();
        const s2 = newSid();
        shouldInjectAndRecord(s1, 'context', 'warn', 1000, 60);
        const d = shouldInjectAndRecord(s2, 'context', 'warn', 1000, 60);
        expect(d.shouldInject).toBe(true);
        expect(d.previousLevel).toBe('none');

        const d2 = shouldInjectAndRecord(s1, 'five_hour', 'warn', 1000, 60);
        expect(d2.shouldInject).toBe(true);
        expect(d2.previousLevel).toBe('none');
    });
});
