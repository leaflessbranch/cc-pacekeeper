/**
 * Subagent budgets and handoffs.
 *
 * The five-hour window belongs to the account, not to any one agent, so the
 * difference between a spawn-time reading and a current one is an estimate of
 * what the ACCOUNT consumed while the agent ran. Other work on the same
 * account contributes to it. Nothing here is per-agent billing, and the
 * contract text says so, because an agent told otherwise would reason about a
 * number that does not mean what it appears to mean.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CodexConfig } from './config';
import type { Level } from './facts';

function realOrResolve(input: string): string {
  const resolved = path.resolve(input);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

/** Returned by a paused agent so a parent can recognize the pause. */
export const PAUSE_MARKER = 'PAUSED-BUDGET';
export const RESUME_MARKER = '[pacekeeper-resume]';

/** The absolute package path embedded in model-facing contracts. */
export function checkpointCliPath(): string {
  const root = process.env['CODEX_PLUGIN_ROOT'] ?? process.env['CODEX_PACEKEEPER_ROOT'];
  return root ? path.resolve(root, 'bin', 'pacekeeper-checkpoint') : path.resolve(import.meta.dir, '..', 'bin', 'pacekeeper-checkpoint');
}

export interface ContractInput {
  agentId: string;
  agentType: string;
  /**
   * Absolute path to the checkpoint CLI. A subagent's shell does not see the
   * PATH shim, so a bare command name would simply fail when it tried to run.
   */
  cliPath: string;
  fiveHourPercentAtSpawn: number;
}

export interface BudgetContract {
  pausePercent: number;
  text: string;
}

/**
 * A child spawned late in a block must receive the same five percentage-point
 * runway as the shipped Claude contract. The configured pause is the floor and
 * the main auto-renewal boundary is the ceiling.
 */
export function effectivePause(config: CodexConfig, fiveHourPercentAtSpawn: number): number {
  const spawn = Number.isFinite(fiveHourPercentAtSpawn) ? Math.max(0, Math.min(100, fiveHourPercentAtSpawn)) : 0;
  return Math.min(config.auto.five_hour_pct, Math.max(config.auto.subagent_pause_pct, spawn + 5));
}

export function buildContract(input: ContractInput, config: CodexConfig): BudgetContract {
  if (!path.isAbsolute(input.cliPath)) {
    throw new Error('the budget contract requires an absolute CLI path');
  }
  safeContractToken(input.agentId, 'agent id');
  safeContractToken(input.agentType, 'agent type');
  if (!Number.isFinite(input.fiveHourPercentAtSpawn) || input.fiveHourPercentAtSpawn < 0 || input.fiveHourPercentAtSpawn > 100) {
    throw new Error('the budget contract requires a valid spawn percentage');
  }
  const pausePercent = effectivePause(config, input.fiveHourPercentAtSpawn);
  const text = [
    `Budget contract for this subagent (agent_id ${input.agentId}, type ${input.agentType}).`,
    `Pause at ${pausePercent}% of the five-hour block (spawned at about ${input.fiveHourPercentAtSpawn}%),`,
    'or immediately if any meter reaches critical.',
    'The five-hour window belongs to the whole account, so any figure describing',
    'what this agent consumed is an estimate of account usage during its life,',
    'not a per-agent measurement.',
    'On pausing: finish the current small step, do not start a new one, then write',
    `a handoff with \`${input.cliPath} handoffs write ${input.agentId} --agent-type ${input.agentType}\``,
    `and return immediately with the literal text ${PAUSE_MARKER} ${input.agentId}.`
  ].join('\n');
  return { pausePercent, text };
}

export interface PauseInput {
  /** `null` when the meter could not be read. */
  fiveHourPercent: number | null;
  fiveHourPercentAtSpawn: number;
  contextLevel?: Level | null;
  /** The block rolled over, so the spawn-time anchor no longer applies. */
  rolledOver?: boolean;
}

export interface PauseDecision {
  pause: boolean;
  reason: string;
  /** Estimated account usage since spawn, in percentage points. */
  consumedEstimate: number;
}

