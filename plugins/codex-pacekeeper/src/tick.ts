#!/usr/bin/env bun
/** Event-specific Codex hook adapter. Native acquisition stays outside policy. */
import { buildContract, checkpointCliPath, dispatchAdvice, effectivePause, formatPauseDirective, type ContractInput, type HandoffOwnership } from './agent-budget';
import { loadCodexConfig, type CodexConfig } from './config';
import { buildFacts, type CodexFacts } from './facts';
import { shouldPause } from './agent-budget';
import { decide, type PolicyEvent, type PolicyState } from './policy';
import { CodexStore, type StateIdentity } from './storage';
import type { NativeRateLimitsResponse } from './native';
import { readFileSync } from 'fs';
import { CodexService } from './service';

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
  /** Set only when an external persistence caller has verified a saved file. */
  save_acknowledged?: unknown;
  checkpoint_saved?: unknown;
  planned_agents?: unknown;
  /** Codex PreToolUse fields used to identify the native spawn tool. */
  tool_name?: unknown;
  tool_input?: unknown;
  job_id?: unknown;
  submission_id?: unknown;
  client_user_message_id?: unknown;
  turn_id?: unknown;
  job_result?: unknown;
  native_completed?: unknown;
  tool_calls?: unknown;
  pending_work?: unknown;
  pendingWork?: unknown;
  clear?: unknown;
  model_change?: unknown;
  model_changed?: unknown;
  model?: unknown;
  previous_model?: unknown;
  source?: unknown;
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

function plannedAgentCount(input: TickInput): number | undefined {
  const explicit = numberValue(input.planned_agents);
  if (explicit !== undefined) return explicit;
  const toolName = stringValue(input.tool_name);
  if (toolName !== 'spawn_agent' && toolName !== 'Agent' && toolName !== 'spawnAgent' && toolName !== 'collabAgentToolCall') return undefined;
  if (Array.isArray(input.tool_input)) return input.tool_input.length;
  if (typeof input.tool_input !== 'object' || input.tool_input === null) return undefined;
  const args = input.tool_input as Record<string, unknown>;
  // Native collaboration events expose the operation as `tool: spawnAgent`
  // and carry one receiver thread per spawned child. Count only that exact
  // schema value; an unrelated tool input remains advisory-free.
  if (toolName === 'collabAgentToolCall' || toolName === 'spawnAgent') {
    if (args['tool'] !== 'spawnAgent') return undefined;
    if (Array.isArray(args['receiverThreadIds'])) return args['receiverThreadIds'].filter((id) => typeof id === 'string').length || 1;
    return 1;
  }
  // The hook contract exposes tool_input as JSON, while the native spawn
  // tool's argument shape can evolve. Only count an explicit collection or
  // count supplied by that payload; never infer a fan-out from prose.
  for (const key of ['agents', 'tasks', 'agent_ids']) {
    if (Array.isArray(args[key])) return args[key].length;
  }
  for (const key of ['count', 'planned_agents']) {
    const count = numberValue(args[key]);
    if (count !== undefined) return count;
  }
  return undefined;
}

function eventName(input: TickInput): PolicyEvent {
  const event = stringValue(input.hook_event_name) ?? stringValue(input.event);
  const valid: readonly PolicyEvent[] = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];
  return valid.includes(event as PolicyEvent) ? event as PolicyEvent : 'SessionStart';
}

function lifecycleBoundary(input: TickInput, event: PolicyEvent): string | null {
  if (event === 'SessionEnd') return 'session ended';
  if (event === 'Interrupt') return 'session interrupted';
  const rawEvent = (stringValue(input.hook_event_name) ?? stringValue(input.event) ?? '').toLowerCase().replace(/[_ -]/g, '');
  if (input.clear === true || rawEvent === 'clear' || rawEvent === 'clearcommand' || stringValue(input.prompt)?.trim() === '/clear') {
    return 'session cleared';
  }
  if (input.model_change === true || input.model_changed === true || rawEvent === 'modelchange' || rawEvent === 'modelchanged') {
    return 'model changed';
  }
  const model = stringValue(input.model);
  const previousModel = stringValue(input.previous_model);
  return model !== undefined && previousModel !== undefined && model !== previousModel ? 'model changed' : null;
}

