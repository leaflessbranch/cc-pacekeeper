import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let TMP = '';
let SESSIONS = '';
const ORIGINAL = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
    TMP = path.join(os.tmpdir(), `cc-pacekeeper-live-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    SESSIONS = path.join(TMP, 'sessions');
    fs.mkdirSync(SESSIONS, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = TMP;
    delete require.cache[require.resolve('../live-sessions')];
    delete require.cache[require.resolve('../vendor/claude-config-dir')];
});

afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

const write = (name: string, obj: unknown): void =>
    fs.writeFileSync(path.join(SESSIONS, name), typeof obj === 'string' ? obj : JSON.stringify(obj));

describe('liveSessionCount', () => {
    test('counts only sessions whose pid is alive', async () => {
        const { liveSessionCount } = await import('../live-sessions');
        write('alive.json', { pid: process.pid, sessionId: 'a', cwd: '/x', status: 'busy', updatedAt: 1 });
        write('dead.json', { pid: 2 ** 30, sessionId: 'b', cwd: '/y', status: 'idle', updatedAt: 1 });
        expect(liveSessionCount()).toBe(1);
    });

    test('malformed JSON is skipped, not fatal', async () => {
        const { liveSessionCount } = await import('../live-sessions');
        write('alive.json', { pid: process.pid });
        write('junk.json', '{not valid');
        expect(liveSessionCount()).toBe(1);
    });

    test('missing sessions dir returns null', async () => {
        const { liveSessionCount } = await import('../live-sessions');
        fs.rmSync(SESSIONS, { recursive: true, force: true });
        expect(liveSessionCount()).toBeNull();
    });

    test('empty readable dir returns 0', async () => {
        const { liveSessionCount } = await import('../live-sessions');
        expect(liveSessionCount()).toBe(0);
    });

    test('zero, negative, and fractional pids never count as alive', async () => {
        const { liveSessionCount } = await import('../live-sessions');
        write('zero.json', { pid: 0 });
        write('neg.json', { pid: -5 });
        write('frac.json', { pid: 1.5 });
        expect(liveSessionCount()).toBe(0);
    });
});
