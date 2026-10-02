import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CODEX_DEFAULTS } from '../config';
import { ACCOUNT_READ_METHOD, NativeClient, normalizeNativeCapabilities, QUEUE_ADD_METHOD, RATE_LIMITS_READ_METHOD } from '../native';
import { advance, createJob } from '../jobs';
import { CodexService, parseServiceArgs } from '../service';
import { CodexStore } from '../storage';
import { CodexCheckpoints } from '../checkpoint';
import { writeHandoff } from '../agent-budget';
import { execFileSync } from 'child_process';
import { runTick } from '../tick';

const NOW = 1_700_000_000_000;
const owner = { accountId: 'acct-service', threadId: 'thread-service' };

function fakeClient(calls: string[]): NativeClient {
  const capabilities = normalizeNativeCapabilities({ version: '0.153.4', methods: ['thread/queue/add', 'thread/queue/delete', 'thread/queue/list'] });
  // Deterministic lifecycle tests model the native strict controls that a
  // real production owner must prove before a keepalive is enabled.
  Object.assign(capabilities, { toolDisable: 'supported', preModelSuppression: 'supported' });
  return new NativeClient({
    request: async (method, params) => {
      calls.push(`${method}:${JSON.stringify(params)}`);
      if (method === 'thread/queue/delete') return { deleted: true };
      if (method === 'thread/queue/list') return { data: [] };
      return { queuedSubmission: { id: 'queued-service', clientUserMessageId: (params as { clientUserMessageId: string }).clientUserMessageId, input: [] } };
    }
  }, capabilities, { ownerId: 'owner-service', pid: process.pid, accountId: owner.accountId, threadIds: [owner.threadId], protocolVersion: '0.153.4' });
}

function freshFactsClient(calls: string[]): NativeClient {
  const capabilities = normalizeNativeCapabilities({ version: '0.160.0', methods: [ACCOUNT_READ_METHOD, RATE_LIMITS_READ_METHOD, QUEUE_ADD_METHOD] });
  Object.assign(capabilities, { toolDisable: 'supported', preModelSuppression: 'supported' });
  return new NativeClient({
    request: async (method, params) => {
      calls.push(`${method}:${JSON.stringify(params)}`);
      if (method === ACCOUNT_READ_METHOD) return { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false };
      if (method === RATE_LIMITS_READ_METHOD) return {
        accountId: owner.accountId,
        ordinaryUsageAllowed: true,
        rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } }
      };
      return { queuedSubmission: { id: 'queued-fresh', clientUserMessageId: (params as { clientUserMessageId: string }).clientUserMessageId, input: [] } };
    }
  }, capabilities, { ownerId: 'owner-fresh', pid: process.pid, accountId: owner.accountId, threadIds: [owner.threadId], protocolVersion: '0.160.0' });
}

function resetTimelineIdentity(wake: { job: { owner: { accountId: string | null; threadId: string }; id: string } }): { accountId: string | null; threadId: string; agentId: string } {
  return { accountId: wake.job.owner.accountId, threadId: wake.job.owner.threadId, agentId: `job-${wake.job.id}` };
}

function writeResetFacts(store: CodexStore, wake: { job: { owner: { accountId: string | null; threadId: string }; id: string } }, resetAtMs: number, nextResetAtMs: number | null): void {
  const identity = resetTimelineIdentity(wake);
  const timeline = store.read(identity, 'timeline') as Record<string, unknown>;
  store.write(identity, 'timeline', { ...timeline, resetAtMs });
  store.write(wake.job.owner, 'timeline', {
    ...wake.job.owner,
    quotaObservedAtMs: NOW,
    ordinaryUsageObservedAtMs: NOW,
    authenticated: true,
    rateLimits: {
      accountId: owner.accountId,
      ordinaryUsageAllowed: true,
      rateLimits: {
        planType: 'plus',
        spendControlReached: false,
        ...(nextResetAtMs === null ? {} : { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: nextResetAtMs / 1000 } })
      }
    },
    resetAtMs
  });
}

