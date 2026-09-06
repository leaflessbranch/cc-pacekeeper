#!/usr/bin/env bun
/** Git worktree helpers with conservative cleanup and Codex owner liveness. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { listLiveOwners } from './live-sessions';
import { resolveProjectRoot } from './resolve-root';

export interface WorktreeRow {
  path: string;
  branch?: string;
  head?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  dirty: boolean | null;
  liveOwners: number | null;
}

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

function status(cwd: string): string | null {
  try { return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export function parseWorktreePorcelain(output: string): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  let current: Partial<WorktreeRow> | null = null;
  const flush = (): void => {
    if (current?.path) {
      rows.push({ path: current.path, branch: current.branch, head: current.head, bare: current.bare ?? false, detached: current.detached ?? false, locked: current.locked ?? false, dirty: null, liveOwners: null });
    }
    current = null;
  };
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) { flush(); current = { path: line.slice(9) }; }
    else if (line.startsWith('HEAD ') && current) current.head = line.slice(5);
    else if (line.startsWith('branch ') && current) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare' && current) current.bare = true;
    else if (line === 'detached' && current) current.detached = true;
    else if (line === 'locked' || line.startsWith('locked ') || line.startsWith('locked\t')) if (current) current.locked = true;
  }
  flush();
  return rows;
}

function canonical(input: string): string {
  try { return fs.realpathSync(input); } catch { return path.resolve(input); }
}

function assertSafeDestination(root: string, target: string): void {
  const base = canonical(root);
  const absolute = path.resolve(target);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    throw new Error('worktree destination escapes the repository root');
  }
  let cursor = base;
  for (const component of path.relative(base, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('worktree destination contains a symlink');
    } catch (error) {
      if (error instanceof Error && error.message.includes('contains a symlink')) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error('worktree destination could not be inspected');
    }
  }
}

export interface WorktreeListOptions {
  cwd: string;
  ownerRegistryFile?: string;
}

export function listWorktrees(options: WorktreeListOptions): WorktreeRow[] | null {
  const output = git(options.cwd, ['worktree', 'list', '--porcelain']);
  if (output === null) return null;
  const owners = listLiveOwners(options.ownerRegistryFile);
  const rows = parseWorktreePorcelain(output);
  for (const row of rows) {
    if (row.bare) { row.dirty = false; row.liveOwners = 0; continue; }
    const cleanStatus = status(row.path);
    row.dirty = cleanStatus === null ? null : cleanStatus.length > 0;
    if (owners === null) row.liveOwners = null;
    else if (owners.some((owner) => owner.cwd === undefined)) row.liveOwners = null;
    else row.liveOwners = owners.filter((owner) => owner.cwd !== undefined && canonical(owner.cwd) === canonical(row.path)).length;
  }
  return rows;
}

function safeBranch(value: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.startsWith('/') || value.endsWith('/')) throw new Error('branch must be a safe relative git name');
  return value;
}

export function createWorktree(cwd: string, name: string, branch = `worktree-${name}`): string {
  const safeName = safeBranch(name).replaceAll('/', '-');
  const safeBranchName = safeBranch(branch);
  const root = canonical(cwd);
  const target = path.join(root, '.codex-worktrees', safeName);
  assertSafeDestination(root, path.join(root, '.codex-worktrees'));
  assertSafeDestination(root, target);
  if (fs.existsSync(target)) throw new Error('worktree destination already exists');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertSafeDestination(root, target);
  const result = git(cwd, ['worktree', 'add', '-b', safeBranchName, target]);
  if (result === null) throw new Error('git worktree add failed');
  return target;
}

export interface CleanupDecision {
  path: string;
  removable: boolean;
  reason: string;
}

export function cleanupDecision(row: WorktreeRow, currentCwd: string): CleanupDecision {
  if (canonical(row.path) === canonical(currentCwd)) return { path: row.path, removable: false, reason: 'current worktree' };
  if (row.bare) return { path: row.path, removable: false, reason: 'bare repository' };
  if (row.locked) return { path: row.path, removable: false, reason: 'worktree is locked' };
  if (row.dirty === null) return { path: row.path, removable: false, reason: 'git status was unavailable' };
  if (row.dirty) return { path: row.path, removable: false, reason: 'worktree is dirty' };
  if (row.liveOwners === null) return { path: row.path, removable: false, reason: 'owner liveness is unknown' };
  if (row.liveOwners > 0) return { path: row.path, removable: false, reason: 'a live Codex owner is using the worktree' };
  return { path: row.path, removable: true, reason: 'clean, unlocked and idle' };
}

export function cleanupWorktrees(options: WorktreeListOptions & { apply?: boolean; currentCwd?: string }): CleanupDecision[] {
  const rows = listWorktrees(options);
  if (rows === null) throw new Error('not a git repository');
  const decisions = rows.map((row) => cleanupDecision(row, options.currentCwd ?? options.cwd));
  if (options.apply === true) {
    for (const decision of decisions) {
      if (!decision.removable) continue;
      // Re-read ownership and Git state immediately before a destructive
      // remove; a session can attach after the initial list.
      const latest = listWorktrees(options)?.find((row) => canonical(row.path) === canonical(decision.path));
      const current = latest ? cleanupDecision(latest, options.currentCwd ?? options.cwd) : undefined;
      if (!current?.removable) {
        decision.removable = false;
        decision.reason = current?.reason ?? 'worktree disappeared before cleanup';
        continue;
      }
      assertSafeDestination(options.cwd, decision.path);
      const result = git(options.cwd, ['worktree', 'remove', decision.path]);
      if (result === null) decision.removable = false;
    }
    git(options.cwd, ['worktree', 'prune']);
  }
  return decisions;
}

function main(): void {
  const [verb = 'list', value] = process.argv.slice(2);
  const cwdFlagIndex = process.argv.findIndex((arg) => arg === '--cwd');
  const cwdFlag = cwdFlagIndex >= 0 ? process.argv[cwdFlagIndex + 1] : undefined;
  const cwd = resolveProjectRoot({
    cwdFlag,
    processCwd: process.cwd(),
    allowUnsafe: process.env['CODEX_PACEKEEPER_ALLOW_UNSAFE_ROOT'] === '1'
  });
  if (verb === 'list') {
    const rows = listWorktrees({ cwd });
    process.stdout.write(JSON.stringify({ worktrees: rows ?? [], ...(rows === null ? { error: 'not a git repository' } : {}) }, null, 2) + '\n');
    return;
  }
  if (verb === 'new') { process.stdout.write(`${createWorktree(cwd, value ?? 'scratch')}\n`); return; }
  if (verb === 'cleanup') {
    const apply = process.argv.includes('--apply');
    process.stdout.write(JSON.stringify(cleanupWorktrees({ cwd, apply }), null, 2) + '\n');
    return;
  }
  process.stderr.write('usage: pacekeeper-worktrees list|new <name>|cleanup [--apply]\n');
  process.exitCode = 1;
}

if (import.meta.main) main();
