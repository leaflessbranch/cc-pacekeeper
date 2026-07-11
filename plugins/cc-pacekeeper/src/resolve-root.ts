import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Resolve the project root that checkpoints belong to, robustly — independent
 * of whatever shell, tmux pane, or `cd` the CLI was invoked from.
 *
 * Why this exists: the checkpoint CLI used to trust `process.cwd()` alone. If
 * the body file was staged in /tmp (as the skill once suggested) and `save`
 * ran from there, checkpoints landed in /tmp/.claude-checkpoints/ — lost on
 * reboot and invisible to a fresh session resuming from the real project root.
 *
 * Resolution chain (first that yields a *safe* dir wins):
 *   1. --cwd flag                       (explicit; caller knows best)
 *   2. transcript's recorded cwd        (harness truth; survives shell drift)
 *   3. git toplevel of the chosen dir   (pin to repo root)
 *   4. process.cwd()                    (last resort)
 * The result is snapped to the git repo root when one exists, and refused
 * outright if it resolves to a transient dir (/tmp, $TMPDIR, $HOME, /).
 */

/**
 * realpath for comparisons — resolves symlinks even for paths that don't
 * exist yet by climbing to the nearest existing ancestor, realpathing it,
 * and re-appending the missing suffix. Plain resolve only if nothing on the
 * path exists at all.
 */
function realOrResolve(p: string): string {
    const resolved = path.resolve(p);
    let base = resolved;
    const missing: string[] = [];
    while (!fs.existsSync(base)) {
        const parent = path.dirname(base);
        if (parent === base) return resolved; // hit fs root; nothing exists
        missing.unshift(path.basename(base));
        base = parent;
    }
    try {
        return path.join(fs.realpathSync(base), ...missing);
    } catch {
        return resolved;
    }
}

/**
 * Dirs we refuse to write checkpoints into: transient (vanish on reboot) or
 * too broad to be a real project. Matches the dir itself and anything beneath
 * the tmp roots.
 */
export function isUnsafeRoot(dir: string): boolean {
    const resolved = realOrResolve(dir);
    const tmpRoots = [os.tmpdir(), '/tmp'].map(realOrResolve);
    for (const t of tmpRoots) {
        if (resolved === t || resolved.startsWith(t + path.sep)) return true;
    }
    const exact = [os.homedir(), path.parse(resolved).root].map(realOrResolve);
    return exact.includes(resolved);
}

/**
 * Read the last `cwd` recorded in a Claude Code transcript JSONL. This is the
 * session's real working directory as the harness knows it — the strongest
 * anchor available, because the skill already passes --transcript-path.
 */
export function projectRootFromTranscript(transcriptPath: string): string | undefined {
    let raw: string;
    try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return undefined; }
    let found: string | undefined;
    for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
            const obj = JSON.parse(line) as { cwd?: unknown };
            if (typeof obj.cwd === 'string' && obj.cwd !== '') found = obj.cwd;
        } catch { /* tolerate malformed lines */ }
    }
    return found;
}

function gitExec(dir: string, args: string[]): string | undefined {
    try {
        const out = execFileSync('git', args, {
            cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        return out || undefined;
    } catch {
        return undefined;
    }
}

/**
 * The repo root that owns checkpoints for `dir`. For a normal checkout this is
 * `--show-toplevel`. For a *linked worktree*, checkpoints belong with the main
 * repo, not the worktree: `--git-common-dir` resolves to `<main>/.git`, whose
 * parent is the main working tree. We detect a linked worktree by comparing the
 * per-worktree git dir (`--git-dir`) against the common dir — they differ only
 * in a linked worktree.
 */
function gitToplevel(dir: string): string | undefined {
    const toplevel = gitExec(dir, ['rev-parse', '--show-toplevel']);
    if (!toplevel) return undefined;
    const info = worktreeInfo(dir);
    if (info?.isWorktree && info.mainRoot) return info.mainRoot;
    return toplevel;
}

export interface WorktreeInfo {
    isWorktree: boolean;
    /** Working directory of this worktree (linked or main). */
    worktreeRoot?: string;
    /** Main repo working tree — same as worktreeRoot for a normal checkout. */
    mainRoot?: string;
    branch?: string;
}

/**
 * Describe the git worktree situation for `dir`, or undefined if `dir` is not
 * in a git repo. Used both for checkpoint anchoring and for provenance
 * frontmatter so a resume can re-enter the originating worktree.
 */
export function worktreeInfo(dir: string): WorktreeInfo | undefined {
    const toplevel = gitExec(dir, ['rev-parse', '--show-toplevel']);
    if (!toplevel) return undefined;
    const gitDir = gitExec(dir, ['rev-parse', '--absolute-git-dir']);
    const commonDir = gitExec(dir, ['rev-parse', '--git-common-dir']);
    const branch = gitExec(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

    // `--git-common-dir` may be relative (e.g. ".git") — resolve it against the
    // queried dir, not process.cwd().
    let commonAbs: string | undefined;
    if (commonDir) {
        const abs = path.isAbsolute(commonDir) ? commonDir : path.resolve(dir, commonDir);
        try { commonAbs = fs.realpathSync(abs); }
        catch { commonAbs = abs; }
    }
    // Linked worktree ⇔ this worktree's git dir differs from the common dir.
    const isWorktree = !!(gitDir && commonAbs && path.resolve(gitDir) !== commonAbs);
    const mainRoot = isWorktree && commonAbs ? path.dirname(commonAbs) : toplevel;

    return {
        isWorktree,
        worktreeRoot: toplevel,
        mainRoot,
        ...(branch && branch !== 'HEAD' ? { branch } : {})
    };
}

export interface ResolveInput {
    cwdFlag?: string;
    transcriptPath?: string;
    processCwd: string;
}

export function resolveProjectRoot(input: ResolveInput): string {
    const candidates: string[] = [];
    if (input.cwdFlag) candidates.push(input.cwdFlag);
    if (input.transcriptPath) {
        const t = projectRootFromTranscript(input.transcriptPath);
        if (t) candidates.push(t);
    }
    candidates.push(input.processCwd);

    for (const cand of candidates) {
        if (!cand) continue;
        let dir: string;
        try { dir = fs.existsSync(cand) ? fs.realpathSync(cand) : path.resolve(cand); }
        catch { dir = path.resolve(cand); }
        // Snap to the git repo root when the candidate is inside one.
        const root = gitToplevel(dir) ?? dir;
        if (!isUnsafeRoot(root)) return root;
    }

    throw new Error(
        'cc-pacekeeper: refusing to write checkpoint — could not resolve a safe project ' +
        'directory (only transient dirs like /tmp, $HOME, or / were available). ' +
        'Re-invoke with --cwd <project-root>.'
    );
}