function identityFor(input: TickInput, facts: CodexFacts): StateIdentity {
  const threadId = stringValue(input.thread_id) ?? stringValue(input.session_id) ?? 'unknown-thread';
  const accountId = stringValue(input.account_id) ?? facts.accountId;
  const agentId = stringValue(input.agent_id);
  return { accountId: accountId ?? null, threadId, ...(agentId ? { agentId } : {}) };
}

function initialState(value: unknown): PolicyState {
  if (typeof value !== 'object' || value === null) return { levels: {}, lastInjectedAtMs: {}, blockResetAtMs: null, savedThisCycle: false, saveRequestedThisCycle: false };
  const candidate = value as Record<string, unknown>;
  const levels = typeof candidate.levels === 'object' && candidate.levels !== null ? candidate.levels as PolicyState['levels'] : {};
  const injected = typeof candidate.lastInjectedAtMs === 'object' && candidate.lastInjectedAtMs !== null ? candidate.lastInjectedAtMs as PolicyState['lastInjectedAtMs'] : {};
  return {
    levels: { ...levels },
    lastInjectedAtMs: { ...injected },
    blockResetAtMs: typeof candidate.blockResetAtMs === 'number' ? candidate.blockResetAtMs : null,
    savedThisCycle: candidate.savedThisCycle === true,
    saveRequestedThisCycle: candidate.saveRequestedThisCycle === true,
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

function output(event: PolicyEvent, additionalContext?: string, continuationActive = false): string {
  if (!additionalContext || additionalContext.trim() === '') return '{}';
  if (continuationActive) return '{}';
  if (event === 'Stop' || event === 'SubagentStop') {
    return JSON.stringify({ decision: 'block', reason: additionalContext });
  }
  if (event === 'PreCompact' || event === 'PostCompact') {
    // A compaction hook is not a model turn. Report the checkpoint request or
    // status through the documented common field; do not turn an ordinary
    // warning into continue=false without a native save barrier.
    return JSON.stringify({ systemMessage: additionalContext });
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
}

function ownedSyntheticJob(input: TickInput, store: CodexStore): Record<string, unknown> | null {
  const threadId = stringValue(input.thread_id) ?? stringValue(input.session_id);
  if (threadId === undefined) return null;
  const accountId = stringValue(input.account_id);
  const jobId = stringValue(input.job_id);
  const submissionId = stringValue(input.submission_id) ?? stringValue(input.client_user_message_id);
  const turnId = stringValue(input.turn_id);
  const matches = store.list('job').filter((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const row = candidate as Record<string, unknown>;
    const owner = typeof row['owner'] === 'object' && row['owner'] !== null ? row['owner'] as Record<string, unknown> : null;
    if ((row['kind'] !== 'keepalive' && row['kind'] !== 'reset-wake') || owner === null || owner['threadId'] !== threadId) return false;
    if (accountId !== undefined && owner['accountId'] !== accountId) return false;
    if (jobId !== undefined && row['id'] !== jobId) return false;
    if (submissionId !== undefined && row['submissionId'] !== submissionId) return false;
    if (turnId !== undefined && row['turnId'] !== turnId) return false;
    return jobId !== undefined || submissionId !== undefined || turnId !== undefined;
  });
  // When account_id is omitted, one exact same-thread owned job is enough;
  // multiple account matches are ambiguous and must remain ordinary input.
  const only = matches[0];
  return matches.length === 1 && typeof only === 'object' && only !== null
    ? only as Record<string, unknown>
    : null;
}

function matchesOwnedSynthetic(input: TickInput, store: CodexStore): boolean {
  return ownedSyntheticJob(input, store) !== null;
}

function isSynthetic(input: TickInput, store: CodexStore): boolean {
  return matchesOwnedSynthetic(input, store);
}

function cachedTimeline(store: CodexStore, input: TickInput): Record<string, unknown> | null {
  const accountId = stringValue(input.account_id) ?? null;
  const threadId = stringValue(input.thread_id) ?? stringValue(input.session_id) ?? 'unknown-thread';
  const direct = store.read({ accountId, threadId }, 'timeline');
  if (accountId !== null && typeof direct === 'object' && direct !== null) return direct as Record<string, unknown>;

  // Some hook payloads omit account_id even though the refresh observer saved
  // native readings under the authoritative account. Recover only an
  // unambiguous same-thread record; two accounts sharing a thread id remain
  // unknown rather than crossing account state.
  const candidates = store.list('timeline').filter((candidate): candidate is Record<string, unknown> => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const row = candidate as Record<string, unknown>;
    if (row['threadId'] !== threadId || row['agentId'] !== undefined) return false;
    return accountId === null || row['accountId'] === accountId;
  });
  if (accountId === null) {
    // A hook can arrive before native identity is available and leave a
    // provisional null-account row. Once a same-thread row carries an
    // authoritative account, discard those provisional rows for lookup. Keep
    // the ambiguity rule when more than one real account is present.
    const authoritative = candidates.filter((row) => typeof row['accountId'] === 'string' && row['accountId'].trim() !== '');
    if (authoritative.length > 0) {
      const accounts = new Set(authoritative.map((row) => row['accountId']));
      return accounts.size === 1 ? authoritative[0] ?? null : null;
    }
  }
  if (candidates.length === 1) return candidates[0] ?? null;
  // A legacy record without explicit identity metadata is not safe to reuse
  // when the hook omitted the account: it could belong to another account's
  // thread with the same id. Ignore it rather than falling back across scope.
  return null;
}

function cachedRateLimits(value: Record<string, unknown> | null): NativeRateLimitsResponse | null {
  const stored = value?.['rateLimits'];
  if (typeof stored !== 'object' || stored === null) return null;
  // refreshObservations stores the parser's complete sanitized response. Keep
  // its by-limit map, labels and credit metadata intact so a later hook does
  // not silently collapse multi-bucket evidence into two positional windows.
  return stored as NativeRateLimitsResponse;
}

function cachedTokenUsage(value: Record<string, unknown> | null): unknown | null {
  const stored = value?.['tokenUsage'];
  if (typeof stored !== 'object' || stored === null) return null;
  const row = stored as Record<string, unknown>;
  const cache = typeof row['cache'] === 'object' && row['cache'] !== null ? row['cache'] as Record<string, unknown> : {};
  return {
    modelContextWindow: row['contextWindow'],
    last: { totalTokens: row['currentTokens'], cachedInputTokens: cache['cachedInputTokens'], cacheWriteInputTokens: cache['cacheWriteInputTokens'] }
  };
}

function factsFrom(input: TickInput, config: CodexConfig, nowMs: number, store: CodexStore): CodexFacts {
  const cached = cachedTimeline(store, input);
  const suppliedRateLimits = input.rateLimits ?? input.rate_limits;
  const rateLimits = suppliedRateLimits as Parameters<typeof buildFacts>[0]['rateLimits'] | null | undefined ?? cachedRateLimits(cached);
  // Context belongs to the verified transcript thread; unavailable account
  // transport must not hide a newer context reading or refresh account facts.
  const threadContext = store.read({ accountId: null, threadId: stringValue(input.thread_id) ?? stringValue(input.session_id) ?? 'unknown-thread' }, 'timeline') as Record<string, unknown> | null;
  const accountContextAt = numberValue(cached?.['contextObservedAtMs']) ?? -1;
  const threadContextAt = numberValue(threadContext?.['contextObservedAtMs']) ?? -1;
  const invalidatedAt = numberValue(threadContext?.['contextInvalidatedAtMs']) ?? -1;
  const context = threadContextAt >= accountContextAt || invalidatedAt >= accountContextAt ? threadContext : cached;
  const cachedContextAt = numberValue(context?.['contextObservedAtMs']);
  const cachedContextFresh = cachedContextAt !== undefined && nowMs >= cachedContextAt && nowMs - cachedContextAt <= config.usage_freshness_seconds * 1000;
  const tokenUsage = input.tokenUsage ?? input.token_usage ?? (cachedContextFresh ? cachedTokenUsage(context) : null);
  const observedAtMs = numberValue(input.observed_at_ms)
    ?? (rateLimits !== null && rateLimits !== undefined
      ? numberValue(cached?.['quotaObservedAtMs']) ?? numberValue(cached?.['lastObservedAtMs']) ?? nowMs
      : nowMs);
  const suppliedOrdinaryPermission = typeof suppliedRateLimits === 'object'
    && suppliedRateLimits !== null
    && Object.prototype.hasOwnProperty.call(suppliedRateLimits, 'ordinaryUsageAllowed');
  const ordinaryUsageObservedAtMs = suppliedOrdinaryPermission
    ? (numberValue(input.observed_at_ms) ?? nowMs)
    : numberValue(cached?.['ordinaryUsageObservedAtMs']);
  const cachedAuthAt = numberValue(cached?.['authObservedAtMs']);
  const cachedAuthFresh = cachedAuthAt !== undefined && nowMs >= cachedAuthAt && nowMs - cachedAuthAt <= config.usage_freshness_seconds * 1000;
  const authenticated = boolValue(input.authenticated) ?? (cachedAuthFresh && typeof cached?.['authenticated'] === 'boolean' ? cached['authenticated'] : null);
  return buildFacts({ rateLimits: rateLimits ?? null, observedAtMs, ordinaryUsageObservedAtMs, tokenUsage, authenticated }, config, nowMs);
}

function saveTimeline(store: CodexStore, identity: StateIdentity, value: Record<string, unknown>): void {
  const existing = store.read(identity, 'timeline');
  const prior = typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {};
  store.write(identity, 'timeline', { ...prior, accountId: identity.accountId, threadId: identity.threadId, ...(identity.agentId ? { agentId: identity.agentId } : {}), ...value });
}

function verifiedHandoffOwner(store: CodexStore, identity: StateIdentity): HandoffOwnership | undefined {
  if (identity.accountId === null || identity.agentId === undefined) return undefined;
  const value = store.read(identity, 'owner');
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (row['source'] !== 'native-thread-parent'
    || row['accountId'] !== identity.accountId
    || row['childThreadId'] !== identity.threadId
    || row['agentId'] !== identity.agentId
    || typeof row['parentThreadId'] !== 'string'
    || row['parentThreadId'].trim() === '') return undefined;
  return { accountId: identity.accountId, childThreadId: identity.threadId, parentThreadId: row['parentThreadId'] };
}

function buildSubagentText(input: TickInput, facts: CodexFacts, config: CodexConfig, store: CodexStore, identity: StateIdentity): string {
  const agentId = stringValue(input.agent_id) ?? 'unknown-agent';
  const agentType = stringValue(input.agent_type) ?? 'unknown';
  const five = facts.fiveHour?.usedPercent;
  if (five === undefined || five === null || facts.stale || facts.fiveHour?.rolledOver === true) {
    return `${formatFacts(facts)}\n\n[pacekeeper] Subagent budget contract is unavailable until a fresh shared-account five-hour reading is observed. Do not infer a per-agent budget.`;
  }
  const handoffOwner = verifiedHandoffOwner(store, identity);
  if (handoffOwner === undefined) {
    return `${formatFacts(facts)}\n\n[pacekeeper] Subagent budget reading is available, but native account and child-parent ownership is unverified. Do not create an unowned handoff; a scoped handoff command will be supplied only after native mapping is established.`;
  }
  const contract: ContractInput = { agentId, agentType, cliPath: checkpointCliPath(), fiveHourPercentAtSpawn: five, handoffOwner };
  return `${formatFacts(facts)}\n\n${buildContract(contract, config).text}`;
}

function recordCompletionEnvelope(input: TickInput, event: PolicyEvent, config: CodexConfig, store: CodexStore, nowMs: number): void {
  if (event !== 'Stop' && event !== 'SubagentStop' && event !== 'SessionEnd') return;
  const owned = ownedSyntheticJob(input, store);
  const jobId = stringValue(input.job_id) ?? (typeof owned?.['id'] === 'string' ? owned['id'] : undefined);
  const submissionId = stringValue(input.submission_id) ?? stringValue(input.client_user_message_id);
  const turnId = stringValue(input.turn_id);
  const result = typeof input.job_result === 'string' ? input.job_result : undefined;
  const nativeCompleted = boolValue(input.native_completed);
  const toolCalls = numberValue(input.tool_calls);
  if (jobId === undefined || submissionId === undefined || result === undefined || nativeCompleted === undefined || toolCalls === undefined) return;
  // This adapter accepts completion only when a caller supplies all three
  // independent facts. It never treats a hook name or queue acknowledgement
  // as model completion, and it has no effect for ordinary hooks without the
  // explicit envelope.
  const service = new CodexService({ config, store, now: () => nowMs });
  // A hook receipt has no fresh service eligibility context. Let the service
  // watcher create the next recurring attempt after it refreshes its owner;
  // this receipt only completes the exact current attempt.
  service.recordCompletion(jobId, result, nativeCompleted, toolCalls, submissionId, turnId, false);
}

export function runTick(input: TickInput, options: TickOptions = {}): TickResult {
  const config = options.config ?? loadCodexConfig().config;
  const nowMs = options.nowMs ?? numberValue(input.now_ms) ?? Date.now();
  const event = eventName(input);
  const store = options.store ?? new CodexStore();
  const synthetic = isSynthetic(input, store);
  const facts = factsFrom(input, config, nowMs, store);
  const identity = identityFor(input, facts);
  const lifecycleReason = synthetic ? null : (event === 'UserPromptSubmit' ? 'the user became active' : lifecycleBoundary(input, event));
  if (lifecycleReason !== null && identity.threadId !== 'unknown-thread') {
    new CodexService({ config, store }).cancelOwnerJobs({ accountId: identity.accountId, threadId: identity.threadId }, lifecycleReason);
  }
  const previous = initialState(store.read(identity, 'debounce'));
  const decision = decide({
    event,
    facts,
    state: previous,
    nowMs,
    synthetic,
    continuationActive: boolValue(input.continuation_active) ?? boolValue(input.stop_hook_active),
    userActivity: boolValue(input.user_activity),
    saveAcknowledged: boolValue(input.save_acknowledged) ?? boolValue(input.checkpoint_saved)
  }, config);

  // Completion receipts are allowed on an owned synthetic Stop/SessionEnd
  // event even when that event has no prompt marker. State that represents a
  // real user turn is still untouched below.
  recordCompletionEnvelope(input, event, config, store, nowMs);
  const handoffOwner = verifiedHandoffOwner(store, identity);
  if (!synthetic) {
    store.write(identity, 'debounce', decision.nextState);
    saveTimeline(store, identity, {
      lastEventAtMs: nowMs,
      ...(event === 'UserPromptSubmit' ? { lastUserActivityAtMs: nowMs } : {}),
      ...(event === 'PreToolUse' || event === 'PostToolUse' ? { lastWorkAtMs: nowMs, lastToolActivityAtMs: nowMs } : {}),
      ...(boolValue(input.pending_work) !== undefined ? { pendingWork: boolValue(input.pending_work) } : boolValue(input.pendingWork) !== undefined ? { pendingWork: boolValue(input.pendingWork) } : {}),
      ...(event === 'SessionStart' ? { sessionStartedAtMs: nowMs, ...(boolValue(input.pending_work) === undefined && boolValue(input.pendingWork) === undefined ? { pendingWork: false } : {}) } : {}),
      ...(event === 'SessionEnd' ? { sessionEndedAtMs: nowMs, ...(boolValue(input.pending_work) === undefined && boolValue(input.pendingWork) === undefined ? { pendingWork: false } : {}) } : {}),
      ...(event === 'Interrupt' && boolValue(input.pending_work) === undefined && boolValue(input.pendingWork) === undefined ? { pendingWork: false, interruptedAtMs: nowMs } : {}),
      ...(event === 'UserPromptSubmit' && boolValue(input.pending_work) === undefined && boolValue(input.pendingWork) === undefined ? { pendingWork: true } : {}),
      ...(lifecycleReason !== null && event !== 'UserPromptSubmit' ? { pendingWork: false } : {})
    });
    if (event === 'SubagentStart' && stringValue(input.agent_id) && facts.fiveHour?.usedPercent !== null && facts.fiveHour?.usedPercent !== undefined) {
      saveTimeline(store, identity, { spawnFiveHourPercent: facts.fiveHour.usedPercent, spawnResetAtMs: facts.fiveHour.resetsAtMs, ...(handoffOwner ? { parentThreadId: handoffOwner.parentThreadId } : {}) });
    }
  }

  if (synthetic) return { output: '{}', facts, decision, identity };

  let context = '';
  if (event === 'SubagentStart') context = buildSubagentText(input, facts, config, store, identity);
  else if (event === 'SubagentStop') {
    // This hook runs in the child thread. It cannot stand in for parent return
    // observation or acknowledgement; the parent's native wait result owns it.
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
    let spawn = typeof timeline === 'object' && timeline !== null && typeof (timeline as Record<string, unknown>)['spawnFiveHourPercent'] === 'number'
      ? (timeline as Record<string, unknown>)['spawnFiveHourPercent'] as number
      : null;
    if (spawn !== null && !facts.stale) {
      const row = timeline as Record<string, unknown>;
      const currentReset = facts.fiveHour?.resetsAtMs;
      const currentPercent = facts.fiveHour?.usedPercent;
      if (currentReset !== null && currentReset !== undefined && currentPercent !== null && currentPercent !== undefined
        && facts.fiveHour?.rolledOver !== true && typeof row['spawnResetAtMs'] === 'number' && row['spawnResetAtMs'] !== currentReset) {
        spawn = currentPercent;
        saveTimeline(store, identity, { spawnFiveHourPercent: spawn, spawnResetAtMs: currentReset });
      }
      const pause = shouldPause({ fiveHourPercent: facts.fiveHour?.usedPercent ?? null, fiveHourPercentAtSpawn: spawn, contextLevel: facts.context?.level, rolledOver: facts.fiveHour?.rolledOver }, config);
      if (pause.pause) context += `${context ? '\n\n' : ''}${formatPauseDirective({ agentId, pausePercent: effectivePause(config, spawn), ...(handoffOwner ? { handoffOwner } : {}) })}`;
    }
  }

  if (event === 'SubagentStart' && facts.fiveHour?.usedPercent !== null && facts.fiveHour?.usedPercent !== undefined) {
    const startAgentId = agentId ?? 'unknown-agent';
    const pause = effectivePause(config, facts.fiveHour.usedPercent);
    if (facts.fiveHour.usedPercent >= pause) context += `\n\n${formatPauseDirective({ agentId: startAgentId, pausePercent: pause, ...(handoffOwner ? { handoffOwner } : {}) })}`;
  }
  const plannedAgents = plannedAgentCount(input);
  if (plannedAgents !== undefined && plannedAgents > 1) {
    const advice = dispatchAdvice({ plannedAgents, fiveHourPercent: facts.fiveHour?.usedPercent ?? null }, config);
    if (advice.message !== null) context += `${context ? '\n\n' : ''}[pacekeeper] ${advice.message}`;
  }
  const continuationActive = boolValue(input.continuation_active) ?? boolValue(input.stop_hook_active) ?? false;
  return { output: output(event, context, continuationActive), facts, decision, identity };
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