describe('Codex durable service', () => {
  test('a subagent stop finds CLI-root handoffs below a checkout without a quota warning', () => {
    const fixtures = join(import.meta.dir, '.service-fixtures');
    mkdirSync(fixtures, { recursive: true });
    const project = mkdtempSync(join(fixtures, 'handoff-root-'));
    try {
      execFileSync('git', ['init', '-q', project]);
      mkdirSync(join(project, 'src'));
      writeHandoff({ cwd: project, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'child-root', trigger: 'budget_pause', body: 'Continue step two.' });
      const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-handoff-stop-')));
      const result = runTick({ hook_event_name: 'SubagentStop', session_id: owner.threadId, account_id: owner.accountId, agent_id: 'child-root', cwd: join(project, 'src'), now_ms: NOW }, { config: CODEX_DEFAULTS, store });
      expect(result.output).toContain('A handoff is pending for child-root');
      const continuation = runTick({ hook_event_name: 'SubagentStop', session_id: owner.threadId, account_id: owner.accountId, agent_id: 'child-root', cwd: join(project, 'src'), stop_hook_active: true, now_ms: NOW }, { config: CODEX_DEFAULTS, store });
      expect(continuation.output).toBe('{}');
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('native owner refresh supplies reset readiness without test-written job quota', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-reset-owner-facts-')));
    store.write(owner, 'timeline', { ...owner, pendingWork: true, lastUserActivityAtMs: NOW - 60_000 });
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => freshFactsClient(calls), checkpointExists: () => true });
    const wake = service.scheduleResetWake(owner, 'checkpoint-native', NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1_000, 91);
    const result = (await service.runDueJobs()).find((job) => job.id === wake.job.id);
    expect(result?.state).toBe('queued');
    expect(calls.some((call) => call.startsWith(`${QUEUE_ADD_METHOD}:`) && call.includes('[pacekeeper-resume] checkpoint-native'))).toBe(true);
  });

  test('a restarted service verifies the reset checkpoint in its recorded project', async () => {
    const fixtures = join(import.meta.dir, '.service-fixtures');
    mkdirSync(fixtures, { recursive: true });
    const project = mkdtempSync(join(fixtures, 'reset-root-'));
    try {
      const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-reset-root-store-')));
      store.write(owner, 'timeline', { ...owner, pendingWork: true, lastUserActivityAtMs: NOW - 60_000 });
      const checkpoint = new CodexCheckpoints(project, CODEX_DEFAULTS).save({ lane: 'reset', owner, body: 'Goal: continue fixture work', resetGeneration: 92 });
      const scheduler = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, projectRoot: project });
      expect(() => scheduler.scheduleResetWake(owner, checkpoint.id, NOW, 93)).toThrow(/checkpoint/);
      const wake = scheduler.scheduleResetWake(owner, checkpoint.id, NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1_000, 92);
      const restarted = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => freshFactsClient([]) });
      const result = (await restarted.runDueJobs()).find((job) => job.id === wake.job.id);
      expect(result?.state).toBe('queued');
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('public schedule-reset command preserves exact owner and reset arguments', () => {
    expect(parseServiceArgs([
      'schedule-reset',
      '--cwd', 'project root',
      '--account-id', 'acct-service',
      '--thread-id=thread-service',
      '--checkpoint-id', 'checkpoint-1',
      '--reset-at-ms', '1700000000000',
      '--reset-generation=4'
    ])).toEqual({
      action: 'schedule-reset',
      flags: {
        cwd: 'project root',
        'account-id': 'acct-service',
        'thread-id': 'thread-service',
        'checkpoint-id': 'checkpoint-1',
        'reset-at-ms': '1700000000000',
        'reset-generation': '4'
      }
    });
  });

  test('rescheduling an unresolved submission returns the same job', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-unresolved-')));
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient([]), eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const scheduled = service.scheduleKeepalive(owner, NOW);
    const submitting = advance(scheduled, { type: 'submitting' });
    store.write({ accountId: owner.accountId, threadId: owner.threadId, agentId: `job-${scheduled.id}` }, 'job', submitting);
    expect(service.scheduleKeepalive(owner, NOW + 1_000).id).toBe(scheduled.id);
    const reconciled = (await service.runDueJobs())[0];
    expect(reconciled?.state).toBe('ambiguous');
    expect(service.scheduleKeepalive(owner, NOW + 2_000).id).toBe(scheduled.id);
  });

  test('a recovered submitting job is reconciled before any new send', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-recover-')));
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient(calls), eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const scheduled = service.scheduleKeepalive(owner, NOW);
    const submitting = advance(scheduled, { type: 'submitting' });
    store.write({ accountId: owner.accountId, threadId: owner.threadId, agentId: `job-${scheduled.id}` }, 'job', submitting);
    // fakeClient's queue list is empty, so this becomes ambiguous and no add
    // call is made; this is the conservative recovery boundary.
    const result = (await service.runDueJobs())[0];
    expect(result?.state).toBe('ambiguous');
    expect(calls.filter((call) => call.startsWith('thread/queue/add'))).toHaveLength(0);
  });

  test('runs an eligible keepalive through an existing owner and verifies completion separately', async () => {
    const calls: string[] = [];
    const service = new CodexService({ config: CODEX_DEFAULTS, store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-'))), now: () => NOW, resolveClient: async () => fakeClient(calls), eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const scheduled = service.scheduleKeepalive(owner, NOW);
    expect(scheduled.state).toBe('scheduled');
    const queued = (await service.runDueJobs())[0];
    expect(queued?.state).toBe('queued');
    expect(calls[0]).toContain('[pacekeeper-keepalive] ping');
    const completed = service.recordCompletion(scheduled.id, 'pong', true, 0, scheduled.submissionId);
    expect(completed?.pongVerified).toBe(true);
  });

  test('a stale completion envelope cannot complete the successor attempt', async () => {
    const service = new CodexService({
      config: CODEX_DEFAULTS,
      store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-attempt-'))),
      now: () => NOW,
      resolveClient: async () => fakeClient([]),
      eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true })
    });
    const first = service.scheduleKeepalive(owner, NOW);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected queued first attempt');
    const completed = service.recordCompletion(first.id, 'pong', true, 0, first.submissionId);
    expect(completed?.pongVerified).toBe(true);
    const successor = service.jobs()[0];
    if (!successor) throw new Error('expected successor attempt');
    const before = successor.state;
    const replay = service.recordCompletion(first.id, 'pong', true, 0, first.submissionId);
    expect(replay?.submissionId).toBe(successor.submissionId);
    expect(service.jobs().find((job) => job.submissionId === successor.submissionId)?.state).toBe(before);
  });

  test('user activity cancels before native delivery', async () => {
    const calls: string[] = [];
    const service = new CodexService({ config: CODEX_DEFAULTS, store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-cancel-'))), now: () => NOW, resolveClient: async () => fakeClient(calls), eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, userActiveSinceMs: NOW, strict: true }) });
    const scheduled = service.scheduleKeepalive(owner, NOW);
    const result = (await service.runDueJobs())[0];
    expect(scheduled.state).toBe('cancelled');
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(scheduled.cancelReason ?? '').toContain('user');
  });

  test('session end cancels owned queued work and acknowledges native deletion', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-session-end-')));
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient(calls), eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const scheduled = service.scheduleKeepalive(owner, NOW);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected queued job');
    store.write({ accountId: owner.accountId, threadId: owner.threadId }, 'timeline', { sessionStartedAtMs: NOW - 60_000, sessionEndedAtMs: NOW });
    const cancelled = (await service.runDueJobs())[0];
    expect(cancelled?.state).toBe('cancelled');
    expect(cancelled?.cancelReason).toContain('session ended');
    expect(calls.some((call) => call.startsWith('thread/queue/delete'))).toBe(true);
    expect(scheduled.id).toBe(cancelled?.id ?? '');
  });

  test('queued cancellation advances only after native delete acknowledgement', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-delete-')));
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient(calls), eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const scheduled = service.scheduleKeepalive(owner, NOW);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected queued job');
    const cancelled = await service.cancel(queued.id, 'user became active');
    expect(cancelled?.state).toBe('cancelled');
    expect(calls.some((call) => call.startsWith('thread/queue/delete'))).toBe(true);
    expect(scheduled.id).toBe(cancelled?.id ?? '');
  });

  test('queued cancellation intent survives an unavailable owner', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-delete-later-')));
    let available = true;
    const service = new CodexService({
      config: CODEX_DEFAULTS,
      store,
      now: () => NOW,
      resolveClient: async () => available ? fakeClient([]) : null,
      eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true })
    });
    const scheduled = service.scheduleKeepalive(owner, NOW);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected queued job');
    available = false;
    const requested = await service.cancel(queued.id, 'user became active');
    expect(requested?.state).toBe('queued');
    expect(requested?.cancelRequested).toBe(true);
    available = true;
    const reconciled = (await service.runDueJobs())[0];
    expect(reconciled?.state).toBe('cancelled');
    expect(scheduled.id).toBe(reconciled?.id ?? '');
  });

  test('service loop materializes one pending-work keepalive from observed timeline state', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-bootstrap-')));
    store.write({ accountId: owner.accountId, threadId: owner.threadId }, 'timeline', {
      accountId: owner.accountId,
      threadId: owner.threadId,
      pendingWork: true,
      lastUserActivityAtMs: NOW - 60_000,
      rateLimits: { accountId: owner.accountId, ordinaryUsageAllowed: true, rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 10, windowDurationMins: 300 } } },
      quotaObservedAtMs: NOW,
      authenticated: true,
      authObservedAtMs: NOW
    });
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => null, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 60_000, strict: true }) });
    await service.runDueJobs();
    expect(service.jobs()).toHaveLength(1);
    expect(service.jobs()[0]?.state).toBe('scheduled');
  });

  test('watch refreshes stale cached eligibility through the selected native owner before scheduling', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-fresh-refresh-')));
    store.write({ accountId: owner.accountId, threadId: owner.threadId }, 'timeline', {
      accountId: owner.accountId,
      threadId: owner.threadId,
      pendingWork: true,
      lastUserActivityAtMs: NOW - 60_000,
      quotaObservedAtMs: NOW - 600_000,
      authenticated: true,
      authObservedAtMs: NOW - 600_000,
      rateLimits: { accountId: owner.accountId, ordinaryUsageAllowed: true, rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 10, windowDurationMins: 300 } } }
    });
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => freshFactsClient(calls) });
    await service.runDueJobs();
    const timeline = store.read({ accountId: owner.accountId, threadId: owner.threadId }, 'timeline') as Record<string, unknown>;
    expect(timeline['quotaObservedAtMs']).toBe(NOW);
    expect(timeline['authObservedAtMs']).toBe(NOW);
    expect(service.jobs()).toHaveLength(1);
    expect(calls.some((call) => call.startsWith(`${RATE_LIMITS_READ_METHOD}:`))).toBe(true);
    expect(calls.some((call) => call.startsWith(`${ACCOUNT_READ_METHOD}:`))).toBe(true);
  });

  test('a fresh owner refresh mismatch withholds a job despite fresh old cached facts', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-account-switch-')));
    const capabilities = normalizeNativeCapabilities({ version: '0.160.0', methods: [ACCOUNT_READ_METHOD, RATE_LIMITS_READ_METHOD, QUEUE_ADD_METHOD] });
    const switched = new NativeClient({
      request: async (method, params) => {
        calls.push(`${method}:${JSON.stringify(params)}`);
        if (method === ACCOUNT_READ_METHOD) return { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false };
        if (method === RATE_LIMITS_READ_METHOD) return {
          accountId: 'acct-switched',
          ordinaryUsageAllowed: true,
          rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } }
        };
        return { queuedSubmission: { id: 'queued-switched', clientUserMessageId: (params as { clientUserMessageId: string }).clientUserMessageId, input: [] } };
      }
    }, capabilities, { ownerId: 'owner-switched', pid: process.pid, accountId: 'acct-switched', threadIds: [owner.threadId], protocolVersion: '0.160.0' });
    const job = createJob({ kind: 'keepalive', owner, dueAtMs: NOW, submissionId: 'submission-switch' });
    store.write({ accountId: owner.accountId, threadId: owner.threadId, agentId: `job-${job.id}` }, 'job', job);
    store.write({ accountId: owner.accountId, threadId: owner.threadId }, 'timeline', {
      accountId: owner.accountId,
      threadId: owner.threadId,
      pendingWork: true,
      lastUserActivityAtMs: NOW - 60_000,
      quotaObservedAtMs: NOW,
      authObservedAtMs: NOW,
      authenticated: true,
      rateLimits: { accountId: owner.accountId, ordinaryUsageAllowed: true, rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } } }
    });
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => switched });
    const result = (await service.runDueJobs())[0];
    expect(result?.state).toBe('scheduled');
    expect(result?.failureReason).toContain('recorded account');
    expect(calls.some((call) => call.startsWith(`${QUEUE_ADD_METHOD}:`))).toBe(false);
  });

  test('reset wake identity carries the exact reset generation and differs from recurring keepalive', () => {
    const service = new CodexService({ config: CODEX_DEFAULTS, store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-'))), now: () => NOW, checkpointExists: () => true, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const recurring = service.scheduleKeepalive(owner, NOW + 1000);
    const wake = service.scheduleResetWake(owner, 'checkpoint-1', NOW + 1000, NOW + 1000);
    expect(wake.job.kind).toBe('reset-wake');
    expect(wake.job.resetGeneration).toBe(NOW + 1000);
    expect(wake.job.id).not.toBe(recurring.id);
  });

  test('reset wake rejects a reset outside the configured bridge window', () => {
    const service = new CodexService({ config: CODEX_DEFAULTS, store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-window-'))), now: () => NOW, checkpointExists: () => true, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    expect(() => service.scheduleResetWake(owner, 'checkpoint-1', NOW + (CODEX_DEFAULTS.bridge.max_wait_min + 1) * 60_000, NOW + 1)).toThrow(/bridge window/);
  });

  test('reset wake stays scheduled when the fresh response has no five-hour window', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-no-window-')));
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient(calls), checkpointExists: () => true, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const resetAtMs = NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1_000;
    const wake = service.scheduleResetWake(owner, 'checkpoint-no-window', resetAtMs, 77);
    store.write(wake.job.owner, 'timeline', {
      ...wake.job.owner,
      quotaObservedAtMs: NOW,
      ordinaryUsageObservedAtMs: NOW,
      authenticated: true,
      rateLimits: { accountId: owner.accountId, ordinaryUsageAllowed: true, rateLimits: { planType: 'plus', spendControlReached: false } }
    });
    const result = (await service.runDueJobs())[0];
    expect(result?.id).toBe(wake.job.id);
    expect(result?.state).toBe('scheduled');
    expect(result?.failureReason).toContain('unavailable');
    expect(calls.some((call) => call.startsWith(`${QUEUE_ADD_METHOD}:`))).toBe(false);
  });

  test('reset wake stays scheduled when the fresh response repeats the ended window', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-unchanged-window-')));
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient(calls), checkpointExists: () => true, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const resetAtMs = NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1_000;
    const wake = service.scheduleResetWake(owner, 'checkpoint-ended-window', resetAtMs, 78);
    store.write(wake.job.owner, 'timeline', {
      ...wake.job.owner,
      quotaObservedAtMs: NOW,
      ordinaryUsageObservedAtMs: NOW,
      authenticated: true,
      rateLimits: { accountId: owner.accountId, ordinaryUsageAllowed: true, rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetAtMs / 1000 } } }
    });
    const result = (await service.runDueJobs())[0];
    expect(result?.id).toBe(wake.job.id);
    expect(result?.state).toBe('scheduled');
    expect(result?.failureReason).toContain('still ended');
    expect(calls.some((call) => call.startsWith(`${QUEUE_ADD_METHOD}:`))).toBe(false);
  });

  test('reset wake sends only after a fresh next-window identity is observed', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-next-window-')));
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient(calls), checkpointExists: () => true, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const resetAtMs = NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1_000;
    const wake = service.scheduleResetWake(owner, 'checkpoint-next-window', resetAtMs, 79);
    store.write(wake.job.owner, 'timeline', {
      ...wake.job.owner,
      quotaObservedAtMs: NOW,
      ordinaryUsageObservedAtMs: NOW,
      authenticated: true,
      rateLimits: { accountId: owner.accountId, ordinaryUsageAllowed: true, rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } } }
    });
    const result = (await service.runDueJobs())[0];
    expect(result?.id).toBe(wake.job.id);
    expect(result?.state).toBe('queued');
    expect(calls.some((call) => call.startsWith(`${QUEUE_ADD_METHOD}:`))).toBe(true);
  });

  test('reset wake is cancelled when its exact checkpoint is superseded before delivery', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-superseded-')));
    let active = true;
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient(calls), checkpointExists: () => active, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const resetAtMs = NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1_000;
    const wake = service.scheduleResetWake(owner, 'checkpoint-superseded', resetAtMs, 80);
    writeResetFacts(store, wake, resetAtMs, NOW + 3_600_000);
    active = false;
    const result = (await service.runDueJobs())[0];
    expect(result?.state).toBe('cancelled');
    expect(result?.cancelReason).toContain('no longer active');
    expect(calls.some((call) => call.startsWith(`${QUEUE_ADD_METHOD}:`))).toBe(false);
  });

  test('reset wake remains blocked when native pre-model cancellation is unavailable', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-suppression-')));
    const client = fakeClient(calls);
    client.capabilities.preModelSuppression = 'unsupported';
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => client, checkpointExists: () => true, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const resetAtMs = NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1_000;
    const wake = service.scheduleResetWake(owner, 'checkpoint-no-suppression', resetAtMs, 81);
    writeResetFacts(store, wake, resetAtMs, NOW + 3_600_000);
    const result = (await service.runDueJobs())[0];
    expect(result?.state).toBe('rejected');
    expect(result?.failureReason).toContain('pre-model cancellation');
    expect(calls.some((call) => call.startsWith(`${QUEUE_ADD_METHOD}:`))).toBe(false);
  });

  test('reset wake cannot complete until exact checkpoint archival is acknowledged', async () => {
    const calls: string[] = [];
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-consume-')));
    const service = new CodexService({ config: CODEX_DEFAULTS, store, now: () => NOW, resolveClient: async () => fakeClient(calls), checkpointExists: () => true, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }), consumeCheckpoint: async (_job, checkpointId) => checkpointId === 'checkpoint-exact' });
    const wake = service.scheduleResetWake(owner, 'checkpoint-exact', NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1000, NOW - 1000);
    writeResetFacts(store, wake, NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1000, NOW + 3_600_000);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected reset wake');
    // Resuming the checkpoint may execute CLI tools; completion is gated by
    // the exact native turn and archive acknowledgement instead of a
    // keepalive-style zero-tool rule.
    const completed = await service.recordResetWakeCompletion(queued.id, 'resume acknowledged', true, 2, queued.submissionId, 'turn-reset-1');
    expect(completed?.state).toBe('completed');
    expect(completed?.pongVerified).toBe(false);
  });

  test('reset wake completion tolerates an archive already acknowledged before a crash', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-idempotent-')));
    const service = new CodexService({
      config: CODEX_DEFAULTS,
      store,
      now: () => NOW,
      resolveClient: async () => fakeClient([]),
      checkpointExists: () => true,
      eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }),
      consumeCheckpoint: async () => 'already-consumed'
    });
    const wake = service.scheduleResetWake(owner, 'checkpoint-exact', NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1000, NOW - 1000);
    writeResetFacts(store, wake, NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1000, NOW + 3_600_000);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected reset wake');
    const completed = await service.recordResetWakeCompletion(queued.id, 'resume acknowledged', true, 1, queued.submissionId, 'turn-reset-2');
    expect(completed?.state).toBe('completed');
  });

  test('reset wake refuses an uncorrelated completion even when archival is ready', async () => {
    let consumed = false;
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-correlation-')));
    const service = new CodexService({
      config: CODEX_DEFAULTS,
      store,
      now: () => NOW,
      resolveClient: async () => fakeClient([]),
      checkpointExists: () => true,
      eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }),
      consumeCheckpoint: async () => { consumed = true; return true; }
    });
    const wake = service.scheduleResetWake(owner, 'checkpoint-exact', NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1000, NOW - 1000);
    writeResetFacts(store, wake, NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1000, NOW + 3_600_000);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected reset wake');
    const missingTurn = await service.recordResetWakeCompletion(queued.id, 'resume acknowledged', true, 2, queued.submissionId);
    expect(missingTurn?.state).toBe('queued');
    expect(consumed).toBe(false);
  });
});
