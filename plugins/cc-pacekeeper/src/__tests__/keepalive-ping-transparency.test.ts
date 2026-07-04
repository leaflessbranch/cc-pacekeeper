import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TICK = path.join(import.meta.dir, '..', 'tick.ts');

/**
 * A keepalive ping arrives as a UserPromptSubmit carrying the marker. It is a
 * system event, not user activity: it must not overwrite lastEventAt (which
 * would destroy the real idle-start time), must not surface a "you were away"
 * line, and must not emit a keepalive-cancel directive. The tick short-circuits
 * on such pings and emits nothing.
 */
const MARKER = '[pacekeeper-keepalive]';

function runTick(home: string, payload: Record<string, unknown>): string {
    const res = spawnSync('bun', ['run', TICK], {
        input: JSON.stringify(payload),
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
        encoding: 'utf8'
    });
    return res.stdout ?? '';
}

function stateFile(home: string): string {
    return path.join(home, '.cache', 'cc-pacekeeper', 'session-state.json');
}

function seedSandbox(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ping-'));
    fs.mkdirSync(path.join(home, '.cache', 'cc-pacekeeper'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
        path.join(home, '.cache', 'cc-pacekeeper', 'usage.json'),
        JSON.stringify({
            sessionUsage: 45,
            sessionResetAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
            weeklyUsage: 40,
            fetchedAt: Date.now()
        })
    );
    return home;
}

describe('keepalive ping transparency', () => {
    test('a keepalive ping emits nothing and does not touch idle state', () => {
        const home = seedSandbox();
        // Establish an idle-start: a prior Stop stamped lastEventAt well in the past.
        const idleStart = Date.now() - 40 * 60_000;
        fs.writeFileSync(stateFile(home), JSON.stringify({
            'sess-1': { sessionStartedAt: idleStart - 60_000, lastEventAt: idleStart }
        }));

        const out = runTick(home, {
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            cwd: path.join(home, 'proj'),
            prompt: `${MARKER} Cache-warming ping. Reply with a single word.`
        });

        // No output at all — no AFK line, no cancel directive, no heartbeat.
        expect(out.includes('additionalContext')).toBe(false);
        expect(out).not.toContain('were away');
        expect(out).not.toContain('cancel');

        // lastEventAt is preserved: the ping did not overwrite the idle-start.
        const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        expect(state['sess-1'].lastEventAt).toBe(idleStart);

        fs.rmSync(home, { recursive: true, force: true });
    });

    test('a genuine prompt after idle DOES update state (control)', () => {
        const home = seedSandbox();
        const idleStart = Date.now() - 40 * 60_000;
        fs.writeFileSync(stateFile(home), JSON.stringify({
            'sess-1': { sessionStartedAt: idleStart - 60_000, lastEventAt: idleStart }
        }));

        runTick(home, {
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            cwd: path.join(home, 'proj'),
            prompt: 'a real message from the user'
        });

        const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        // A real prompt advances lastEventAt past the old idle-start.
        expect(state['sess-1'].lastEventAt).toBeGreaterThan(idleStart);

        fs.rmSync(home, { recursive: true, force: true });
    });
});
