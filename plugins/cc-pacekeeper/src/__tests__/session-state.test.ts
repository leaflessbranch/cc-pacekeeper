import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let TMP_HOME = '';
const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
    TMP_HOME = path.join(os.tmpdir(), `cc-pacekeeper-sstate-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(TMP_HOME, { recursive: true });
    process.env.HOME = TMP_HOME;
    delete require.cache[require.resolve('../state')];
    delete require.cache[require.resolve('../session-state')];
});

afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('touchSession', () => {
    test('new session: previousEventAt null, start == now', async () => {
        const { touchSession } = await import('../session-state');
        const r = touchSession('s1', 1000);
        expect(r.previousEventAt).toBeNull();
        expect(r.entry.sessionStartedAt).toBe(1000);
        expect(r.entry.lastEventAt).toBe(1000);
    });

    test('second touch: previousEventAt is prior lastEventAt, start preserved', async () => {
        const { touchSession } = await import('../session-state');
        touchSession('s1', 1000);
        const r = touchSession('s1', 5000);
        expect(r.previousEventAt).toBe(1000);
        expect(r.entry.sessionStartedAt).toBe(1000);
        expect(r.entry.lastEventAt).toBe(5000);
    });
});

describe('updateSession', () => {
    test('merges patch and persists', async () => {
        const { touchSession, updateSession, getSessionEntry } = await import('../session-state');
        touchSession('s1', 1000);
        updateSession('s1', 2000, { lastTimestampInjectedAt: 2000 });
        expect(getSessionEntry('s1')?.lastTimestampInjectedAt).toBe(2000);
        expect(getSessionEntry('s1')?.sessionStartedAt).toBe(1000);
    });
});

describe('pruning', () => {
    test('drops sessions older than 7 days on write', async () => {
        const { touchSession, updateSession, getSessionEntry } = await import('../session-state');
        const old = 1_000_000;
        touchSession('old', old);
        // A fresh write far in the future prunes the stale 'old' entry.
        const now = old + 8 * 24 * 3600_000;
        updateSession('fresh', now, {});
        expect(getSessionEntry('old')).toBeUndefined();
        expect(getSessionEntry('fresh')).toBeDefined();
    });
});
