#!/usr/bin/env bun
/** Event-specific Codex hook adapter. Native acquisition stays outside policy. */
import { buildContract, checkpointCliPath, effectivePause, formatPauseDirective, hasHandoff, listHandoffs, type ContractInput } from './agent-budget';
import { loadCodexConfig, type CodexConfig } from './config';
import { buildFacts, type CodexFacts } from './facts';
import { shouldPause } from './agent-budget';
import { decide, type PolicyEvent, type PolicyState } from './policy';
import { CodexStore, type StateIdentity } from './storage';
import type { NativeRateLimitsResponse } from './native';
import { readFileSync } from 'fs';

const KEEPALIVE_MARKER = '[pacekeeper-keepalive]';

export interface TickInput {
  hook_event_name?: unknown;
  event?: unknown;
  session_id?: unknown;
  thread_id?: unknown;
  account_id?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  now_ms?: unknown;
  observed_at_ms?: unknown;
  authenticated?: unknown;
  continuation_active?: unknown;
  stop_hook_active?: unknown;
  synthetic?: unknown;
  user_activity?: unknown;
  rateLimits?: unknown;
  rate_limits?: unknown;
  tokenUsage?: unknown;
  token_usage?: unknown;
}

export interface TickOptions {
  config?: CodexConfig;
  store?: CodexStore;
  nowMs?: number;
}

export interface TickResult {
  output: string;
  facts: CodexFacts;
  decision: ReturnType<typeof decide>;
  identity: StateIdentity;
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() !== '' ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function boolValue(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }

function eventName(input: TickInput): PolicyEvent {
  const event = stringValue(input.hook_event_name) ?? stringValue(input.event);
  const valid: readonly PolicyEvent[] = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];
  return valid.includes(event as PolicyEvent) ? event as PolicyEvent : 'SessionStart';
}

function identityFor(input: TickInput, facts: CodexFacts): StateIdentity {
  const threadId = stringValue(input.thread_id) ?? stringValue(input.session_id) ?? 'unknown-thread';
  const accountId = stringValue(input.account_id) ?? facts.accountId;
  const agentId = stringValue(input.agent_id);
  return { accountId: accountId ?? null, threadId, ...(agentId ? { agentId } : {}) };
}

function initialState(value: unknown): PolicyState {
  if (typeof value !== 'object' || value === null) return { levels: {}, lastInjectedAtMs: {}, blockResetAtMs: null, savedThisCycle: false };
  const candidate = value as Record<string, unknown>;
  const levels = typeof candidate.levels === 'object' && candidate.levels !== null ? candidate.levels as PolicyState['levels'] : {};
  const injected = typeof candidate.lastInjectedAtMs === 'object' && candidate.lastInjectedAtMs !== null ? candidate.lastInjectedAtMs as PolicyState['lastInjectedAtMs'] : {};
  return {
    levels: { ...levels },
    lastInjectedAtMs: { ...injected },
    blockResetAtMs: typeof candidate.blockResetAtMs === 'number' ? candidate.blockResetAtMs : null,
    savedThisCycle: candidate.savedThisCycle === true,
    ...(typeof candidate.lastUserActivityAtMs === 'number' ? { lastUserActivityAtMs: candidate.lastUserActivityAtMs } : {}),
    ...(typeof candidate.lastWorkAtMs === 'number' ? { lastWorkAtMs: candidate.lastWorkAtMs } : {}),
    ...(typeof candidate.lastToolActivityAtMs === 'number' ? { lastToolActivityAtMs: candidate.lastToolActivityAtMs } : {})
  };
}

function resetGeneration(facts: CodexFacts): number | null {
  const value = facts.fiveHour?.resetsAtMs;
  return value === null || value === undefined ? null : value;
}

function percentLabel(percent: number | null, rolledOver = false): string {
  if (percent === null) return '?';
  return `${percent}%${rolledOver ? ' (ended)' : ''}`;
}

export function formatFacts(facts: CodexFacts): string {
  const context = facts.context === null ? '?' : percentLabel(facts.context.usedPercent);
  const five = facts.fiveHour === null ? '?' : percentLabel(facts.fiveHour.usedPercent, facts.fiveHour.rolledOver);
  const weekly = facts.weekly === null ? '?' : percentLabel(facts.weekly.usedPercent, facts.weekly.rolledOver);
  const capacity = facts.capacity;
  const blockers = facts.blockers.length === 0 ? '' : `; blocked=${facts.blockers.join(', ')}`;
  return `[pacekeeper] context=${context}; 5h=${five}; weekly=${weekly}; capacity=${capacity}${blockers}`;
}

function output(event: PolicyEvent, additionalContext?: string): string {
  if (!additionalContext || additionalContext.trim() === '') return '{}';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
}

