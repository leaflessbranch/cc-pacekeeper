import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isUnsafeRoot, lookupRoot, projectRootFromTranscript, resolveProjectRoot, transcriptPathForSession, worktreeInfo } from '../resolve-root';

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

    test('symlinked tmp (e.g. macOS /tmp → /private/tmp) is still unsafe', () => {
        expect(isUnsafeRoot(fs.realpathSync(os.tmpdir()))).toBe(true);
        expect(isUnsafeRoot(fs.realpathSync('/tmp'))).toBe(true);
    });

    test('multi-level missing paths under symlinked tmp are still unsafe', () => {
        expect(isUnsafeRoot('/tmp/pace-missing-a/b/c')).toBe(true);
        expect(isUnsafeRoot(path.join(os.tmpdir(), 'pace-missing-x', 'y'))).toBe(true);
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

describe('lookupRoot', () => {
    /** A throwaway HOME so git never reads the developer's global config. */
    const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-git-home-'));
    afterAll(() => { try { fs.rmSync(GIT_HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

    /** Keep git off the developer's own ~/.gitconfig (gpg signing, hooksPath). */
    function gitEnv(): NodeJS.ProcessEnv {
        return { ...process.env, HOME: GIT_HOME, GIT_CONFIG_GLOBAL: '/dev/null' };
    }

    test('a linked worktree resolves to the main repo root; a plain dir resolves to itself', () => {
        const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-plain-'));
        execFileSync('git', ['init', '-q'], { cwd: TMP, env: gitEnv() });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: TMP, env: gitEnv() });
        const wt = path.join(TMP, '.worktrees', 'wt');
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', wt], { cwd: TMP, env: gitEnv() });
        try {
            expect(lookupRoot(wt)).toBe(fs.realpathSync(TMP));
            expect(lookupRoot(TMP)).toBe(fs.realpathSync(TMP));
            // A dir in no repo resolves to itself (verbatim: under the tmpdir
            // the unsafe-root guard returns the cwd before any realpath).
            expect(lookupRoot(plain)).toBe(plain);
        } finally {
            execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: TMP, env: gitEnv() });
            fs.rmSync(plain, { recursive: true, force: true });
        }
    });

    // The CLI refuses to save at an unsafe root, so the tick must not look
    // there either — it would surface another project's checkpoints.
    test('an unsafe repo root (directly under the tmpdir) falls back to the cwd', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-unsafe-'));
        const sub = path.join(repo, 'sub');
        fs.mkdirSync(sub);
        try {
            execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv() });
            expect(lookupRoot(sub)).toBe(sub);
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    // The safe-root path returns through realpath, so a symlinked input comes
    // back canonical — the tmpdir case above short-circuits at the unsafe
    // guard and never reaches that line.
    test('a safe root is returned realpath-resolved, even reached through a symlink', () => {
        execFileSync('git', ['init', '-q'], { cwd: TMP, env: gitEnv() });
        const link = path.join(FIXTURE_BASE, `link-${path.basename(TMP)}`);
        fs.symlinkSync(TMP, link);
        try {
            expect(lookupRoot(link)).toBe(fs.realpathSync(TMP));
        } finally {
            fs.unlinkSync(link);
        }
    });

    test('never throws on a nonexistent dir', () => {
        expect(lookupRoot('/nonexistent/dir')).toBe('/nonexistent/dir');
    });
});

describe('transcriptPathForSession', () => {
    test('finds <configDir>/projects/*/<sid>.jsonl, newest mtime first; undefined when absent', () => {
        const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-cfg-'));
        expect(transcriptPathForSession('sid-1', cfgDir)).toBeUndefined();
        const a = path.join(cfgDir, 'projects', '-Users-x-a');
        const b = path.join(cfgDir, 'projects', '-Users-x-b');
        fs.mkdirSync(a, { recursive: true });
        fs.mkdirSync(b, { recursive: true });
        fs.writeFileSync(path.join(a, 'sid-1.jsonl'), '{}\n');
        fs.writeFileSync(path.join(b, 'sid-1.jsonl'), '{}\n');
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(a, 'sid-1.jsonl'), old, old);
        expect(transcriptPathForSession('sid-1', cfgDir)).toBe(path.join(b, 'sid-1.jsonl'));
        expect(transcriptPathForSession('other', cfgDir)).toBeUndefined();
        fs.rmSync(cfgDir, { recursive: true, force: true });
    });
});
