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

// A keepalive CronCreate whose result reveals the job id, so pendingTaskId
// is recoverable and CronDelete can be matched precisely.
function transcriptWith(jobId: string): string {
    const p = path.join(TMP_HOME, 't.jsonl');
    const create = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'CronCreate', input: { cron: '7 * * * *', recurring: false, prompt: KEEPALIVE_MARKER + ' tiny' } }] }
    };
    const result = {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: `Scheduled job ${jobId}.` }] }
    };
    fs.writeFileSync(p, JSON.stringify(create) + '\n' + JSON.stringify(result) + '\n');
    return p;
}

// A keepalive create with no result: pending, but job id unrecoverable.
function transcriptNoId(): string {
    const p = path.join(TMP_HOME, 't.jsonl');
    const create = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'CronCreate', input: { cron: '7 * * * *', recurring: false, prompt: KEEPALIVE_MARKER + ' tiny' } }] }
    };
    fs.writeFileSync(p, JSON.stringify(create) + '\n');
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

    test('allows CronDelete of the pending keepalive task (id recovered)', () => {
        const tp = transcriptWith('abc99999');
        const out = run({ tool_name: 'CronDelete', tool_input: { id: 'abc99999' }, transcript_path: tp });
        expect((out.hookSpecificOutput as Record<string, unknown>)?.permissionDecision).toBe('allow');
    });

    test('passes through CronDelete of an unrelated task when id is known', () => {
        const tp = transcriptWith('abc99999');
        const out = run({ tool_name: 'CronDelete', tool_input: { id: 'other567' }, transcript_path: tp });
        expect(out).toEqual({});
    });

    test('allows CronDelete when a keepalive is pending but its id is unrecoverable', () => {
        const tp = transcriptNoId();
        const out = run({ tool_name: 'CronDelete', tool_input: { id: 'whatever1' }, transcript_path: tp });
        expect((out.hookSpecificOutput as Record<string, unknown>)?.permissionDecision).toBe('allow');
    });

    test('passes through CronDelete when no keepalive is pending', () => {
        const out = run({ tool_name: 'CronDelete', tool_input: { id: 'anything1' } });
        expect(out).toEqual({});
    });

    test('passes through unrelated tools', () => {
        const out = run({ tool_name: 'Bash', tool_input: { command: 'ls' } });
        expect(out).toEqual({});
    });
});
