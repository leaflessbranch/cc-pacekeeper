import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isUnsafeRoot, projectRootFromTranscript, resolveProjectRoot, worktreeInfo } from '../resolve-root';

// Fixtures must live OUTSIDE the tmp roots and $HOME, since resolveProjectRoot
// refuses those. We stage them under the test file's own directory tree.
const FIXTURE_BASE = path.join(__dirname, '.root-fixtures');

let TMP: string;

beforeEach(() => {
    fs.mkdirSync(FIXTURE_BASE, { recursive: true });
    TMP = fs.mkdtempSync(path.join(FIXTURE_BASE, 'proj-'));
});

afterEach(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('isUnsafeRoot', () => {
    test('rejects /tmp, the tmpdir, $HOME, and /', () => {
        expect(isUnsafeRoot('/tmp')).toBe(true);
        expect(isUnsafeRoot('/')).toBe(true);
        expect(isUnsafeRoot(os.tmpdir())).toBe(true);
        expect(isUnsafeRoot(os.homedir())).toBe(true);
    });

    test('rejects paths directly under /tmp (checkpoints there vanish on reboot)', () => {
        expect(isUnsafeRoot('/tmp/whatever')).toBe(true);
        expect(isUnsafeRoot(path.join(os.tmpdir(), 'foo'))).toBe(true);
    });

    test('accepts a normal project directory', () => {
        expect(isUnsafeRoot('/home/someone/Projects/myrepo')).toBe(false);
    });

    test('trailing slashes and . segments do not defeat the guard', () => {
        expect(isUnsafeRoot('/tmp/')).toBe(true);
        expect(isUnsafeRoot('/tmp/./sub/..')).toBe(true);
    });
});

describe('projectRootFromTranscript', () => {
    test('reads the last recorded cwd from a transcript jsonl', () => {
        const tp = path.join(TMP, 'session.jsonl');
        const lines = [
            JSON.stringify({ type: 'summary' }),
            JSON.stringify({ type: 'user', cwd: '/home/x/Projects/repo', sessionId: 's' }),
            JSON.stringify({ type: 'assistant', cwd: '/home/x/Projects/repo', sessionId: 's' })
        ];
        fs.writeFileSync(tp, lines.join('\n') + '\n');
        expect(projectRootFromTranscript(tp)).toBe('/home/x/Projects/repo');
    });

    test('returns undefined when the transcript has no cwd field', () => {
        const tp = path.join(TMP, 'nocwd.jsonl');
        fs.writeFileSync(tp, JSON.stringify({ type: 'summary' }) + '\n');
        expect(projectRootFromTranscript(tp)).toBeUndefined();
    });

    test('returns undefined for a missing file', () => {
        expect(projectRootFromTranscript(path.join(TMP, 'does-not-exist.jsonl'))).toBeUndefined();
    });

    test('tolerates malformed json lines', () => {
        const tp = path.join(TMP, 'mixed.jsonl');
        fs.writeFileSync(tp, 'not json\n' + JSON.stringify({ cwd: '/home/x/repo' }) + '\n{ broken');
        expect(projectRootFromTranscript(tp)).toBe('/home/x/repo');
    });
});

describe('resolveProjectRoot', () => {
    function gitInit(dir: string): void {
        execFileSync('git', ['init', '-q'], { cwd: dir });
    }

    test('explicit cwd flag wins and is snapped to git root', () => {
        gitInit(TMP);
        const sub = path.join(TMP, 'packages', 'app');
        fs.mkdirSync(sub, { recursive: true });
        const root = resolveProjectRoot({ cwdFlag: sub, transcriptPath: undefined, processCwd: '/tmp' });
        expect(root).toBe(fs.realpathSync(TMP));
    });

    test('falls back to transcript cwd when no flag', () => {
        gitInit(TMP);
        const tp = path.join(TMP, 's.jsonl');
        fs.writeFileSync(tp, JSON.stringify({ cwd: TMP }) + '\n');
        // process.cwd intentionally /tmp to prove it is not used
        const root = resolveProjectRoot({ cwdFlag: undefined, transcriptPath: tp, processCwd: '/tmp' });
        expect(root).toBe(fs.realpathSync(TMP));
    });

    test('throws when nothing resolves to a safe dir', () => {
        expect(() => resolveProjectRoot({ cwdFlag: undefined, transcriptPath: undefined, processCwd: '/tmp' }))
            .toThrow(/refusing/i);
    });

    test('an unsafe --cwd flag falls through to the next safe candidate', () => {
        // Fat-fingered --cwd /tmp must not strand the checkpoint there; fall
        // through to the safe processCwd instead.
        gitInit(TMP);
        const root = resolveProjectRoot({ cwdFlag: '/tmp', transcriptPath: undefined, processCwd: TMP });
        expect(root).toBe(fs.realpathSync(TMP));
    });

    test('throws when every candidate is unsafe', () => {
        expect(() => resolveProjectRoot({ cwdFlag: '/tmp', transcriptPath: undefined, processCwd: '/tmp' }))
            .toThrow(/refusing/i);
    });

    test('process.cwd() is the last resort, snapped to its git root', () => {
        gitInit(TMP);
        const root = resolveProjectRoot({ cwdFlag: undefined, transcriptPath: undefined, processCwd: TMP });
        expect(root).toBe(fs.realpathSync(TMP));
    });

    test('a linked worktree resolves to the MAIN repo root, not the worktree', () => {
        gitInit(TMP);
        // A commit is required before `git worktree add` can create a branch.
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: TMP });
        const wt = path.join(TMP, '..', `wt-${path.basename(TMP)}`);
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: TMP });
        try {
            const root = resolveProjectRoot({ cwdFlag: wt, transcriptPath: undefined, processCwd: '/tmp' });
            expect(root).toBe(fs.realpathSync(TMP));
        } finally {
            execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: TMP });
        }
    });
});

describe('worktreeInfo', () => {
    function gitInit(dir: string): void {
        execFileSync('git', ['init', '-q'], { cwd: dir });
    }

    test('normal checkout: not a worktree, mainRoot == worktreeRoot', () => {
        gitInit(TMP);
        const info = worktreeInfo(TMP);
        expect(info?.isWorktree).toBe(false);
        expect(info?.mainRoot).toBe(fs.realpathSync(TMP));
    });

    test('linked worktree: flagged, mainRoot points at the main repo, branch captured', () => {
        gitInit(TMP);
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: TMP });
        const wt = path.join(TMP, '..', `wt2-${path.basename(TMP)}`);
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat-x', wt], { cwd: TMP });
        try {
            const info = worktreeInfo(wt);
            expect(info?.isWorktree).toBe(true);
            expect(info?.mainRoot).toBe(fs.realpathSync(TMP));
            expect(info?.worktreeRoot).toBe(fs.realpathSync(wt));
            expect(info?.branch).toBe('feat-x');
        } finally {
            execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: TMP });
        }
    });

    test('a truly non-git path returns undefined', () => {
        // Use the filesystem root's parent-less sentinel: a path with no repo
        // above it. os.tmpdir() is not under a git repo on CI/dev machines.
        expect(worktreeInfo(os.tmpdir())).toBeUndefined();
    });
});
