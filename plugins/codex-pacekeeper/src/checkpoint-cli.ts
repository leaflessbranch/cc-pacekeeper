#!/usr/bin/env bun
/**
 * Checkpoint and handoff CLI for the Codex package. Verbs and semantics match
 * the Claude package's pacekeeper-checkpoint: any session in the project can
 * save to or resume a lane, `resume` prints and archives in one step, and
 * handoffs are keyed by agent id. Codex specifics: the thread id comes from
 * CODEX_THREAD_ID (exported to every tool shell), and a save registers the
 * post-reset wake itself, since Codex has no in-session cron for the model.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CodexCheckpoints, firstGoalLine, GoalChangedError, type CheckpointEntry, type CheckpointOwner, type SavedCheckpoint } from './checkpoint';
import { archiveHandoff, checkpointCliPath, listHandoffs, writeHandoff } from './agent-budget';
import { loadCodexConfig, type CodexConfig } from './config';
import { discoverNativeControlClient } from './live-sessions';
import { parseRateLimitsResponse, type NativeClient } from './native';
import { resolveProjectRoot, worktreeInfo } from './resolve-root';
import { findRolloutForThread, readRollout } from './rollout';
import { CodexService, type ScheduledWake } from './service';
import { ACCOUNT_IDENTITY, CodexStore } from './storage';
import { ensureService } from './tick';

interface ParsedArgs {
  verb: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(['archived', 'apply', 'goal-changed', 'help']);

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const equal = arg.indexOf('=');
    if (equal > 2) { flags[arg.slice(2, equal)] = arg.slice(equal + 1); continue; }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; }
    else flags[key] = true;
  }
  return { verb: positionals.shift() ?? 'help', positionals, flags };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function threadIdFrom(args: ParsedArgs): string | undefined {
  return stringFlag(args, 'thread-id') ?? (process.env['CODEX_THREAD_ID']?.trim() || undefined);
}

/** Provenance for save/resume: the thread is recorded, never required. */
function ownerFrom(args: ParsedArgs): CheckpointOwner {
  return { accountId: stringFlag(args, 'account-id') ?? null, threadId: threadIdFrom(args) ?? 'unknown' };
}

function bodyFrom(args: ParsedArgs, stdin: string): string {
  const direct = stringFlag(args, 'body');
  if (direct !== undefined) return direct;
  const bodyFile = stringFlag(args, 'body-file');
  if (bodyFile !== undefined) return fs.readFileSync(path.resolve(bodyFile), 'utf8');
  return stdin;
}

function gitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value === '' ? undefined : value;
  } catch { return undefined; }
}

export const BODY_TEMPLATE = [
  '## Goal',
  '<the user\'s request, quoted verbatim, plus at most one line of scope; on later saves in this lane copy it unchanged>',
  '',
  '## Status',
  '<what is done>',
  '',
  '## In flight',
  '<the exact step underway>',
  '',
  '## Next',
  '<the specific next action>',
  '',
  '## Open questions',
  '<anything blocked on the user>',
  '',
  '## References',
  '<plans, PRs, files>'
].join('\n');

function printUsage(): void {
  const cli = checkpointCliPath();
  process.stdout.write([
    `${cli} <save|list|peek|resume|discard|cleanup|handoffs|doctor>`,
    '',
    'save [--lane <name>] [--goal-changed] [--thread-id <id>] [--body <text>|--body-file <file>|stdin]',
    '     (no body: prints the template and exits 2; a verified save also registers the post-reset wake)',
    'list [--archived]',
    'peek <id|lane|N>',
    'resume [id|lane|N] [--thread-id <id>]   (prints the body and archives it)',
    'discard <id|lane|N>',
    'cleanup [--apply]',
    'handoffs list | write <agent_id> [--agent-type <t>] [--parent-thread-id <id>] | archive <agent_id>',
    'doctor   (environment checks: rollout, control socket, quota, keepalive service)',
    '',
    'The thread id defaults to $CODEX_THREAD_ID. Pass --cwd <project-root> if the project cannot be resolved.'
  ].join('\n') + '\n');
}

function projectRootFor(args: ParsedArgs): string {
  return resolveProjectRoot({ cwdFlag: stringFlag(args, 'cwd'), transcriptPath: stringFlag(args, 'transcript-path'), processCwd: process.cwd() });
}

export interface CheckpointProvenance {
  branch?: string;
  worktree: string;
}

/** Shared storage uses the main root; metadata follows the invoking checkout. */
export function invokingProvenance(cwd: string): CheckpointProvenance {
  const info = worktreeInfo(cwd);
  if (info?.worktreeRoot !== undefined) return { worktree: info.worktreeRoot, ...(info.branch ? { branch: info.branch } : {}) };
  return { worktree: path.resolve(cwd) };
}

