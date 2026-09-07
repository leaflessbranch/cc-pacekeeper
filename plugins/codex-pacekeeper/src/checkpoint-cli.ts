#!/usr/bin/env bun
/** Safe, exact-ID checkpoint and handoff CLI for the opt-in Codex package. */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CodexCheckpoints, type CheckpointOwner } from './checkpoint';
import { archiveHandoff, checkpointCliPath, handoffsDir, listHandoffs, writeHandoff } from './agent-budget';
import { loadCodexConfig } from './config';
import { resolveProjectRoot } from './resolve-root';

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
    'handoffs list|write <agent-id>|archive <agent-id>',
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
    const sub = args.positionals[0];
    if (sub === 'list') {
      const items = listHandoffs(root, loaded.config.checkpoint_dir_name, loaded.config.checkpoint_subdir);
      if (items.length === 0) process.stdout.write('No pending handoffs.\n');
      else for (const item of items) process.stdout.write(`${item.frontmatter.agent_id} ${item.frontmatter.agent_type ?? '?'} ${item.frontmatter.trigger} ${item.path}\n`);
      return;
    }
    const agentId = args.positionals[1];
    if (!agentId) throw new Error('handoffs requires an agent id');
    if (sub === 'archive') {
      const archived = archiveHandoff(root, loaded.config.checkpoint_dir_name, agentId, loaded.config.checkpoint_subdir);
      if (!archived) throw new Error('handoff was not found or could not be archived');
      process.stdout.write(`Archived handoff: ${archived}\n`);
      return;
    }
    if (sub === 'write') {
      const body = bodyFrom(args, await readStdin());
      const target = writeHandoff({ cwd: root, checkpointDirName: loaded.config.checkpoint_dir_name, checkpointSubdir: loaded.config.checkpoint_subdir, agentId, agentType: stringFlag(args, 'agent-type'), trigger: stringFlag(args, 'trigger') ?? 'budget_pause', body });
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
    const branch = stringFlag(args, 'branch') ?? gitValue(root, ['branch', '--show-current']);
    const saved = checkpoints.save({
      lane: stringFlag(args, 'lane') ?? branch ?? 'default',
      owner,
      body,
      ...(branch ? { branch } : {}),
      worktree: root,
      ...(stringFlag(args, 'reset-generation') ? { resetGeneration: Number(stringFlag(args, 'reset-generation')) } : {})
    });
    process.stdout.write(`Saved checkpoint ${saved.id} (${saved.file})\n`);
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