export function shouldPause(input: PauseInput, config: CodexConfig): PauseDecision {
  if (input.contextLevel === 'critical') {
    return { pause: true, reason: 'a meter is critical', consumedEstimate: 0 };
  }
  if (input.fiveHourPercent === null) {
    // Guessing here would either pause useful work or run past the budget.
    return {
      pause: false,
      reason: 'the five-hour meter is unreadable, so no budget decision is possible',
      consumedEstimate: 0
    };
  }
  // After a rollover the spawn anchor belongs to a window that has ended;
  // subtracting it would report negative consumption.
  const consumedEstimate = input.rolledOver === true
    ? 0
    : Math.max(0, input.fiveHourPercent - input.fiveHourPercentAtSpawn);

  const pausePercent = effectivePause(config, input.fiveHourPercentAtSpawn);
  if (input.rolledOver !== true && input.fiveHourPercent >= pausePercent) {
    return {
      pause: true,
      reason: `the five-hour block reached ${input.fiveHourPercent}% (child pause point ${pausePercent}%)`,
      consumedEstimate
    };
  }
  return { pause: false, reason: 'within budget', consumedEstimate };
}

export interface DispatchInput {
  fiveHourPercent: number | null;
  plannedAgents: number;
}

export interface DispatchAdvice {
  /** Always false. An advisory that denies is no longer an advisory. */
  deny: false;
  message: string | null;
}

/**
 * Advise before an expensive fan-out. This never denies a dispatch: refusing
 * an ordinary spawn would break the user's work to save budget they did not
 * ask us to save.
 */
export function dispatchAdvice(input: DispatchInput, config: CodexConfig): DispatchAdvice {
  if (input.plannedAgents <= 1) return { deny: false, message: null };
  if (input.fiveHourPercent === null) {
    return {
      deny: false,
      message: `Dispatching ${input.plannedAgents} agents while the five-hour meter is unreadable.`
    };
  }
  if (input.fiveHourPercent >= config.thresholds.five_hour.warn) {
    return {
      deny: false,
      message:
        `The five-hour block is at ${input.fiveHourPercent}%. ` +
        `Dispatching ${input.plannedAgents} agents will consume it faster.`
    };
  }
  return { deny: false, message: null };
}

export interface HandoffFrontmatter {
  agent_id: string;
  agent_type?: string;
  created_at: string;
  trigger: string;
}

export interface Handoff {
  path: string;
  frontmatter: HandoffFrontmatter;
  body: string;
  mtimeMs: number;
}

export interface WriteHandoffInput {
  cwd: string;
  checkpointDirName: string;
  /** Matches CodexCheckpoints' configured isolated subtree. */
  checkpointSubdir?: string;
  agentId: string;
  agentType?: string;
  trigger: string;
  body: string;
}

