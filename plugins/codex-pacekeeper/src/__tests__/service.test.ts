import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CODEX_DEFAULTS } from '../config';
import { NativeClient, normalizeNativeCapabilities } from '../native';
import { advance } from '../jobs';
import { CodexService } from '../service';
import { CodexStore } from '../storage';

const NOW = 1_700_000_000_000;
const owner = { accountId: 'acct-service', threadId: 'thread-service' };

function fakeClient(calls: string[]): NativeClient {
  const capabilities = normalizeNativeCapabilities({ version: '0.153.4', methods: ['thread/queue/add', 'thread/queue/delete', 'thread/queue/list'] });
  return new NativeClient({
    request: async (method, params) => {
      calls.push(`${method}:${JSON.stringify(params)}`);
      if (method === 'thread/queue/delete') return { deleted: true };
      if (method === 'thread/queue/list') return { data: [] };
      return { queuedSubmission: { id: 'queued-service', clientUserMessageId: (params as { clientUserMessageId: string }).clientUserMessageId, input: [] } };
    }
  }, capabilities, { ownerId: 'owner-service', pid: process.pid, accountId: owner.accountId, threadIds: [owner.threadId], protocolVersion: '0.153.4' });
}

describe('Codex durable service', () => {
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
    const completed = service.recordCompletion(scheduled.id, 'pong', true, 0);
    expect(completed?.pongVerified).toBe(true);
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

  test('reset wake identity carries the exact reset generation and differs from recurring keepalive', () => {
    const service = new CodexService({ config: CODEX_DEFAULTS, store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-'))), now: () => NOW, eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }) });
    const recurring = service.scheduleKeepalive(owner, NOW + 1000);
    const wake = service.scheduleResetWake(owner, 'checkpoint-1', NOW + 1000, NOW + 1000);
    expect(wake.job.kind).toBe('reset-wake');
    expect(wake.job.resetGeneration).toBe(NOW + 1000);
    expect(wake.job.id).not.toBe(recurring.id);
  });

  test('reset wake cannot complete until exact checkpoint archival is acknowledged', async () => {
    const calls: string[] = [];
    const service = new CodexService({ config: CODEX_DEFAULTS, store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-consume-'))), now: () => NOW, resolveClient: async () => fakeClient(calls), eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }), consumeCheckpoint: async (_job, checkpointId) => checkpointId === 'checkpoint-exact' });
    const wake = service.scheduleResetWake(owner, 'checkpoint-exact', NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1000, NOW - 1000);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected reset wake');
    const completed = await service.recordResetWakeCompletion(queued.id, 'resume acknowledged', true, 0);
    expect(completed?.state).toBe('completed');
    expect(completed?.pongVerified).toBe(false);
  });

  test('reset wake completion tolerates an archive already acknowledged before a crash', async () => {
    const service = new CodexService({
      config: CODEX_DEFAULTS,
      store: new CodexStore(mkdtempSync(join(tmpdir(), 'codex-service-reset-idempotent-'))),
      now: () => NOW,
      resolveClient: async () => fakeClient([]),
      eligibility: () => ({ nowMs: NOW, enabled: true, capacity: 'included', pendingWork: true, ownerLive: true, fresh: true, idleForMs: 0, strict: true }),
      consumeCheckpoint: async () => 'already-consumed'
    });
    const wake = service.scheduleResetWake(owner, 'checkpoint-exact', NOW - CODEX_DEFAULTS.auto.wake_delay_min * 60_000 - 1000, NOW - 1000);
    const queued = (await service.runDueJobs())[0];
    if (!queued) throw new Error('expected reset wake');
    const completed = await service.recordResetWakeCompletion(queued.id, 'resume acknowledged', true, 0);
    expect(completed?.state).toBe('completed');
  });
});
