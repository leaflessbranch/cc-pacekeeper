import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PING_SUPPRESSED_REASONS } from '../keepalive';

const TICK = path.join(import.meta.dir, '..', 'tick.ts');

/**
 * A keepalive ping arrives as a UserPromptSubmit carrying the marker. It is a
 * system event, not user activity: it must not overwrite lastEventAt (which
 * would destroy the real idle-start time), must not surface a "you were away"
 * line. While the user is active, the ping is blocked hook-side (a `block`
 * decision) at zero context cost; while idle, guidance is passed through.
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
    test('an idle ping passes through guidance without touching idle state', () => {
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

        // No AFK line, no heartbeat, no cron mutation guidance. The ping passes
        // through idle guidance — here 40m idle → passthrough, not blocked.
        expect(out).not.toContain('were away');
        expect(out).not.toContain('"decision":"block"');
        expect(out).toContain(MARKER);
        expect(out).toContain('idle');
        expect(out).toContain('do NOT create or delete any cron jobs');

        // lastEventAt is preserved: the ping did not overwrite the idle-start.
        // The passthrough stamps keepalive.idleSince so idle time accumulates
        // across ping turns (whose Stops bump lastEventAt).
        const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        expect(state['sess-1'].lastEventAt).toBe(idleStart);
        expect(state['sess-1'].keepalive.idleSince).toBe(idleStart);

        fs.rmSync(home, { recursive: true, force: true });
    });

    test('a ping with a small idle gap is blocked hook-side, no state mutation', () => {
        const home = seedSandbox();
        // lastEventAt only 30s ago → user active again → block.
        const recent = Date.now() - 30_000;
        fs.writeFileSync(stateFile(home), JSON.stringify({
            'sess-1': { sessionStartedAt: recent - 60_000, lastEventAt: recent }
        }));

        const out = runTick(home, {
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            cwd: path.join(home, 'proj'),
            prompt: `${MARKER} Cache-warming ping.`
        });

        const parsed = JSON.parse(out);
        expect(parsed.decision).toBe('block');
        expect(PING_SUPPRESSED_REASONS as readonly string[]).toContain(parsed.reason);
        // Still no state mutation.
        const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        expect(state['sess-1'].lastEventAt).toBe(recent);

        fs.rmSync(home, { recursive: true, force: true });
    });

    test('a ping after max_idle_hours tells Claude to delete the cron job', () => {
        const home = seedSandbox();
        // Realistic long-idle shape: earlier ping turns kept bumping lastEventAt
        // (only 40m ago), but idleSince — stamped by the first passthrough ping —
        // is 13 hours old, exceeding the default max_idle_hours (12).
        const idleStart = Date.now() - 13 * 3600_000;
        const lastPingTurn = Date.now() - 40 * 60_000;
        fs.writeFileSync(stateFile(home), JSON.stringify({
            'sess-1': {
                sessionStartedAt: idleStart - 60_000,
                lastEventAt: lastPingTurn,
                keepalive: { idleSince: idleStart }
            }
        }));

        const out = runTick(home, {
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            cwd: path.join(home, 'proj'),
            prompt: `${MARKER} Cache-warming ping.`
        });

        expect(out).toContain(MARKER);
        expect(out).toContain('CronDelete');
        expect(out).toMatch(/idle over \d+ hours/);

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

    test('a prompt quoting the marker mid-text (idle) is not treated as a ping', () => {
        // Regression: a pasted subagent report or user message that merely
        // QUOTES the marker must pass through as a real prompt, not be
        // misclassified as a system keepalive ping.
        const home = seedSandbox();
        const idleStart = Date.now() - 40 * 60_000;
        fs.writeFileSync(stateFile(home), JSON.stringify({
            'sess-1': { sessionStartedAt: idleStart - 60_000, lastEventAt: idleStart }
        }));

        const out = runTick(home, {
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            cwd: path.join(home, 'proj'),
            prompt: `examine this: "${MARKER} ping suppressed"`
        });

        // Not treated as a ping: no block decision, no idle-gate cron guidance.
        expect(out).not.toContain('"decision":"block"');
        expect(out).not.toContain('do NOT create or delete any cron jobs');

        // Real prompt: lastEventAt advances past the old idle-start, proving it
        // went through the normal per-prompt heartbeat path.
        const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        expect(state['sess-1'].lastEventAt).toBeGreaterThan(idleStart);

        fs.rmSync(home, { recursive: true, force: true });
    });

    test('a prompt quoting the marker mid-text (active) is not blocked either', () => {
        // Regression (observed live): subagent completion notifications whose
        // reports quoted the keepalive marker were suppressed and lost because
        // the gate matched on `.includes` instead of a start anchor.
        const home = seedSandbox();
        const recent = Date.now() - 30_000;
        fs.writeFileSync(stateFile(home), JSON.stringify({
            'sess-1': { sessionStartedAt: recent - 60_000, lastEventAt: recent }
        }));

        const out = runTick(home, {
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            cwd: path.join(home, 'proj'),
            prompt: `subagent report: "${MARKER} ping suppressed — user active"`
        });

        expect(out).not.toContain('"decision":"block"');

        fs.rmSync(home, { recursive: true, force: true });
    });

    test('a real prompt clears keepalive.idleSince', () => {
        const home = seedSandbox();
        const idleStart = Date.now() - 40 * 60_000;
        fs.writeFileSync(stateFile(home), JSON.stringify({
            'sess-1': {
                sessionStartedAt: idleStart - 60_000,
                lastEventAt: idleStart,
                keepalive: { idleSince: idleStart }
            }
        }));

        runTick(home, {
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            cwd: path.join(home, 'proj'),
            prompt: 'back at the keyboard'
        });

        const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        expect(state['sess-1'].keepalive?.idleSince).toBeUndefined();

        fs.rmSync(home, { recursive: true, force: true });
    });
});
