import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RESUME_MARKER } from '../agent-budget';

const APPROVE = path.join(import.meta.dir, '..', 'approve.ts');

let TMP_HOME = '';

beforeEach(() => {
    TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-resume-test-'));
});
afterEach(() => {
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

function decision(out: Record<string, unknown>): string | undefined {
    const hso = out.hookSpecificOutput as Record<string, unknown> | undefined;
    return hso?.permissionDecision as string | undefined;
}

/** [G7] Wake-arming is exclusively the main loop's job: resume-marker
 * CronCreate is auto-approved only when agent_id is absent. */
describe('pacekeeper-approve resume marker', () => {
    // A one-shot pins minute/hour/day-of-month/month (single future fire).
    test('allows full-shape wake one-shot on the main thread (no agent_id)', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '30 14 7 11 *', recurring: false, prompt: RESUME_MARKER + ' lane feat-x, 2 handoffs pending' } });
        expect(decision(out)).toBe('allow');
    });

    test('does NOT allow marker CronCreate from a subagent (agent_id present)', () => {
        const out = run({
            tool_name: 'CronCreate',
            tool_input: { cron: '30 14 7 11 *', recurring: false, prompt: RESUME_MARKER + ' lane feat-x' },
            agent_id: 'ag-123'
        });
        expect(decision(out)).toBeUndefined();
        expect(out).toEqual({});
    });

    test('non-marker CronCreate still falls through', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '30 14 7 11 *', recurring: false, prompt: 'unrelated job' } });
        expect(out).toEqual({});
    });
});
