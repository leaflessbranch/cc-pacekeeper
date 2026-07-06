import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { saveCheckpoint, listActive, listArchive, readCheckpoint } from '../checkpoint';
import { DEFAULT_CONFIG } from '../config';
import { parseArgs, verbCleanup, verbDiscard, verbList, verbPeek, verbResume } from '../checkpoint-cli';

const CHECKPOINT_DIR = '.claude-checkpoints';
const cfg = DEFAULT_CONFIG;

let CWD: string;

beforeEach(() => {
    CWD = path.join(os.tmpdir(), `cc-pacekeeper-cli-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(CWD, { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* ignore */ }
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

    test('resumes by numeric index and records resumed_by_session', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane-a' }, body: '## Goal\nA\n' });

        captureStdout(() => verbResume(parseArgs(['resume', '1', '--session-id', 'sess-123']), CWD, cfg));

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
