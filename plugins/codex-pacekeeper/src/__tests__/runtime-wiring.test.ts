import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS } from '../config';
import { deliverJob } from '../delivery';
import { createJob, advance } from '../jobs';
import { runTick } from '../tick';
import { refreshObservations } from '../refresh';
import { CodexStore } from '../storage';

const NOW = 1_700_000_000_000;
const limits = {
  accountId: 'acct-1',
  rateLimits: {
    planType: 'plus',
    spendControlReached: false,
    primary: { usedPercent: 86, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 },
    secondary: { usedPercent: 51, windowDurationMins: 10_080, resetsAt: (NOW + 86_400_000) / 1000 }
  }
};

describe('Codex runtime wiring', () => {
  test('tick emits event-scoped status and persists deterministic state', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-home-'));
    const store = new CodexStore(home);
    const result = runTick({ hook_event_name: 'UserPromptSubmit', thread_id: 'thread-1', account_id: 'acct-1', now_ms: NOW, observed_at_ms: NOW, rateLimits: limits, authenticated: true }, { config: CODEX_DEFAULTS, store });
    expect(result.output).toContain('additionalContext');
    expect(result.output).toContain('5h=86%');
    expect(store.read(result.identity, 'debounce')).not.toBeNull();
  });

  test('synthetic marker leaves state untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-synthetic-'));
    const store = new CodexStore(home);
    const before = runTick({ hook_event_name: 'UserPromptSubmit', thread_id: 'thread-1', account_id: 'acct-1', now_ms: NOW, observed_at_ms: NOW, rateLimits: limits, authenticated: true }, { config: CODEX_DEFAULTS, store });
    const synthetic = runTick({ hook_event_name: 'UserPromptSubmit', thread_id: 'thread-1', account_id: 'acct-1', now_ms: NOW + 1, observed_at_ms: NOW + 1, rateLimits: limits, authenticated: true, prompt: '[pacekeeper-keepalive] ping' }, { config: CODEX_DEFAULTS, store });
    expect(synthetic.output).toBe('{}');
    expect(store.read(before.identity, 'debounce')).toEqual(store.read(before.identity, 'debounce'));
    expect((store.read(before.identity, 'timeline') as Record<string, unknown>)['lastEventAtMs']).toBe(NOW);
  });

  test('owned submission evidence classifies an unmarked synthetic stop and preserves user idle state', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-owned-synthetic-'));
    const store = new CodexStore(home);
    const created = createJob({ kind: 'keepalive', owner: { accountId: 'acct-1', threadId: 'thread-1' }, dueAtMs: NOW, submissionId: 'owned-submission' });
    const running = advance(advance(advance(created, { type: 'submitting' }), { type: 'accepted', queuedSubmissionId: 'queued-owned' }), { type: 'turn-started', turnId: 'turn-owned' });
    store.write({ accountId: 'acct-1', threadId: 'thread-1', agentId: `job-${created.id}` }, 'job', running);
    const result = runTick({ hook_event_name: 'Stop', thread_id: 'thread-1', account_id: 'acct-1', submission_id: 'owned-submission', turn_id: 'turn-owned', job_result: 'pong', native_completed: true, tool_calls: 0, now_ms: NOW }, { config: CODEX_DEFAULTS, store });
    expect(result.output).toBe('{}');
    expect(store.read(result.identity, 'timeline')).toBeNull();
    expect((store.read({ accountId: 'acct-1', threadId: 'thread-1', agentId: `job-${created.id}` }, 'job') as Record<string, unknown>)['state']).toBe('completed');
  });

  test('refresh stores normalized facts without the prompt payload', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-refresh-'));
    const store = new CodexStore(home);
    const identity = refreshObservations({ hook_event_name: 'PostToolUse', thread_id: 'thread-1', account_id: 'acct-1', now_ms: NOW, rateLimits: limits, tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 2 }, modelContextWindow: 100 } }, store);
    const file = store.pathFor(identity, 'timeline');
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('cachedInputTokens');
    expect(raw).not.toContain('prompt');
  });

  test('tick can consume the bounded normalized observation cache', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-cache-'));
    const store = new CodexStore(home);
    refreshObservations({ hook_event_name: 'PostToolUse', thread_id: 'thread-1', account_id: 'acct-1', now_ms: NOW, rateLimits: limits, tokenUsage: null, authenticated: true }, store);
    const result = runTick({ hook_event_name: 'Stop', thread_id: 'thread-1', account_id: 'acct-1', now_ms: NOW + 1000 }, { config: CODEX_DEFAULTS, store });
    expect(result.facts.fiveHour?.usedPercent).toBe(86);
    expect(result.facts.capacity).toBe('unknown');
  });

  test('stop and precompact use their event-specific native output fields', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-events-'));
    const store = new CodexStore(home);
    const stop = runTick({ hook_event_name: 'Stop', thread_id: 'thread-1', account_id: 'acct-1', stop_hook_active: true, now_ms: NOW, observed_at_ms: NOW, rateLimits: limits, tokenUsage: { modelContextWindow: 100, last: { totalTokens: 1 } }, authenticated: true }, { config: CODEX_DEFAULTS, store });
    expect(JSON.parse(stop.output)).toEqual({});
    const compact = runTick({ hook_event_name: 'PreCompact', thread_id: 'thread-2', account_id: 'acct-1', now_ms: NOW, observed_at_ms: NOW, rateLimits: limits, tokenUsage: { modelContextWindow: 100, last: { totalTokens: 95 } }, authenticated: true }, { config: CODEX_DEFAULTS, store });
    expect(JSON.parse(compact.output)).toMatchObject({ systemMessage: expect.any(String) });
    expect(JSON.parse(compact.output).continue).toBeUndefined();
    expect(JSON.parse(compact.output).hookSpecificOutput).toBeUndefined();
    const postCompact = runTick({ hook_event_name: 'PostCompact', thread_id: 'thread-2', account_id: 'acct-1', now_ms: NOW, observed_at_ms: NOW, rateLimits: limits, tokenUsage: { modelContextWindow: 100, last: { totalTokens: 95 } }, authenticated: true }, { config: CODEX_DEFAULTS, store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-runtime-postcompact-'))) });
    expect(JSON.parse(postCompact.output)).toMatchObject({ systemMessage: expect.any(String) });
    expect(JSON.parse(postCompact.output).hookSpecificOutput).toBeUndefined();
  });

  test('subagent stop suppresses output when the host is already continuing', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-subagent-stop-'));
    const store = new CodexStore(home);
    const result = runTick({ hook_event_name: 'SubagentStop', thread_id: 'thread-1', account_id: 'acct-1', agent_id: 'child-1', now_ms: NOW, stop_hook_active: true }, { config: CODEX_DEFAULTS, store });
    expect(result.decision.inject).toBe(false);
    expect(JSON.parse(result.output)).toEqual({});
  });

  test('native spawn tool input receives advisory fan-out guidance without denial', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-spawn-advice-'));
    const result = runTick({
      hook_event_name: 'PreToolUse',
      thread_id: 'thread-1',
      account_id: 'acct-1',
      tool_name: 'spawn_agent',
      tool_input: { agents: [{ type: 'worker' }, { type: 'worker' }] },
      now_ms: NOW,
      observed_at_ms: NOW,
      rateLimits: limits,
      authenticated: true
    }, { config: CODEX_DEFAULTS, store: new CodexStore(home) });
    expect(result.output).toContain('Dispatching 2 agents');
    expect(result.output).not.toContain('"decision":"block"');
  });

  test('native collab spawnAgent input maps receiver threads to advisory fan-out', () => {
    const result = runTick({
      hook_event_name: 'PreToolUse',
      thread_id: 'thread-1',
      account_id: 'acct-1',
      tool_name: 'collabAgentToolCall',
      tool_input: { tool: 'spawnAgent', receiverThreadIds: ['child-1', 'child-2'] },
      now_ms: NOW,
      observed_at_ms: NOW,
      rateLimits: limits,
      authenticated: true
    }, { config: CODEX_DEFAULTS, store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-runtime-native-spawn-'))) });
    expect(result.output).toContain('Dispatching 2 agents');
    expect(result.output).not.toContain('"decision":"block"');
  });

  test('delivery records submitting intent before queue acceptance and preserves stable id', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-runtime-delivery-'));
    const store = new CodexStore(home);
    const job = createJob({ kind: 'keepalive', owner: { accountId: 'acct-1', threadId: 'thread-1' }, dueAtMs: NOW, submissionId: 'stable-submission' });
    const calls: string[] = [];
    const client = {
      queueExistingThread: async (input: { threadId: string; message: string; clientUserMessageId: string }) => { calls.push(`${input.threadId}:${input.message}:${input.clientUserMessageId}`); return { status: 'accepted' as const, threadId: input.threadId, queuedSubmissionId: 'queued-1', clientUserMessageId: input.clientUserMessageId }; }
    } as never;
    const result = await deliverJob(client, job, '[pacekeeper-keepalive] ping', { read: () => null, write: (value) => store.write({ accountId: value.owner.accountId, threadId: value.owner.threadId, agentId: `job-${value.id}` }, 'job', value) });
    expect(result.job.state).toBe('queued');
    expect(result.job.submissionId).toBe('stable-submission');
    expect(calls).toEqual(['thread-1:[pacekeeper-keepalive] ping:stable-submission']);
  });
});
