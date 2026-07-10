import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { saveCheckpoint, readCheckpoint } from '../checkpoint';

const CLI = path.join(import.meta.dir, '..', 'checkpoint-cli.ts');
const DIR_NAME = '.claude-checkpoints';

let TMP = '';
let TMP_HOME = '';

beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-wake-'));
    TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-wake-home-'));
    // git repo so resolveProjectRoot/lane derivation behaves; also keeps the
    // dir from being refused (it's under tmp, so we pass --cwd... actually
    // resolveProjectRoot refuses tmp — CLI calls below pin --cwd explicitly,
    // which is also refused for tmp; so CLI runs use a HOME-external safe dir).
    execFileSync('git', ['init', '-q', '-b', 'main', TMP]);
});

afterEach(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('wake_at / wake_prompt frontmatter', () => {
    test('round-trips through save + read', () => {
        const wakeAt = new Date(Date.now() + 3600_000).toISOString();
        const wakePrompt = '[pacekeeper-resume] lane main — resume and re-dispatch pending handoffs';
        const { path: written } = saveCheckpoint({
            cwd: TMP,
            checkpointDirName: DIR_NAME,
            frontmatter: { trigger: 'auto_block_renewal', wake_at: wakeAt, wake_prompt: wakePrompt },
            body: '## Goal\nfinish the thing'
        });
        const back = readCheckpoint(written)!;
        expect(back.frontmatter.wake_at).toBe(wakeAt);
        expect(back.frontmatter.wake_prompt).toBe(wakePrompt);
    });

    test('absent wake fields stay absent', () => {
        const { path: written } = saveCheckpoint({
            cwd: TMP,
            checkpointDirName: DIR_NAME,
            frontmatter: { trigger: 'user_invoked' },
            body: '## Goal\ng'
        });
        const back = readCheckpoint(written)!;
        expect(back.frontmatter.wake_at).toBeUndefined();
        expect(back.frontmatter.wake_prompt).toBeUndefined();
    });
});

/** CLI handoffs verbs are thin wrappers over agent-budget.ts [G3]. The CLI
 * refuses tmp roots, so we create a fake safe project under HOME. */
function safeProject(): string {
    const proj = path.join(TMP_HOME, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', proj]);
    return proj;
}

function runCli(args: string[], input?: string): { stdout: string; status: number | null } {
    const res = spawnSync('bun', ['run', '--silent', CLI, ...args], {
        input: input ?? '',
        encoding: 'utf8',
        env: { ...process.env, HOME: TMP_HOME }
    });
    return { stdout: res.stdout ?? '', status: res.status };
}

describe('pacekeeper-checkpoint handoffs verbs', () => {
    test('list on empty registry', () => {
        const proj = safeProject();
        const { stdout } = runCli(['handoffs', 'list', '--cwd', proj]);
        expect(stdout).toContain('No pending handoffs.');
    });

    test('write → list → archive via CLI', () => {
        const proj = safeProject();
        const w = runCli(['handoffs', 'write', 'ag-cli', '--cwd', proj, '--agent-type', 'Explore', '--trigger', 'budget_pause', '--body', '## Goal\ng\n## Done\nd\n## Next\nn\n## Files touched\n- f'], '');
        expect(w.stdout).toContain('Wrote handoff:');
        expect(w.stdout).toContain(path.join('handoffs', 'ag-cli.md'));

        const l = runCli(['handoffs', 'list', '--cwd', proj]);
        expect(l.stdout).toContain('ag-cli');
        expect(l.stdout).toContain('Explore');
        expect(l.stdout).toContain('budget_pause');

        const a = runCli(['handoffs', 'archive', 'ag-cli', '--cwd', proj]);
        expect(a.stdout).toContain('Archived →');

        const l2 = runCli(['handoffs', 'list', '--cwd', proj]);
        expect(l2.stdout).toContain('No pending handoffs.');
    });

    test('archive of unknown agent id reports cleanly', () => {
        const proj = safeProject();
        const { stdout } = runCli(['handoffs', 'archive', 'ghost', '--cwd', proj]);
        expect(stdout).toContain('No pending handoff for agent_id "ghost".');
    });

    test('write without agent id exits non-zero with usage', () => {
        const proj = safeProject();
        const { stdout, status } = runCli(['handoffs', 'write', '--cwd', proj]);
        expect(status).toBe(1);
        expect(stdout).toContain('Usage:');
    });
});
