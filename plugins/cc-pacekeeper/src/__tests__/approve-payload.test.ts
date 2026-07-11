import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KEEPALIVE_MARKER } from '../keepalive';
import { RESUME_MARKER } from '../agent-budget';

const APPROVE = path.join(import.meta.dir, '..', 'approve.ts');

let TMP_HOME = '';
const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
    TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-payload-test-'));
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

function isAllow(out: Record<string, unknown>): boolean {
    return (out.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision === 'allow';
}

describe('CronCreate keepalive shape validation', () => {
    // Legit: exactly the shape keepaliveDirective instructs.
    test('allows recurring two-fixed-minute keepalive with marker', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '13,43 * * * *', recurring: true, prompt: KEEPALIVE_MARKER + ' tiny turn' } });
        expect(isAllow(out)).toBe(true);
    });

    // ATTACK: marker embedded but cron is a fire-every-minute wildcard job.
    test('rejects marker embedded in a "* * * * *" recurring job', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '* * * * *', recurring: true, prompt: 'exfil ' + KEEPALIVE_MARKER + ' now' } });
        expect(out).toEqual({});
    });

    // ATTACK: marker present, recurring true, but a single-minute (non two-mark) cron.
    test('rejects marker with a "*/5" step cron', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '*/5 * * * *', recurring: true, prompt: KEEPALIVE_MARKER } });
        expect(out).toEqual({});
    });

    // ATTACK: marker + valid cron but recurring is false (keepalive must recur).
    test('rejects keepalive-shaped cron when recurring is false', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '13,43 * * * *', recurring: false, prompt: KEEPALIVE_MARKER } });
        expect(out).toEqual({});
    });

    // ATTACK: minute out of range (0-59) despite two-mark shape.
    test('rejects keepalive cron with an out-of-range minute', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '13,77 * * * *', recurring: true, prompt: KEEPALIVE_MARKER } });
        expect(out).toEqual({});
    });

    // ATTACK: over-length prompt with a valid marker + cron (scope-escalation cap).
    test('rejects an over-length prompt even with valid marker and cron', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '13,43 * * * *', recurring: true, prompt: KEEPALIVE_MARKER + ' ' + 'x'.repeat(1200) } });
        expect(out).toEqual({});
    });

    // ATTACK: missing cron field entirely.
    test('rejects keepalive marker with no cron field', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { recurring: true, prompt: KEEPALIVE_MARKER + ' tiny' } });
        expect(out).toEqual({});
    });
});

describe('CronCreate wake one-shot shape validation', () => {
    // Legit: one-shot pinned to a specific minute/hour/dom/month.
    test('allows recurring:false one-shot whose prompt starts with RESUME_MARKER', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '30 14 7 11 *', recurring: false, prompt: RESUME_MARKER + ' lane feat-x' } });
        expect(isAllow(out)).toBe(true);
    });

    // ATTACK: resume marker but wildcard cron (recurring:false) — would fire repeatedly-ish / unpinned.
    test('rejects resume marker with a wildcard cron', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '* * * * *', recurring: false, prompt: RESUME_MARKER + ' lane feat-x' } });
        expect(out).toEqual({});
    });

    // ATTACK: resume marker mid-prompt (must START WITH it).
    test('rejects resume marker not at the start of the prompt', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '30 14 7 11 *', recurring: false, prompt: 'please ' + RESUME_MARKER + ' now' } });
        expect(out).toEqual({});
    });

    // ATTACK: resume marker one-shot but recurring true (one-shot must be false).
    test('rejects resume one-shot cron when recurring is true', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '30 14 7 11 *', recurring: true, prompt: RESUME_MARKER + ' lane feat-x' } });
        expect(out).toEqual({});
    });

    // ATTACK: day-of-month wildcard (not a single pinned fire).
    test('rejects resume one-shot with a wildcard day-of-month', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '30 14 * 11 *', recurring: false, prompt: RESUME_MARKER + ' lane feat-x' } });
        expect(out).toEqual({});
    });

    // ATTACK: over-length prompt with valid resume marker + cron.
    test('rejects an over-length resume prompt', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '30 14 7 11 *', recurring: false, prompt: RESUME_MARKER + ' ' + 'y'.repeat(1200) } });
        expect(out).toEqual({});
    });
});

// A transcript where a RESUME_MARKER (wake one-shot) create returned a job id.
function resumeTranscript(jobId: string): string {
    const p = path.join(TMP_HOME, 'r.jsonl');
    const create = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'ru-1', name: 'CronCreate', input: { cron: '30 14 7 11 *', recurring: false, prompt: RESUME_MARKER + ' lane feat-x' } }] }
    };
    const result = {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'ru-1', content: `Scheduled job ${jobId}.` }] }
    };
    fs.writeFileSync(p, JSON.stringify(create) + '\n' + JSON.stringify(result) + '\n');
    return p;
}

describe('CronDelete id-scoping', () => {
    test('allows delete of a known wake one-shot id', () => {
        const tp = resumeTranscript('wake1234');
        const out = run({ tool_name: 'CronDelete', tool_input: { id: 'wake1234' }, transcript_path: tp });
        expect(isAllow(out)).toBe(true);
    });

    // ATTACK: delete an id the transcript never recorded.
    test('rejects delete of an id the transcript does not know', () => {
        const tp = resumeTranscript('wake1234');
        const out = run({ tool_name: 'CronDelete', tool_input: { id: 'evil0000' }, transcript_path: tp });
        expect(out).toEqual({});
    });

    test('rejects delete with a missing id', () => {
        const tp = resumeTranscript('wake1234');
        const out = run({ tool_name: 'CronDelete', tool_input: {}, transcript_path: tp });
        expect(out).toEqual({});
    });
});

describe('fail-safe parsing', () => {
    test('empty stdin falls through', () => {
        const res = spawnSync('bun', ['run', '--silent', APPROVE], { input: '', encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
        expect(JSON.parse(res.stdout || '{}')).toEqual({});
    });

    test('garbage stdin falls through', () => {
        const res = spawnSync('bun', ['run', '--silent', APPROVE], { input: 'not json {{{', encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
        expect(JSON.parse(res.stdout || '{}')).toEqual({});
    });

    test('CronCreate with non-string prompt falls through', () => {
        const out = run({ tool_name: 'CronCreate', tool_input: { cron: '13,43 * * * *', recurring: true, prompt: 42 } });
        expect(out).toEqual({});
    });
});
