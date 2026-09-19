import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { saveCheckpoint, listActive, listArchive, readCheckpoint } from '../checkpoint';
import { DEFAULT_CONFIG } from '../config';
import { parseArgs, verbCleanup, verbDiscard, verbList, verbPeek, verbResume, verbSave } from '../checkpoint-cli';

const CLI = path.join(import.meta.dir, '..', 'checkpoint-cli.ts');
// Safe-root fixtures cannot live under the tmpdir (resolveProjectRoot refuses it).
const FIXTURE_BASE = path.join(import.meta.dir, '.cli-fixtures');
/** Fixture dirs removed after each test. */
const cleanups: string[] = [];

const CHECKPOINT_DIR = '.claude-checkpoints';
const cfg = DEFAULT_CONFIG;

let CWD: string;

beforeEach(() => {
    CWD = path.join(os.tmpdir(), `cc-pacekeeper-cli-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(CWD, { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const dir of cleanups.splice(0)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

/** Capture everything written to stdout while `fn` runs. */
function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
        fn();
    } finally {
        process.stdout.write = original;
    }
    return chunks.join('');
}

describe('resume by lane name / index', () => {
    test('resumes the checkpoint matching a lane name', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-a' }, body: '## Goal\nA\n' });
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-b' }, body: '## Goal\nB\n' });

        const out = captureStdout(() => verbResume(parseArgs(['resume', 'lane-b']), CWD, cfg));
        expect(out).toContain('Goal');
        expect(out).toContain('B');

        const active = listActive(CWD, CHECKPOINT_DIR);
        expect(active).toHaveLength(1);
        expect(active[0]?.body).toContain('A');

        const archived = listArchive(CWD, CHECKPOINT_DIR);
        expect(archived).toHaveLength(1);
        expect(archived[0]?.frontmatter.status).toBe('resumed');
        expect(archived[0]?.frontmatter.resumed_at).toBeDefined();
    });

    test('unsanitized selector (raw branch name) matches its lane', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'feat/some-thing' }, body: '## Goal\nX\n' });
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-b' }, body: '## Goal\nB\n' });

        const out = captureStdout(() => verbResume(parseArgs(['resume', 'feat/some-thing']), CWD, cfg));
        expect(out).toContain('X');
        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(1);
    });

    test('resumes by numeric index and records resumed_by_session', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-a' }, body: '## Goal\nA\n' });

        // Only an id with a transcript is recorded, so give it one.
        const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-cfg-'));
        fs.mkdirSync(path.join(cfgDir, 'projects', '-p'), { recursive: true });
        fs.writeFileSync(path.join(cfgDir, 'projects', '-p', 'sess-123.jsonl'), '{}\n');
        const prev = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = cfgDir;
        try {
            captureStdout(() => verbResume(parseArgs(['resume', '1', '--session-id', 'sess-123']), CWD, cfg));
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
            fs.rmSync(cfgDir, { recursive: true, force: true });
        }

        const archived = listArchive(CWD, CHECKPOINT_DIR);
        expect(archived[0]?.frontmatter.resumed_by_session).toBe('sess-123');
    });
});

describe('bare resume with multiple actives', () => {
    test('lists lanes and asks the user to pick, without archiving anything', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-a' }, body: '## Goal\nA\n' });
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-b' }, body: '## Goal\nB\n' });

        const out = captureStdout(() => verbResume(parseArgs(['resume']), CWD, cfg));
        expect(out).toContain('lane-a');
        expect(out).toContain('lane-b');
        expect(out.toLowerCase()).toContain('pick');

        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(2);
        expect(listArchive(CWD, CHECKPOINT_DIR)).toHaveLength(0);
    });

    test('bare resume with exactly one active lane resumes it', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-a' }, body: '## Goal\nA\n' });

        captureStdout(() => verbResume(parseArgs(['resume']), CWD, cfg));

        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(0);
        expect(listArchive(CWD, CHECKPOINT_DIR)).toHaveLength(1);
    });
});

describe('peek', () => {
    test('prints the body without archiving or mutating', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-a' }, body: '## Goal\nPeekMe\n' });

        const out = captureStdout(() => verbPeek(parseArgs(['peek', 'lane-a']), CWD, cfg));
        expect(out).toContain('PeekMe');

        const active = listActive(CWD, CHECKPOINT_DIR);
        expect(active).toHaveLength(1);
        expect(active[0]?.frontmatter.status).toBe('active');
        expect(listArchive(CWD, CHECKPOINT_DIR)).toHaveLength(0);
    });
});

describe('resume --worktree', () => {
    test('prints the recorded worktree path when it still exists on disk', () => {
        const wtDir = path.join(CWD, 'linked-worktree');
        fs.mkdirSync(wtDir, { recursive: true });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a', worktree: wtDir, git_branch: 'feature-a' },
            body: '## Goal\nA\n'
        });

        const out = captureStdout(() => verbResume(parseArgs(['resume', 'lane-a', '--worktree']), CWD, cfg));
        expect(out).toContain(`Worktree: ${wtDir}`);
    });

    test('reports it cannot create a worktree when there is no git branch recorded', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a' }, body: '## Goal\nA\n'
        });

        const out = captureStdout(() => verbResume(parseArgs(['resume', 'lane-a', '--worktree']), CWD, cfg));
        expect(out).toContain('nothing to re-enter');
    });
});

describe('list', () => {
    test('shows index, lane name, branch, worktree placeholder, and goal', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a', git_branch: 'feature-a' },
            body: '## Goal\nDo the thing\n'
        });

        const out = captureStdout(() => verbList(parseArgs(['list']), CWD, cfg));
        expect(out).toContain('[1]');
        expect(out).toContain('lane-a');
        expect(out).toContain('feature-a');
        expect(out).toContain('Do the thing');
    });
});

describe('discard', () => {
    test('discard by lane name marks superseded without resuming', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-a' }, body: '## Goal\nA\n' });

        captureStdout(() => verbDiscard(parseArgs(['discard', 'lane-a', '--reason', 'no longer needed']), CWD, cfg));

        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(0);
        const archived = listArchive(CWD, CHECKPOINT_DIR);
        expect(archived[0]?.frontmatter.status).toBe('superseded');
        expect(archived[0]?.frontmatter.discard_reason).toBe('no longer needed');
    });
});

describe('cleanup keeps newest per lane', () => {
    test('an old checkpoint in a lane with only one active is never marked stale (it is the newest)', () => {
        const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a', created_at: old }, body: '## Goal\nOld but newest in its lane\n'
        });

        captureStdout(() => verbCleanup(parseArgs(['cleanup', '--apply']), CWD, cfg));

        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(1);
    });

    test('an older non-newest checkpoint in the same lane is marked stale, the newest is kept', () => {
        const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const older = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        // saveCheckpoint's supersede logic demotes any prior *active* entry in the
        // same lane, so to get two live actives in one lane we write the older
        // file's frontmatter status back to 'active' directly after the second save.
        const first = saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a', created_at: older }, body: '## Goal\nOldest\n'
        });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a', created_at: old }, body: '## Goal\nNewer\n'
        });
        // The first save's file was moved to archive/ as superseded; resurrect a
        // live copy of it as active to simulate two actives coexisting in one lane
        // (this can otherwise only arise from concurrent/legacy writes).
        const archivedPath = path.join(CWD, CHECKPOINT_DIR, 'archive', path.basename(first.path));
        const raw = fs.readFileSync(archivedPath, 'utf8').replace('status: superseded', 'status: active');
        const resurrectedPath = path.join(CWD, CHECKPOINT_DIR, path.basename(first.path));
        fs.writeFileSync(resurrectedPath, raw);
        // listLive sorts by mtime (newest first) — backdate this file's mtime so
        // it reads as the older of the two actives, matching its created_at.
        const past = new Date(Date.now() - 60 * 60 * 1000);
        fs.utimesSync(resurrectedPath, past, past);

        captureStdout(() => verbCleanup(parseArgs(['cleanup', '--apply']), CWD, cfg));

        const active = listActive(CWD, CHECKPOINT_DIR);
        expect(active).toHaveLength(1);
        expect(active[0]?.body).toContain('Newer');
    });
});

describe('save: goal lock', () => {
    function bodyFile(body: string): string {
        const p = path.join(CWD, `body-${Math.random().toString(36).slice(2)}.md`);
        fs.writeFileSync(p, body);
        return p;
    }
    async function save(argv: string[]): Promise<{ out: string; code: number | undefined }> {
        // Bun ignores `process.exitCode = undefined`, so 0 is the "unset" sentinel.
        process.exitCode = 0;
        let out = '';
        const chunks: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
        try {
            await verbSave(parseArgs(['save', ...argv]), CWD, cfg);
        } finally {
            process.stdout.write = original;
        }
        out = chunks.join('');
        const code = process.exitCode === 0 ? undefined : process.exitCode as number;
        process.exitCode = 0;
        return { out, code };
    }
    const GOAL_A = '## Goal\nShip the excavator demo, "fake nothing".\n\n## Status\n- step 1\n';

    test('same goal (modulo whitespace) saves and supersedes as before', async () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane' }, body: GOAL_A });
        const { out, code } = await save(['--name', 'lane', '--body-file', bodyFile('## Goal\nShip the excavator demo,\n"fake nothing".\n\n## Status\n- step 2\n')]);
        expect(code).toBeUndefined();
        expect(out).toContain('Saved checkpoint');
        const active = listActive(CWD, CHECKPOINT_DIR);
        expect(active).toHaveLength(1);
        expect(active[0]!.body).toContain('step 2');
        expect(active[0]!.frontmatter.goal_changed).toBeUndefined();
    });

    test('a different goal without --goal-changed is refused: exit 2, both goals printed, nothing written', async () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane' }, body: GOAL_A });
        const { out, code } = await save(['--name', 'lane', '--body-file', bodyFile('## Goal\nBuild a dashboard instead.\n\n## Status\n- pivoted\n')]);
        expect(code).toBe(2);
        expect(out).toContain('Goal differs');
        expect(out).toContain('Ship the excavator demo');
        expect(out).toContain('Build a dashboard instead');
        expect(out).toContain('--goal-changed');
        const active = listActive(CWD, CHECKPOINT_DIR);
        expect(active).toHaveLength(1);
        expect(active[0]!.body).toContain('step 1');
        expect(listArchive(CWD, CHECKPOINT_DIR)).toHaveLength(0);
    });

    test('with --goal-changed the save goes through and is marked', async () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane' }, body: GOAL_A });
        const { code } = await save(['--name', 'lane', '--goal-changed', '--body-file', bodyFile('## Goal\nBuild a dashboard instead.\n')]);
        expect(code).toBeUndefined();
        const active = listActive(CWD, CHECKPOINT_DIR)[0]!;
        expect(active.body).toContain('Build a dashboard');
        expect(active.frontmatter.goal_changed).toBe(true);
        const listed = captureStdout(() => verbList(parseArgs(['list']), CWD, cfg));
        expect(listed).toContain('goal-changed');
    });

    // parseArgs gives a bare flag the next non---- token as its value, so
    // `--goal-changed true` arrives as the string 'true'. Presence is consent.
    test('--goal-changed followed by a value is still the flag, not a refusal', async () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane' }, body: GOAL_A });
        const { code } = await save(['--name', 'lane', '--goal-changed', 'true', '--body-file', bodyFile('## Goal\nBuild a dashboard instead.\n')]);
        expect(code).toBeUndefined();
        expect(listActive(CWD, CHECKPOINT_DIR)[0]!.frontmatter.goal_changed).toBe(true);
    });

    test('--goal-changed with an unchanged goal is not recorded', async () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane' }, body: GOAL_A });
        await save(['--name', 'lane', '--goal-changed', '--body-file', bodyFile(GOAL_A)]);
        expect(listActive(CWD, CHECKPOINT_DIR)[0]!.frontmatter.goal_changed).toBeUndefined();
    });

    test('the anchor survives an in-session resume (archived, resumed): a paraphrase after compaction is still refused', async () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane' }, body: GOAL_A });
        captureStdout(() => verbResume(parseArgs(['resume', 'lane']), CWD, cfg));
        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(0);
        const { code, out } = await save(['--name', 'lane', '--body-file', bodyFile('## Goal\nShip the excavator demo (faking nothing), plus a dashboard.\n')]);
        expect(code).toBe(2);
        expect(out).toContain('Goal differs');
        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(0);
    });

    test('no Goal section in the new body, or no anchor in the lane: never refused', async () => {
        const first = await save(['--name', 'fresh', '--body-file', bodyFile('## Goal\nAnything\n')]);
        expect(first.code).toBeUndefined();
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane' }, body: GOAL_A });
        const legacy = await save(['--name', 'lane', '--body-file', bodyFile('## Status\n- no goal section here\n')]);
        expect(legacy.code).toBeUndefined();
    });

    // A session-id flag whose variable expanded to nothing arrives as an empty
    // string; stamping it would write a blank key that means nothing.
    test('an empty --session-id is treated as absent, not stamped blank', async () => {
        await save(['--name', 'lane', '--session-id', '', '--body-file', bodyFile('## Goal\nDo it\n')]);
        const active = listActive(CWD, CHECKPOINT_DIR)[0]!;
        expect(readCheckpoint(active.path)!.frontmatter.session_id).toBeUndefined();
    });

    // A `--continue` startup id has no transcript of its own; stamping it would
    // tie the file to a session id no hook will ever present.
    test('a --session-id whose transcript cannot be found is not stamped', async () => {
        const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-cfg-'));
        const prev = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = cfgDir;
        try {
            await save(['--name', 'lane', '--session-id', 'sid-x', '--body-file', bodyFile('## Goal\nG\n')]);
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
            fs.rmSync(cfgDir, { recursive: true, force: true });
        }
        expect(listActive(CWD, CHECKPOINT_DIR)[0]!.frontmatter.session_id).toBeUndefined();
    });

    test('with --session-id and no --transcript-path, meters.context_pct is captured from the session transcript', async () => {
        const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-cfg-'));
        const proj = path.join(cfgDir, 'projects', '-Users-x-proj');
        fs.mkdirSync(proj, { recursive: true });
        fs.writeFileSync(path.join(proj, 'sid-9.jsonl'), JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 50_000 } } }) + '\n');
        const prev = process.env.CLAUDE_CONFIG_DIR;
        // 50_000 / 200_000 = 25%, as long as the developer's own window
        // overrides stay out of it.
        const prevWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        process.env.CLAUDE_CONFIG_DIR = cfgDir;
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        try {
            await save(['--name', 'lane', '--session-id', 'sid-9', '--body-file', bodyFile('## Goal\nG\n')]);
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
            if (prevWindow !== undefined) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prevWindow;
        }
        const saved = listActive(CWD, CHECKPOINT_DIR)[0]!;
        expect(saved.frontmatter.session_id).toBe('sid-9');
        expect((saved.frontmatter.meters as Record<string, unknown>).context_pct).toBe(25);
    });
});

describe('save: lane from a linked worktree', () => {
    // The root is snapped to the MAIN repo, whose branch is not the one the
    // session is working on; the lane must follow the worktree's branch.
    function worktreeProject(): { proj: string; wt: string; cfgDir: string; sid: string } {
        fs.mkdirSync(FIXTURE_BASE, { recursive: true });
        const proj = fs.mkdtempSync(path.join(FIXTURE_BASE, 'lane-'));
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-lane-home-'));
        const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' };
        execFileSync('git', ['init', '-q', proj], { env });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: proj, env });
        const wt = path.join(proj, '.worktrees', 'wt');
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/wt', wt], { cwd: proj, env });
        const sid = 'sid-lane';
        const cfgDir = path.join(home, '.claude');
        fs.mkdirSync(path.join(cfgDir, 'projects', '-p'), { recursive: true });
        fs.writeFileSync(
            path.join(cfgDir, 'projects', '-p', `${sid}.jsonl`),
            JSON.stringify({ type: 'user', cwd: wt, sessionId: sid }) + '\n'
        );
        cleanups.push(proj, home);
        return { proj, wt, cfgDir, sid };
    }

    test('the lane is the worktree\'s branch, and the checkpoint lands at the main root', async () => {
        const { proj, cfgDir, sid } = worktreeProject();
        const body = path.join(proj, 'b.md');
        fs.writeFileSync(body, '## Goal\nShip it\n');
        const prev = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = cfgDir;
        try {
            await verbSave(parseArgs(['save', '--session-id', sid, '--body-file', body]), proj, cfg);
            const saved = listActive(proj, CHECKPOINT_DIR);
            expect(saved).toHaveLength(1);
            expect(saved[0]!.frontmatter.name).toBe('feat-wt');
            expect(saved[0]!.path.startsWith(proj)).toBe(true);

            // Second save from the same worktree: the anchor lane matches, so
            // the identical Goal is not refused as a lane mismatch.
            process.exitCode = 0;
            await verbSave(parseArgs(['save', '--session-id', sid, '--body-file', body]), proj, cfg);
            expect(process.exitCode).toBe(0);
            expect(listActive(proj, CHECKPOINT_DIR)[0]!.frontmatter.name).toBe('feat-wt');
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
        }
    });
});

describe('save: root anchored from the session transcript', () => {
    // SKILL.md promises the id alone is enough to anchor the checkpoint, so
    // main() must derive the transcript before resolving the root. Run from a
    // directory the resolver refuses, to prove the transcript is what saves it.
    test('with only --session-id, the checkpoint lands in the transcript cwd', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-anchor-home-'));
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-anchor-cwd-'));
        // The project must be a safe root, and everything under the tmpdir is
        // refused — so stage a throwaway repo beside this test file.
        fs.mkdirSync(FIXTURE_BASE, { recursive: true });
        const proj = fs.mkdtempSync(path.join(FIXTURE_BASE, 'anchor-'));
        try {
            execFileSync('git', ['init', '-q', '-b', 'main', proj]);
            const cfgDir = path.join(home, '.claude');
            fs.mkdirSync(path.join(cfgDir, 'projects', '-proj'), { recursive: true });
            fs.writeFileSync(
                path.join(cfgDir, 'projects', '-proj', 'sid-anchor.jsonl'),
                JSON.stringify({ type: 'user', cwd: proj, sessionId: 'sid-anchor' }) + '\n'
            );
            const body = path.join(home, 'b.md');
            fs.writeFileSync(body, '## Goal\nG\n');

            const res = spawnSync(
                'bun',
                ['run', '--silent', CLI, 'save', '--name', 'lane', '--session-id', 'sid-anchor', '--body-file', body],
                { cwd: elsewhere, encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfgDir } }
            );
            expect(res.status).toBe(0);
            expect(listActive(proj, CHECKPOINT_DIR)).toHaveLength(1);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
            fs.rmSync(elsewhere, { recursive: true, force: true });
            fs.rmSync(proj, { recursive: true, force: true });
        }
    });
});