export interface ResetEvidence {
  accountId: string;
  resetAtMs: number;
}

export interface SaveCheckpointWithResetWakeInput {
  checkpoints: CodexCheckpoints;
  service: CodexService;
  owner: CheckpointOwner;
  body: string;
  lane: string;
  worktree: string;
  branch?: string;
  goalChanged?: boolean;
  nowMs?: number;
  config?: CodexConfig;
  /** Test seam: replaces native/rollout reset discovery. */
  resetEvidence?: () => Promise<ResetEvidence | { withheld: string }>;
}

export interface SaveCheckpointWithResetWakeResult {
  checkpoint: SavedCheckpoint;
  wake: ScheduledWake | null;
  withheldReason?: string;
  /** The reset is known but the state directory was not writable (Codex's
   * sandbox); the Stop hook registers the wake from the saved checkpoint. */
  deferred?: boolean;
}

/**
 * The account and five-hour reset this save's wake should follow: the live
 * native read when the control socket hosts the thread, else the newest of
 * the account record and the thread's rollout. The service re-verifies the
 * account and a fresh post-reset reading before it delivers anything.
 */
export async function discoverResetEvidence(threadId: string, accountHint: string | null, nowMs: number, store = new CodexStore()): Promise<ResetEvidence | { withheld: string }> {
  let client: NativeClient | null = null;
  try { client = await discoverNativeControlClient(threadId, accountHint); } catch { client = null; }
  if (client !== null) {
    try {
      const limits = await client.readRateLimits();
      const five = limits.buckets.filter((bucket) => bucket.kind === 'five_hour');
      if (limits.accountId !== null && five.length === 1 && five[0]?.resetsAtMs !== null && five[0]?.resetsAtMs !== undefined && five[0].resetsAtMs > nowMs) {
        return { accountId: limits.accountId, resetAtMs: five[0].resetsAtMs };
      }
    } catch { /* fall back to recorded observations */ }
  }
  const account = store.read(ACCOUNT_IDENTITY, 'account') as Record<string, unknown> | null;
  const rollout = readRollout(findRolloutForThread(threadId), nowMs, threadId);
  const accountId = (typeof account?.['accountId'] === 'string' ? account['accountId'] : null) ?? accountHint ?? rollout.meta?.creatorAccountId ?? null;
  if (accountId === null) return { withheld: 'the account identity is unknown (no native read, account record or rollout metadata)' };
  const candidates: Array<{ at: number; resetAtMs: number | null }> = [];
  if (account?.['rateLimits'] !== undefined && typeof account['quotaObservedAtMs'] === 'number') {
    const parsed = parseRateLimitsResponse(account['rateLimits'], account['quotaObservedAtMs']);
    candidates.push({ at: account['quotaObservedAtMs'], resetAtMs: parsed.buckets.find((bucket) => bucket.kind === 'five_hour')?.resetsAtMs ?? null });
  }
  if (rollout.rateLimits !== null && rollout.rateLimitsObservedAtMs !== null) {
    const parsed = parseRateLimitsResponse(rollout.rateLimits, rollout.rateLimitsObservedAtMs);
    candidates.push({ at: rollout.rateLimitsObservedAtMs, resetAtMs: parsed.buckets.find((bucket) => bucket.kind === 'five_hour')?.resetsAtMs ?? null });
  }
  const newest = candidates.sort((a, b) => b.at - a.at)[0];
  if (newest === undefined || newest.resetAtMs === null) return { withheld: 'no five-hour reset time has been observed for this thread' };
  if (newest.resetAtMs <= nowMs) return { withheld: 'the observed five-hour reset has already passed' };
  return { accountId, resetAtMs: newest.resetAtMs };
}

/** Save, then register the post-reset wake when the reset is known. The
 * checkpoint survives any failure to register the wake. */