function isSynthetic(input: TickInput): boolean {
  if (input.synthetic === true) return true;
  const prompt = stringValue(input.prompt);
  return prompt?.trimStart().startsWith(KEEPALIVE_MARKER) ?? false;
}

function cachedTimeline(store: CodexStore, input: TickInput): Record<string, unknown> | null {
  const identity: StateIdentity = { accountId: stringValue(input.account_id) ?? null, threadId: stringValue(input.thread_id) ?? stringValue(input.session_id) ?? 'unknown-thread' };
  const value = store.read(identity, 'timeline');
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function cachedRateLimits(value: Record<string, unknown> | null): NativeRateLimitsResponse | null {
  const stored = value?.['rateLimits'];
  if (typeof stored !== 'object' || stored === null) return null;
  const row = stored as Record<string, unknown>;
  const buckets = Array.isArray(row['buckets']) ? row['buckets'] : [];
  const windows = buckets.filter((bucket): bucket is Record<string, unknown> => typeof bucket === 'object' && bucket !== null)
    .map((bucket) => ({ usedPercent: bucket['usedPercent'], windowDurationMins: bucket['durationMinutes'], resetsAt: bucket['resetsAtMs'] }));
  return {
    accountId: typeof row['accountId'] === 'string' ? row['accountId'] : undefined,
    rateLimits: {
      planType: typeof row['planType'] === 'string' ? row['planType'] : undefined,
      rateLimitReachedType: typeof row['rateLimitReachedType'] === 'string' ? row['rateLimitReachedType'] : undefined,
      spendControlReached: typeof row['spendControlReached'] === 'boolean' ? row['spendControlReached'] : undefined,
      primary: windows[0],
      secondary: windows[1]
    }
  };
}

function cachedTokenUsage(value: Record<string, unknown> | null): unknown | null {
  const stored = value?.['tokenUsage'];
  if (typeof stored !== 'object' || stored === null) return null;
  const row = stored as Record<string, unknown>;
  const cache = typeof row['cache'] === 'object' && row['cache'] !== null ? row['cache'] as Record<string, unknown> : {};
  return {
    modelContextWindow: row['contextWindow'],
    last: { inputTokens: row['currentTokens'], cachedInputTokens: cache['cachedInputTokens'], cacheWriteInputTokens: cache['cacheWriteInputTokens'] }
  };
}

function factsFrom(input: TickInput, config: CodexConfig, nowMs: number, store: CodexStore): CodexFacts {
  const cached = cachedTimeline(store, input);
  const rateLimits = (input.rateLimits ?? input.rate_limits) as Parameters<typeof buildFacts>[0]['rateLimits'] | null | undefined ?? cachedRateLimits(cached);
  const tokenUsage = input.tokenUsage ?? input.token_usage ?? cachedTokenUsage(cached);
  const observedAtMs = numberValue(input.observed_at_ms) ?? numberValue(cached?.['lastObservedAtMs']) ?? nowMs;
  const authenticated = boolValue(input.authenticated) ?? (typeof cached?.['authenticated'] === 'boolean' ? cached['authenticated'] : null);
  return buildFacts({ rateLimits: rateLimits ?? null, observedAtMs, tokenUsage, authenticated }, config, nowMs);
}

function saveTimeline(store: CodexStore, identity: StateIdentity, value: Record<string, unknown>): void {
  const existing = store.read(identity, 'timeline');
  const prior = typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {};
  store.write(identity, 'timeline', { ...prior, ...value });
}

function buildSubagentText(input: TickInput, facts: CodexFacts, config: CodexConfig): string {
  const agentId = stringValue(input.agent_id) ?? 'unknown-agent';
  const agentType = stringValue(input.agent_type) ?? 'unknown';
  const five = facts.fiveHour?.usedPercent;
  if (five === undefined || five === null || facts.stale || facts.fiveHour?.rolledOver === true) {
    return `${formatFacts(facts)}\n\n[pacekeeper] Subagent budget contract is unavailable until a fresh shared-account five-hour reading is observed. Do not infer a per-agent budget.`;
  }
  const contract: ContractInput = { agentId, agentType, cliPath: checkpointCliPath(), fiveHourPercentAtSpawn: five };
  return `${formatFacts(facts)}\n\n${buildContract(contract, config).text}`;
}

export function runTick(input: TickInput, options: TickOptions = {}): TickResult {
  const config = options.config ?? loadCodexConfig().config;
  const nowMs = options.nowMs ?? numberValue(input.now_ms) ?? Date.now();
  const event = eventName(input);
  const synthetic = isSynthetic(input);
  const store = options.store ?? new CodexStore();
  const facts = factsFrom(input, config, nowMs, store);
  const identity = identityFor(input, facts);
  const previous = initialState(store.read(identity, 'debounce'));
  const decision = decide({
    event,
    facts,
    state: previous,
    nowMs,
    synthetic,
    continuationActive: boolValue(input.continuation_active) ?? boolValue(input.stop_hook_active),
    userActivity: boolValue(input.user_activity)
  }, config);

  if (!synthetic) {
    store.write(identity, 'debounce', decision.nextState);
    saveTimeline(store, identity, {
      lastEventAtMs: nowMs,
      ...(event === 'UserPromptSubmit' ? { lastUserActivityAtMs: nowMs } : {}),
      ...(event === 'PreToolUse' || event === 'PostToolUse' ? { lastWorkAtMs: nowMs, lastToolActivityAtMs: nowMs } : {}),
      ...(event === 'SessionStart' ? { sessionStartedAtMs: nowMs } : {}),
      ...(event === 'SessionEnd' ? { sessionEndedAtMs: nowMs } : {})
    });
    if (event === 'SubagentStart' && stringValue(input.agent_id) && facts.fiveHour?.usedPercent !== null && facts.fiveHour?.usedPercent !== undefined) {
      saveTimeline(store, identity, { spawnFiveHourPercent: facts.fiveHour.usedPercent, parentThreadId: stringValue(input.thread_id) ?? stringValue(input.session_id) ?? 'unknown-thread' });
    }
  }

  if (synthetic) return { output: '{}', facts, decision, identity };

  let context = '';
  if (event === 'SubagentStart') context = buildSubagentText(input, facts, config);
  else if (event === 'SubagentStop') {
    const agentId = stringValue(input.agent_id);
    const pending = agentId && hasHandoff(String(input.cwd ?? process.cwd()), config.checkpoint_dir_name, agentId);
    context = pending ? `${formatFacts(facts)}\n\n[pacekeeper] A handoff is pending for ${agentId}; the parent must absorb it once, then run ${checkpointCliPath()} handoffs archive ${agentId}.` : formatFacts(facts);
  } else if (event === 'PreCompact' && facts.context?.level === 'critical' && decision.inject) {
    context = `${formatFacts(facts)}\n\n[pacekeeper] Context is critical. Save a resumable checkpoint now with ${checkpointCliPath()} before continuing. The native hook boundary does not prove a save barrier, so do not claim the checkpoint exists until the CLI verifies it.`;
  } else if (decision.inject) {
    context = `${formatFacts(facts)}\n\n[pacekeeper] ${decision.reason}. Keep the next step small and checkpoint before a critical boundary.`;
  } else if (event === 'SessionStart' && facts.blockers.length > 0) {
    context = formatFacts(facts);
  }

  const agentId = stringValue(input.agent_id);
  if (agentId && event !== 'SubagentStart' && event !== 'SubagentStop') {
    const timeline = store.read(identity, 'timeline');
    const spawn = typeof timeline === 'object' && timeline !== null && typeof (timeline as Record<string, unknown>)['spawnFiveHourPercent'] === 'number'
      ? (timeline as Record<string, unknown>)['spawnFiveHourPercent'] as number
      : null;
    if (spawn !== null && !facts.stale) {
      const pause = shouldPause({ fiveHourPercent: facts.fiveHour?.usedPercent ?? null, fiveHourPercentAtSpawn: spawn, contextLevel: facts.context?.level, rolledOver: facts.fiveHour?.rolledOver }, config);
      if (pause.pause) context += `${context ? '\n\n' : ''}${formatPauseDirective({ agentId, pausePercent: effectivePause(config, spawn) })}`;
    }
  }

  if (event === 'SubagentStart' && facts.fiveHour?.usedPercent !== null && facts.fiveHour?.usedPercent !== undefined) {
    const startAgentId = agentId ?? 'unknown-agent';
    const pause = effectivePause(config, facts.fiveHour.usedPercent);
    if (facts.fiveHour.usedPercent >= pause) context += `\n\n${formatPauseDirective({ agentId: startAgentId, pausePercent: pause })}`;
  }
  return { output: output(event, context), facts, decision, identity };
}

function readInput(): TickInput {
  const text = readFileSync(0, 'utf8');
  if (text.trim() === '') return {};
  try { return JSON.parse(text) as TickInput; } catch { return {}; }
}

if (import.meta.main) {
  const input = readInput();
  try { process.stdout.write(runTick(input).output + '\n'); }
  catch (error) {
    try {
      const store = new CodexStore();
      store.write({ accountId: stringValue(input.account_id) ?? null, threadId: stringValue(input.thread_id) ?? stringValue(input.session_id) ?? 'unknown-thread' }, 'crash', { atMs: Date.now(), component: 'tick', message: error instanceof Error ? error.message : 'tick failed' });
    } catch { /* breadcrumb is best effort */ }
    process.stdout.write('{}\n');
  }
}
