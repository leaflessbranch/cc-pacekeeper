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
import * as path from 'path';
import type { CodexConfig } from './config';
import type { Level } from './facts';

/** Returned by a paused agent so a parent can recognize the pause. */
export const PAUSE_MARKER = 'PAUSED-BUDGET';

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

export function buildContract(input: ContractInput, config: CodexConfig): BudgetContract {
  if (!path.isAbsolute(input.cliPath)) {
    throw new Error('the budget contract requires an absolute CLI path');
  }
  const pausePercent = config.auto.subagent_pause_pct;
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

  if (input.rolledOver !== true && input.fiveHourPercent >= config.auto.subagent_pause_pct) {
    return {
      pause: true,
      reason: `the five-hour block reached ${input.fiveHourPercent}%`,
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