export async function saveCheckpointWithResetWake(input: SaveCheckpointWithResetWakeInput): Promise<SaveCheckpointWithResetWakeResult> {
  const nowMs = input.nowMs ?? Date.now();
  const config = input.config ?? input.service.config;
  let evidence: ResetEvidence | { withheld: string };
  if (input.owner.threadId === 'unknown') evidence = { withheld: 'no thread id (pass --thread-id or run inside Codex, which exports CODEX_THREAD_ID)' };
  else if (!config.auto.enabled) evidence = { withheld: 'auto-renewal is disabled in the configuration' };
  else {
    try { evidence = await (input.resetEvidence ?? (() => discoverResetEvidence(input.owner.threadId, input.owner.accountId, nowMs)))(); }
    catch { evidence = { withheld: 'reset discovery failed' }; }
  }
  const owner: CheckpointOwner = 'accountId' in evidence ? { ...input.owner, accountId: evidence.accountId } : input.owner;
  const checkpoint = input.checkpoints.save({
    lane: input.lane,
    owner,
    body: input.body,
    ...(input.branch ? { branch: input.branch } : {}),
    worktree: input.worktree,
    ...(input.goalChanged ? { goalChanged: true } : {}),
    ...('resetAtMs' in evidence ? { resetGeneration: evidence.resetAtMs } : {})
  });
  if ('withheld' in evidence) return { checkpoint, wake: null, withheldReason: evidence.withheld };
  try {
    return { checkpoint, wake: input.service.scheduleResetWake({ accountId: evidence.accountId, threadId: input.owner.threadId }, checkpoint.id, evidence.resetAtMs, evidence.resetAtMs) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const deferred = code === 'EROFS' || code === 'EACCES' || code === 'EPERM';
    return { checkpoint, wake: null, withheldReason: error instanceof Error ? error.message : 'reset wake registration failed', ...(deferred ? { deferred } : {}) };
  }
}

function ageLabel(savedAtMs: number): string {
  return `${((Date.now() - savedAtMs) / 86_400_000).toFixed(1)}d`;
}

function summaryLine(entry: CheckpointEntry, index: number): string {
  return `${index}. ${entry.lane} · ${entry.branch ?? '?'} · ${entry.worktree ?? '?'} · ${ageLabel(entry.savedAtMs)} · ${entry.id} · ${firstGoalLine(entry.body) ?? '(no goal)'}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.verb === 'help' || args.flags.help === true) { printUsage(); return; }
  if (args.verb === 'doctor') {
    const { runDoctorCli } = await import('./doctor-cli');
    const report = await runDoctorCli();
    const symbol: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✗', blocked: '✗', deferred: '–' };
    for (const check of report.checks) process.stdout.write(`${symbol[check.status]} ${check.name}: ${check.detail}\n`);
    process.stdout.write(`\noverall: ${report.overall}\n`);
    return;
  }
  const config = loadCodexConfig(process.env['XDG_CONFIG_HOME']).config;
  const root = projectRootFor(args);

  if (args.verb === 'handoffs') {
    const sub = args.positionals[0];
    if (sub === 'list') {
      const items = listHandoffs(root, config.checkpoint_dir_name, config.checkpoint_subdir, stringFlag(args, 'parent-thread-id'));
      if (items.length === 0) process.stdout.write('No pending handoffs.\n');
      for (const item of items) {
        process.stdout.write(`${item.frontmatter.agent_id} · ${item.frontmatter.agent_type ?? '?'} · ${item.frontmatter.trigger} · ${item.frontmatter.created_at} · ${item.path}\n${item.body}\n\n`);
      }
      return;
    }
    const agentId = args.positionals[1];
    if (!agentId) throw new Error(`handoffs ${sub ?? ''} requires an agent id`);
    if (sub === 'archive') {
      const archived = archiveHandoff(root, config.checkpoint_dir_name, agentId, config.checkpoint_subdir);
      if (!archived) throw new Error(`no pending handoff for ${agentId}`);
      process.stdout.write(`Archived handoff: ${archived}\n`);
      return;
    }
    if (sub === 'write') {
      const body = bodyFrom(args, await readStdin());
      const child = threadIdFrom(args);
      const parent = stringFlag(args, 'parent-thread-id');
      const target = writeHandoff({
        cwd: root,
        checkpointDirName: config.checkpoint_dir_name,
        checkpointSubdir: config.checkpoint_subdir,
        agentId,
        ...(stringFlag(args, 'agent-type') ? { agentType: stringFlag(args, 'agent-type') } : {}),
        trigger: stringFlag(args, 'trigger') ?? 'budget_pause',
        body,
        provenance: { ...(child ? { childThreadId: child } : {}), ...(parent ? { parentThreadId: parent } : {}) }
      });
      process.stdout.write(`Wrote handoff: ${target}\n`);
      return;
    }
    throw new Error('handoffs requires list, write or archive');
  }

  const checkpoints = new CodexCheckpoints(root, config);
  if (args.verb === 'save') {
    const body = bodyFrom(args, await readStdin());
    if (body.trim() === '') {
      process.stdout.write(`${BODY_TEMPLATE}\n`);
      process.exitCode = 2;
      return;
    }
    const provenance = invokingProvenance(stringFlag(args, 'cwd') ?? process.cwd());
    const branch = provenance.branch ?? gitValue(provenance.worktree, ['branch', '--show-current']);
    const service = new CodexService({ config, projectRoot: root });
    let result: SaveCheckpointWithResetWakeResult;
    try {
      result = await saveCheckpointWithResetWake({
        checkpoints,
        service,
        owner: ownerFrom(args),
        body,
        lane: stringFlag(args, 'lane') ?? stringFlag(args, 'name') ?? branch ?? 'default',
        ...(branch ? { branch } : {}),
        worktree: provenance.worktree,
        goalChanged: args.flags['goal-changed'] === true,
        config
      });
    } catch (error) {
      if (error instanceof GoalChangedError) {
        process.stderr.write(`${error.message}\n\nLane goal:\n${error.previousGoal}\n\nNew goal:\n${error.newGoal}\n`);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    process.stdout.write(`Saved checkpoint ${result.checkpoint.id} (lane ${result.checkpoint.lane}, ${result.checkpoint.file})\n`);
    if (result.wake !== null) {
      process.stdout.write(`Registered reset wake for ${new Date(result.wake.job.dueAtMs).toISOString()}\n`);
      ensureService(new CodexStore(), Date.now());
    } else if (result.deferred === true) {
      process.stdout.write(`Reset wake deferred to the end of this turn (${result.withheldReason ?? 'registration failed'})\n`);
    } else {
      process.stdout.write(`Reset wake withheld: ${result.withheldReason ?? 'unknown reason'}\n`);
    }
    return;
  }
  if (args.verb === 'list') {
    if (args.flags.archived === true) {
      const archived = checkpoints.listArchived().sort((a, b) => b.savedAtMs - a.savedAtMs);
      archived.forEach((entry, index) => process.stdout.write(`${summaryLine(entry, index + 1)} · ${entry.disposition ?? 'legacy'}\n`));
      if (archived.length === 0) process.stdout.write('No archived checkpoints.\n');
      return;
    }
    const active = checkpoints.listNewestFirst();
    active.forEach((entry, index) => process.stdout.write(`${summaryLine(entry, index + 1)}\n`));
    if (active.length === 0) process.stdout.write('No active checkpoints.\n');
    return;
  }
  if (args.verb === 'peek') {
    const selector = args.positionals[0];
    const entry = selector === undefined ? null : checkpoints.select(selector) ?? checkpoints.peek(selector);
    if (entry === null) throw new Error('peek requires an id, lane or list index of an existing checkpoint');
    process.stdout.write(`${entry.id} · lane ${entry.lane} · ${entry.branch ?? '?'} · saved ${new Date(entry.savedAtMs).toISOString()}\n\n${entry.body}\n`);
    return;
  }
  if (args.verb === 'resume') {
    const selector = args.positionals[0];
    const claimant = ownerFrom(args);
    let result;
    if (selector === undefined) {
      result = checkpoints.resumeLane(undefined, claimant);
    } else {
      const entry = checkpoints.select(selector);
      result = entry === null ? checkpoints.resume(selector, claimant) : checkpoints.resume(entry.id, claimant);
    }
    if (result.status === 'ambiguous') {
      process.stdout.write('Several lanes are active; nothing was archived. Choose one:\n');
      checkpoints.listNewestFirst().forEach((entry, index) => process.stdout.write(`${summaryLine(entry, index + 1)}\n`));
      process.stdout.write(`Then run: ${checkpointCliPath()} resume <lane or N>\n`);
      return;
    }
    if (result.status === 'already-consumed') {
      process.stdout.write('That checkpoint was already resumed; the work was picked up. Do not redo it.\n');
      return;
    }
    if (result.status !== 'resumed') throw new Error(`checkpoint ${result.status}`);
    process.stdout.write(`Resumed checkpoint ${result.id} (lane ${result.lane}); it is archived.\n\n${result.body}\n`);
    return;
  }
  if (args.verb === 'discard') {
    const selector = args.positionals[0];
    const entry = selector === undefined ? null : checkpoints.select(selector);
    if (entry === null) throw new Error('discard requires an id, lane or list index of an active checkpoint');
    const result = checkpoints.discard(entry.id);
    if (result.status !== 'resumed') throw new Error(`checkpoint ${result.status}`);
    process.stdout.write(`Discarded checkpoint ${result.id} (lane ${result.lane})${stringFlag(args, 'reason') ? `: ${stringFlag(args, 'reason')}` : ''}\n`);
    return;
  }
  if (args.verb === 'cleanup') {
    const result = checkpoints.cleanup(Date.now(), config.checkpoint.stale_after_days, config.checkpoint.archive_keep_days, args.flags.apply === true);
    process.stdout.write(`${result.applied ? 'Applied' : 'Dry run'}: ${result.stale.length} stale active checkpoint(s), ${result.expired.length} expired archive file(s).${result.applied ? '' : ' Re-run with --apply to act.'}\n`);
    return;
  }
  printUsage();
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`codex-pacekeeper checkpoint error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
