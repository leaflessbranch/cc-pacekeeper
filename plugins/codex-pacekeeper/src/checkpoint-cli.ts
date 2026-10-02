#!/usr/bin/env bun
/** Safe, exact-ID checkpoint and handoff CLI for the opt-in Codex package. */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CodexCheckpoints, type CheckpointOwner } from './checkpoint';
import type { SavedCheckpoint } from './checkpoint';
import { acknowledgeHandoff, archiveHandoff, checkpointCliPath, listHandoffs, writeHandoff, type HandoffOwnership, type HandoffScope } from './agent-budget';
import { loadCodexConfig } from './config';
import { discoverNativeControlClient } from './live-sessions';
import type { NativeClient } from './native';
import { resolveProjectRoot, worktreeInfo } from './resolve-root';
import { CodexService, type ScheduledWake } from './service';
import { CodexStore } from './storage';

interface ParsedArgs {
  verb: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const equal = arg.indexOf('=');
    if (equal > 2) {
      flags[arg.slice(2, equal)] = arg.slice(equal + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; }
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
  return typeof value === 'string' ? value : undefined;
}

function ownerFrom(args: ParsedArgs): CheckpointOwner {
  const account = stringFlag(args, 'account-id') ?? process.env['CODEX_ACCOUNT_ID'];
  const thread = stringFlag(args, 'thread-id') ?? process.env['CODEX_THREAD_ID'];
  if (!thread || thread.trim() === '') throw new Error('--thread-id or CODEX_THREAD_ID is required');
  const agentId = stringFlag(args, 'agent-id') ?? process.env['CODEX_AGENT_ID'];
  return { accountId: account && account.trim() !== '' ? account : null, threadId: thread, ...(agentId ? { agentId } : {}) };
}

function handoffScopeFrom(args: ParsedArgs): HandoffScope {
  const accountId = stringFlag(args, 'account-id') ?? process.env['CODEX_ACCOUNT_ID'];
  const parentThreadId = stringFlag(args, 'parent-thread-id') ?? process.env['CODEX_PARENT_THREAD_ID'];
  if (!accountId || accountId.trim() === '') throw new Error('handoffs requires --account-id');
  if (!parentThreadId || parentThreadId.trim() === '') throw new Error('handoffs requires --parent-thread-id');
  return { accountId, parentThreadId };
}

function handoffOwnershipFrom(args: ParsedArgs): HandoffOwnership {
  const scope = handoffScopeFrom(args);
  const owner = ownerFrom(args);
  if (owner.accountId !== scope.accountId) throw new Error('handoff account identity is inconsistent');
  return { ...scope, childThreadId: owner.threadId };
}

function hasNativeHandoffOwner(store: CodexStore, agentId: string, ownership: HandoffOwnership): boolean {
  const value = store.read({ accountId: ownership.accountId, threadId: ownership.childThreadId, agentId }, 'owner');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row['source'] === 'native-thread-parent'
    && row['accountId'] === ownership.accountId
    && row['childThreadId'] === ownership.childThreadId
    && row['parentThreadId'] === ownership.parentThreadId
    && row['agentId'] === agentId;
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

function selector(args: ParsedArgs, checkpoints: CodexCheckpoints): string | undefined {
  const value = args.positionals[0];
  if (value === undefined) return undefined;
  // IDs are the only stable selector. Numeric list positions and lane names
  // change as files are added or superseded and can resume the wrong work.
  return checkpoints.peek(value)?.id === value ? value : undefined;
}

function printUsage(): void {
  process.stdout.write([
    'pacekeeper-checkpoint <save|list|peek|claim|resume|ack|discard|cleanup|handoffs>',
    '',
    'save --thread-id <id> [--account-id <id>] [--body <text>|--body-file <file>]',
    'list [--archived]',
    'peek <checkpoint-id>',
    'claim <checkpoint-id> [--thread-id <id>]  (prints body and durable token; leaves file active)',
    'resume <checkpoint-id> [--thread-id <id>]  (alias for claim; ack is separate)',
    'ack <checkpoint-id> --token <token> --thread-id <id>',
    'discard <checkpoint-id> --thread-id <id>',
    'cleanup [--apply]',
    'handoffs list|write <agent-id>|ack <agent-id>|archive <agent-id>',
    '',
    `The model-facing handoff command is ${checkpointCliPath()}.`,
    'Project roots must be explicit safe project directories; state is kept in the Codex lane.'
  ].join('\n') + '\n');
}

function projectRootFor(args: ParsedArgs): string {
  return resolveProjectRoot({
    cwdFlag: stringFlag(args, 'cwd'),
    transcriptPath: stringFlag(args, 'transcript-path'),
    processCwd: process.cwd()
  });
}

export interface CheckpointProvenance {
  branch?: string;
  worktree: string;
}

/** Shared storage uses the main root; metadata follows the invoking checkout. */
export function invokingProvenance(cwd: string): CheckpointProvenance {
  const info = worktreeInfo(cwd);
  if (info?.worktreeRoot !== undefined) {
    return { worktree: info.worktreeRoot, ...(info.branch ? { branch: info.branch } : {}) };
  }
  return { worktree: path.resolve(cwd) };
}

export interface SaveCheckpointWithResetWakeInput {
  checkpoints: CodexCheckpoints;
  service: CodexService;
  owner: CheckpointOwner;
  body: string;
  lane: string;
  worktree: string;
  branch?: string;
  requestedResetGeneration?: number;
  nowMs?: number;
  resolveClient?: (threadId: string, accountId: string | null) => Promise<NativeClient | null>;
}

export interface SaveCheckpointWithResetWakeResult {
  checkpoint: SavedCheckpoint;
  wake: ScheduledWake | null;
  withheldReason?: string;
}

/** Save normally even when native reset evidence is unavailable; register a
 * wake only after an exact fresh owner and five-hour reset identity are read. */
export async function saveCheckpointWithResetWake(input: SaveCheckpointWithResetWakeInput): Promise<SaveCheckpointWithResetWakeResult> {
  let nowMs = input.nowMs ?? Date.now();
  let owner = input.owner;
  let observedResetAtMs: number | undefined;
  let withheldReason: string | undefined;
  let client: NativeClient | null = null;
  try {
    client = await (input.resolveClient ?? discoverNativeControlClient)(owner.threadId, owner.accountId);
    nowMs = input.nowMs ?? Date.now();
    const loadedAtMs = client?.owner.loadedThreadsObservedAtMs;
    if (client === null || !client.owner.threadIds.includes(owner.threadId)
      || loadedAtMs === undefined || !Number.isFinite(loadedAtMs) || loadedAtMs > nowMs || nowMs - loadedAtMs > 5_000) {
      withheldReason = 'native owner for this thread is unavailable';
    } else {
      const rateLimits = await client.readRateLimits();
      nowMs = input.nowMs ?? Date.now();
      if (rateLimits.accountId === null) {
        withheldReason = 'native account identity is unavailable';
      } else if (owner.accountId !== null && rateLimits.accountId !== owner.accountId) {
        withheldReason = 'native account does not match the requested checkpoint account';
      } else {
        owner = { ...owner, accountId: rateLimits.accountId };
        const fiveHour = rateLimits.buckets.filter((bucket) => bucket.kind === 'five_hour');
        const bucket = fiveHour[0];
        if (fiveHour.length !== 1 || bucket === undefined || !bucket.valid || bucket.usedPercent === null || bucket.resetsAtMs === null) {
          withheldReason = 'native five-hour reset identity is missing, invalid or ambiguous';
        } else if (bucket.resetsAtMs <= nowMs) {
          withheldReason = 'native five-hour reset has already passed';
        } else {
          observedResetAtMs = bucket.resetsAtMs;
        }
      }
    }
  } catch {
    withheldReason = 'native owner or rate-limit observation is unavailable';
  }

  const requestedResetMatches = input.requestedResetGeneration === undefined || input.requestedResetGeneration === observedResetAtMs;
  const resetGeneration = observedResetAtMs !== undefined && requestedResetMatches ? observedResetAtMs : undefined;
  const checkpoint = input.checkpoints.save({
    lane: input.lane,
    owner,
    body: input.body,
    ...(input.branch ? { branch: input.branch } : {}),
    worktree: input.worktree,
    ...(resetGeneration === undefined ? {} : { resetGeneration })
  });

  if (withheldReason === undefined && observedResetAtMs !== undefined) {
    if (!requestedResetMatches) {
      withheldReason = 'requested reset generation does not match the native reset identity';
    } else {
      try {
        return {
          checkpoint,
          wake: input.service.scheduleResetWake(owner, checkpoint.id, observedResetAtMs, observedResetAtMs)
        };
      } catch (error) {
        withheldReason = error instanceof Error ? error.message : 'reset wake registration failed';
      }
    }
  }
  return { checkpoint, wake: null, ...(withheldReason === undefined ? {} : { withheldReason }) };
}

function makeCheckpoints(args: ParsedArgs): CodexCheckpoints {
  const loaded = loadCodexConfig(process.env['XDG_CONFIG_HOME']);
  const root = projectRootFor(args);
  return new CodexCheckpoints(root, loaded.config);
}

function printEntry(entry: ReturnType<CodexCheckpoints['list']>[number], index?: number): void {
  const prefix = index === undefined ? '' : `${index}. `;
  process.stdout.write(`${prefix}${entry.id} lane=${entry.lane} thread=${entry.owner.threadId} saved=${new Date(entry.savedAtMs).toISOString()}\n${entry.body}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.verb === 'help' || args.verb === '--help') { printUsage(); return; }
  const loaded = loadCodexConfig(process.env['XDG_CONFIG_HOME']);
  if (args.verb === 'handoffs') {
    const root = resolveProjectRoot({ cwdFlag: stringFlag(args, 'cwd'), processCwd: process.cwd() });
    const store = new CodexStore();
    const sub = args.positionals[0];
    if (sub === 'list') {
      const scope = handoffScopeFrom(args);
      const childThreadId = stringFlag(args, 'thread-id') ?? process.env['CODEX_THREAD_ID'];
      const items = listHandoffs(root, loaded.config.checkpoint_dir_name, loaded.config.checkpoint_subdir, scope)
        .filter((item) => childThreadId === undefined || item.frontmatter.child_thread_id === childThreadId)
        .filter((item) => {
          const child = item.frontmatter.child_thread_id;
          if (child === undefined) return false;
          const ownership: HandoffOwnership = { ...scope, childThreadId: child };
          return hasNativeHandoffOwner(store, item.frontmatter.agent_id, ownership);
        });
      if (items.length === 0) process.stdout.write('No pending handoffs.\n');
      else for (const item of items) process.stdout.write(`${item.frontmatter.agent_id} child=${item.frontmatter.child_thread_id ?? '?'} received=${item.frontmatter.acknowledged_at ? 'yes' : 'no'} ${item.path}\n${item.body}\n`);
      return;
    }
    const agentId = args.positionals[1];
    if (!agentId) throw new Error('handoffs requires an agent id');
    const ownership = handoffOwnershipFrom(args);
    if (!hasNativeHandoffOwner(store, agentId, ownership)) throw new Error('handoff has no matching native account and parent mapping');
    if (sub === 'ack') {
      const acknowledgement = acknowledgeHandoff(root, loaded.config.checkpoint_dir_name, agentId, ownership, loaded.config.checkpoint_subdir);
      if (acknowledgement === null) throw new Error('handoff was not found for this account, parent and child');
      process.stdout.write(`${acknowledgement.status === 'already-acknowledged' ? 'Already acknowledged' : 'Acknowledged'} handoff: ${acknowledgement.path}\n`);
      return;
    }
    if (sub === 'archive') {
      const archived = archiveHandoff(root, loaded.config.checkpoint_dir_name, agentId, loaded.config.checkpoint_subdir, ownership);
      if (!archived) throw new Error('handoff must be acknowledged for this account, parent and child before archive');
      process.stdout.write(`Archived handoff: ${archived}\n`);
      return;
    }
    if (sub === 'write') {
      const body = bodyFrom(args, await readStdin());
      const target = writeHandoff({ cwd: root, checkpointDirName: loaded.config.checkpoint_dir_name, checkpointSubdir: loaded.config.checkpoint_subdir, agentId, agentType: stringFlag(args, 'agent-type'), trigger: stringFlag(args, 'trigger') ?? 'budget_pause', body, ownership });
      process.stdout.write(`Wrote handoff: ${target}\n`);
      return;
    }
    throw new Error('handoffs requires list, write or archive');
  }

  const checkpoints = makeCheckpoints(args);
  if (args.verb === 'save') {
    const body = bodyFrom(args, await readStdin());
    if (body.trim() === '') throw new Error('save requires --body, --body-file or piped content');
    const owner = ownerFrom(args);
    const root = projectRootFor(args);
    const provenance = invokingProvenance(stringFlag(args, 'cwd') ?? process.cwd());
    const branch = stringFlag(args, 'branch') ?? provenance.branch ?? gitValue(provenance.worktree, ['branch', '--show-current']);
    const requestedResetGeneration = stringFlag(args, 'reset-generation');
    const loaded = loadCodexConfig(process.env['XDG_CONFIG_HOME']);
    const service = new CodexService({ config: loaded.config, projectRoot: root });
    const result = await saveCheckpointWithResetWake({
      checkpoints,
      service,
      owner,
      body,
      lane: stringFlag(args, 'lane') ?? branch ?? 'default',
      ...(branch ? { branch } : {}),
      worktree: provenance.worktree,
      ...(requestedResetGeneration === undefined ? {} : { requestedResetGeneration: Number(requestedResetGeneration) })
    });
    process.stdout.write(`Saved checkpoint ${result.checkpoint.id} (${result.checkpoint.file})\n`);
    if (result.wake !== null) process.stdout.write(`Registered reset wake for ${result.wake.job.dueAtMs}\n`);
    else process.stdout.write(`Reset wake withheld: ${result.withheldReason ?? 'native reset identity is unavailable'}\n`);
    return;
  }
  if (args.verb === 'list') {
    const entries = args.flags.archived === true ? checkpoints.listArchived() : checkpoints.list();
    entries.forEach((entry, index) => printEntry(entry, index + 1));
    if (entries.length === 0) process.stdout.write('No checkpoints.\n');
    return;
  }
  if (args.verb === 'peek') {
    const id = selector(args, checkpoints);
    if (!id) throw new Error('peek requires an exact checkpoint id');
    const entry = checkpoints.peek(id);
    if (!entry) throw new Error('checkpoint not found');
    printEntry(entry);
    return;
  }
  if (args.verb === 'claim' || args.verb === 'resume') {
    const id = selector(args, checkpoints);
    if (!id) throw new Error(`${args.verb} requires an exact checkpoint id; use list first`);
    const result = checkpoints.claim(id, ownerFrom(args));
    if (!('id' in result) || !('token' in result)) throw new Error(`checkpoint ${result.status}`);
    // The active file and claim survive a broken pipe or consumer crash. The
    // caller must explicitly invoke ack with this token after receipt.
    process.stdout.write(JSON.stringify({ status: result.status, id: result.id, lane: result.lane, token: result.token, body: result.body }) + '\n');
    return;
  }
  if (args.verb === 'ack') {
    const id = selector(args, checkpoints);
    const token = stringFlag(args, 'token');
    if (!id || !token) throw new Error('ack requires an exact checkpoint id and --token');
    const result = checkpoints.acknowledge(id, token, ownerFrom(args));
    if (result.status !== 'resumed' && result.status !== 'already-consumed') throw new Error(`checkpoint ${result.status}`);
    process.stdout.write(`${result.status === 'already-consumed' ? 'Already consumed' : 'Acknowledged'} checkpoint ${id}\n`);
    return;
  }
  if (args.verb === 'discard') {
    const id = selector(args, checkpoints);
    if (!id) throw new Error('discard requires an exact checkpoint id; use list first');
    const result = checkpoints.discard(id, ownerFrom(args));
    if (result.status !== 'resumed') throw new Error(`checkpoint ${result.status}`);
    process.stdout.write(`Discarded checkpoint ${result.id}\n${result.body}\n`);
    return;
  }
  if (args.verb === 'cleanup') {
    const result = checkpoints.cleanup(Date.now(), loaded.config.checkpoint.stale_after_days, loaded.config.checkpoint.archive_keep_days, args.flags.apply === true);
    process.stdout.write(JSON.stringify(result) + '\n');
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
