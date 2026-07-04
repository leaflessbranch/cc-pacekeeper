import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TICK = path.join(import.meta.dir, '..', 'tick.ts');

/**
 * Regression guard for the bug where the Stop hook never scheduled the AFK
 * cache keepalive. The keepalive schedule directive only makes sense when the
 * user is idle, and Stop is the one hook that fires at idle — but the Stop
 * branch in tick.ts never called keepaliveDirective, so the schedule directive
 * was never emitted anywhere (UserPromptSubmit hardcodes userIsIdle:false,
 * which only ever cancels). The keepalive appeared to "not fire" because it was
 * never scheduled in the first place.
 *
 * We run the real tick binary with a Stop payload under a sandboxed HOME and a
 * staged subscription usage cache, and assert the schedule directive is emitted.
 */
function runStopTick(home: string): string {
    const res = spawnSync('bun', ['run', TICK], {
        input: JSON.stringify({
            session_id: 'ka-wiring',
            hook_event_name: 'Stop',
            cwd: path.join(home, 'proj'),
            transcript_path: path.join(home, 't.jsonl')
        }),
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
        encoding: 'utf8'
    });
    return res.stdout ?? '';
}

describe('Stop hook keepalive wiring', () => {
    test('Stop emits the schedule directive when idle with a subscription usage cache', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ka-'));
        fs.mkdirSync(path.join(home, '.cache', 'cc-pacekeeper'), { recursive: true });
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        // Subscription usage cache: five_hour reading present, not on credits.
        fs.writeFileSync(
            path.join(home, '.cache', 'cc-pacekeeper', 'usage.json'),
            JSON.stringify({
                sessionUsage: 45,
                sessionResetAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
                weeklyUsage: 40,
                fetchedAt: Date.now()
            })
        );
        // Minimal transcript so the transcript_path branch runs (no pending keepalive).
        fs.writeFileSync(
            path.join(home, 't.jsonl'),
            JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n'
        );

        const out = runStopTick(home);
        fs.rmSync(home, { recursive: true, force: true });

        expect(out).toContain('[pacekeeper-keepalive]');
        expect(out).toContain('CronCreate');
        expect(out).toContain('idle');
    });
});
