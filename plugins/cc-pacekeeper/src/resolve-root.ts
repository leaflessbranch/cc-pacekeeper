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
 * Dirs we refuse to write checkpoints into: transient (vanish on reboot) or
 * too broad to be a real project. Matches the dir itself and anything beneath
 * the tmp roots.
 */
export function isUnsafeRoot(dir: string): boolean {
    const resolved = path.resolve(dir);
    const tmpRoots = [os.tmpdir(), '/tmp'].map(d => path.resolve(d));
    for (const t of tmpRoots) {
        if (resolved === t || resolved.startsWith(t + path.sep)) return true;
    }
    const exact = [os.homedir(), path.parse(resolved).root].map(d => path.resolve(d));
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

function gitToplevel(dir: string): string | undefined {
    try {
        const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        return out || undefined;
    } catch {
        return undefined;
    }
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