function safeSegment(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${name} must be a single safe identifier`);
  }
  return value;
}

function safeContractToken(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error(`${name} must be a single safe token`);
  return value;
}

function handoffRoot(cwd: string, checkpointDirName: string, checkpointSubdir = 'codex'): string {
  safeSegment(checkpointDirName, 'checkpoint directory');
  safeSegment(checkpointSubdir, 'checkpoint subdir');
  const root = realOrResolve(cwd);
  const target = path.join(root, checkpointDirName, checkpointSubdir, 'handoffs');
  assertHandoffConfined(root, target);
  return target;
}

function assertHandoffConfined(root: string, target: string): void {
  const base = path.resolve(root);
  const absolute = path.resolve(target);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) throw new Error('handoff path escapes project root');
  let cursor = base;
  for (const component of path.relative(base, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('handoff path contains a symlink');
    } catch (error) {
      if (error instanceof Error && error.message.includes('contains a symlink')) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error('handoff path could not be inspected');
    }
  }
}

export function handoffsDir(cwd: string, checkpointDirName: string, checkpointSubdir = 'codex'): string {
  return handoffRoot(cwd, checkpointDirName, checkpointSubdir);
}

function handoffFile(cwd: string, checkpointDirName: string, agentId: string, checkpointSubdir = 'codex'): string {
  safeSegment(agentId, 'agent id');
  return path.join(handoffRoot(cwd, checkpointDirName, checkpointSubdir), `${agentId}.md`);
}

function emitHandoffFrontmatter(frontmatter: HandoffFrontmatter): string {
  return Object.entries(frontmatter)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

function parseHandoff(file: string): Handoff | null {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    if (match === null) return null;
    const values: Record<string, string> = {};
    for (const line of (match[1] ?? '').split('\n')) {
      const separator = line.indexOf(':');
      if (separator <= 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      try { values[key] = JSON.parse(value) as string; } catch { values[key] = value; }
    }
    if (!values.agent_id || !values.created_at) return null;
    safeSegment(values.agent_id, 'agent id');
    const stat = fs.statSync(file);
    return {
      path: file,
      frontmatter: {
        agent_id: values.agent_id,
        created_at: values.created_at,
        trigger: values.trigger ?? 'unknown',
        ...(values.agent_type ? { agent_type: values.agent_type } : {})
      },
      body: (match[2] ?? '').trim(),
      mtimeMs: stat.mtimeMs
    };
  } catch {
    return null;
  }
}

/** Persist a handoff before returning the pause marker. */
export function writeHandoff(input: WriteHandoffInput): string {
  const target = handoffFile(input.cwd, input.checkpointDirName, input.agentId, input.checkpointSubdir);
  if (input.body.trim() === '') throw new Error('handoff body must not be empty');
  if (input.agentType !== undefined) safeContractToken(input.agentType, 'agent type');
  const trigger = input.trigger || 'budget_pause';
  safeContractToken(trigger, 'handoff trigger');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertHandoffConfined(path.resolve(input.cwd), target);
  const frontmatter: HandoffFrontmatter = {
    agent_id: input.agentId,
    ...(input.agentType ? { agent_type: input.agentType } : {}),
    created_at: new Date().toISOString(),
    trigger
  };
  const content = `---\n${emitHandoffFrontmatter(frontmatter)}\n---\n\n${input.body.trimEnd()}\n`;
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, target);
    const verified = parseHandoff(target);
    if (verified === null || verified.frontmatter.agent_id !== input.agentId || verified.body !== input.body.trim()) {
      throw new Error('handoff verification failed');
    }
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
  return target;
}

export function listHandoffs(cwd: string, checkpointDirName: string, checkpointSubdir = 'codex'): Handoff[] {
  const dir = handoffRoot(cwd, checkpointDirName, checkpointSubdir);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => name.endsWith('.md'))
    .map((name) => parseHandoff(path.join(dir, name)))
    .filter((item): item is Handoff => item !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function hasHandoff(cwd: string, checkpointDirName: string, agentId: string, checkpointSubdir = 'codex'): boolean {
  try { return parseHandoff(handoffFile(cwd, checkpointDirName, agentId, checkpointSubdir)) !== null; } catch { return false; }
}

export function archiveHandoff(cwd: string, checkpointDirName: string, agentId: string, checkpointSubdir = 'codex'): string | null {
  let source: string;
  try { source = handoffFile(cwd, checkpointDirName, agentId, checkpointSubdir); } catch { return null; }
  if (!fs.existsSync(source)) return null;
  if (fs.lstatSync(source).isSymbolicLink()) return null;
  const archive = path.join(handoffRoot(cwd, checkpointDirName, checkpointSubdir), 'archive');
  fs.mkdirSync(archive, { recursive: true });
  assertHandoffConfined(realOrResolve(cwd), archive);
  let target = path.join(archive, `${agentId}.md`);
  let suffix = 1;
  while (fs.existsSync(target)) target = path.join(archive, `${agentId}-${suffix++}.md`);
  try { fs.renameSync(source, target); return target; } catch { return null; }
}

export function formatSubagentContract(input: ContractInput, config: CodexConfig): string {
  safeContractToken(input.agentId, 'agent id');
  safeContractToken(input.agentType, 'agent type');
  if (!path.isAbsolute(input.cliPath)) throw new Error('the budget contract requires an absolute CLI path');
  const pause = effectivePause(config, input.fiveHourPercentAtSpawn);
  return [
    `[pacekeeper] Budget contract for subagent ${input.agentId} (${input.agentType}).`,
    `Pause at ${pause}% of the shared five-hour meter (spawned at ${input.fiveHourPercentAtSpawn}%).`,
    'The figure is an account-window estimate, not per-agent billing.',
    `When pausing, finish only the current small step, write a handoff with ${input.cliPath} handoffs write ${input.agentId}, then return ${PAUSE_MARKER} ${input.agentId}.`,
    'A paused child must be recorded in the parent handoff and must not be blindly re-dispatched.'
  ].join('\n');
}

export function formatPauseDirective(input: { agentId: string; pausePercent: number }): string {
  return `[pacekeeper] Subagent pause point ${input.pausePercent}% reached. Finish only the current small step, write ${checkpointCliPath()} handoffs write ${input.agentId}, then return ${PAUSE_MARKER} ${input.agentId}.`;
}
