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
    const stop = runTick({ hook_event_name: 'Stop', thread_id: 'thread-1', account_id: 'acct-1', now_ms: NOW, observed_at_ms: NOW, rateLimits: limits, tokenUsage: { modelContextWindow: 100, last: { totalTokens: 1 } }, authenticated: true }, { config: CODEX_DEFAULTS, store });
    expect(JSON.parse(stop.output)).toMatchObject({ decision: 'block' });
    const compact = runTick({ hook_event_name: 'PreCompact', thread_id: 'thread-2', account_id: 'acct-1', now_ms: NOW, observed_at_ms: NOW, rateLimits: limits, tokenUsage: { modelContextWindow: 100, last: { totalTokens: 95 } }, authenticated: true }, { config: CODEX_DEFAULTS, store });
    expect(JSON.parse(compact.output)).toMatchObject({ continue: false });
    expect(JSON.parse(compact.output).hookSpecificOutput).toBeUndefined();
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
