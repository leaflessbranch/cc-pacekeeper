import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KEEPALIVE_MARKER } from '../keepalive';

const APPROVE = path.join(import.meta.dir, '..', 'approve.ts');

let TMP_HOME = '';
const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
    // Isolate config so keepalive.enabled default is used, not a user override.
    TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-test-'));
});
afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

function run(stdin: unknown): Record<string, unknown> {
    const res = spawnSync('bun', ['run', '--silent', APPROVE], {
        input: JSON.stringify(stdin),
        encoding: 'utf8',
        env: { ...process.env, HOME: TMP_HOME }
    });
    return JSON.parse(res.stdout || '{}');
}

function transcriptWith(taskId: string): string {
    const p = path.join(TMP_HOME, 't.jsonl');
    const entry = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'CronCreate', input: { id: taskId, prompt: KEEPALIVE_MARKER + ' tiny' } }] }
    };
    fs.writeFileSync(p, JSON.stringify(entry) + '\n');
    return p;
}

describe('pacekeeper-approve', () => {
    test('allows marker CronCreate', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { prompt: KEEPALIVE_MARKER + ' do a tiny turn' } });
        expect((out.hookSpecificOutput as Record<string, unknown>)?.permissionDecision).toBe('allow');
    });

    test('passes through non-marker CronCreate', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { prompt: 'deploy to prod' } });
        expect(out).toEqual({});
    });

    test('allows CronDelete of the pending keepalive task', () => {
        const tp = transcriptWith('task-9');
        const out = run({ tool_name: 'CronDelete', tool_input: { id: 'task-9' }, transcript_path: tp });
        expect((out.hookSpecificOutput as Record<string, unknown>)?.permissionDecision).toBe('allow');
    });

    test('passes through CronDelete of an unrelated task', () => {
        const tp = transcriptWith('task-9');
        const out = run({ tool_name: 'CronDelete', tool_input: { id: 'other' }, transcript_path: tp });
        expect(out).toEqual({});
    });

    test('passes through unrelated tools', () => {
        const out = run({ tool_name: 'Bash', tool_input: { command: 'ls' } });
        expect(out).toEqual({});
    });
});
