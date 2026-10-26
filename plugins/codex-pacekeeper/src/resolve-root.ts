/** Resolve a project root for checkpoint and worktree commands. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function realOrResolve(input: string): string {
  const resolved = path.resolve(input);
  let cursor = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  try { return path.join(fs.realpathSync(cursor), ...missing); } catch { return resolved; }
}

export function isUnsafeRoot(input: string): boolean {
  const root = realOrResolve(input);
  const transient = [realOrResolve(os.tmpdir()), realOrResolve('/tmp')];
  if (transient.some((candidate) => root === candidate || root.startsWith(candidate + path.sep))) return true;
  return [realOrResolve(os.homedir()), path.parse(root).root].includes(root);
}

function git(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return output || null;
  } catch { return null; }
}

export function projectRootFromTranscript(file: string): string | null {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let found: string | null = null;
  for (const line of raw.split('\n')) {
    try {
      const value = JSON.parse(line) as { cwd?: unknown };
      if (typeof value.cwd === 'string' && value.cwd !== '') found = value.cwd;
    } catch { /* tolerate a partially written transcript */ }
  }
  return found;
}

export interface WorktreeInfo {
  isWorktree: boolean;
  worktreeRoot?: string;
  mainRoot?: string;
  branch?: string;
}

/** Describe the checkout without mutating Git metadata. */
export function worktreeInfo(dir: string): WorktreeInfo | undefined {
  const toplevel = git(dir, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return undefined;
  const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']);
  const commonDir = git(dir, ['rev-parse', '--git-common-dir']);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let commonAbs: string | undefined;
  if (commonDir) {
    const candidate = path.isAbsolute(commonDir) ? commonDir : path.resolve(dir, commonDir);
    commonAbs = realOrResolve(candidate);
  }
  const isWorktree = gitDir !== null && commonAbs !== undefined && realOrResolve(gitDir) !== commonAbs;
  const mainRoot = isWorktree && commonAbs ? realOrResolve(path.dirname(commonAbs)) : realOrResolve(toplevel);
  return {
    isWorktree,
    worktreeRoot: realOrResolve(toplevel),
    mainRoot,
    ...(branch && branch !== 'HEAD' ? { branch } : {})
  };
}

function repoRoot(candidate: string): string {
  const info = worktreeInfo(candidate);
  return info?.mainRoot ?? realOrResolve(candidate);
}

export interface ResolveRootInput {
  cwdFlag?: string;
  transcriptPath?: string;
  processCwd?: string;
  /** Test-only escape hatch for roots known to be disposable. */
  allowUnsafe?: boolean;
}

export function resolveProjectRoot(input: ResolveRootInput = {}): string {
  // An explicit root is an authorization boundary. If it is unsafe, fail at
  // that boundary instead of silently falling through to process.cwd(), which
  // may be a different checkout and could receive an unintended checkpoint.
  if (input.cwdFlag !== undefined && input.cwdFlag !== '') {
    const explicitRoot = repoRoot(input.cwdFlag);
    if (input.allowUnsafe !== true && isUnsafeRoot(explicitRoot)) {
      throw new Error('refusing checkpoint writes: explicit project root is unsafe');
    }
  }
  const transcriptRoot = input.transcriptPath ? projectRootFromTranscript(input.transcriptPath) : null;
  if (transcriptRoot && input.allowUnsafe !== true && isUnsafeRoot(repoRoot(transcriptRoot))) {
    throw new Error('refusing checkpoint writes: transcript project root is unsafe');
  }
  const candidates: string[] = [];
  if (input.cwdFlag) candidates.push(input.cwdFlag);
  if (transcriptRoot) candidates.push(transcriptRoot);
  candidates.push(input.processCwd ?? process.cwd());
  for (const candidate of candidates) {
    if (!candidate) continue;
    const root = repoRoot(candidate);
    if (input.allowUnsafe === true || !isUnsafeRoot(root)) return root;
  }
  throw new Error('refusing checkpoint writes: no safe project root was found; pass --cwd to a project directory');
}
