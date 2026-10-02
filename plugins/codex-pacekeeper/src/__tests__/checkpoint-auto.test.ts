import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodexCheckpoints } from '../checkpoint';
import { CODEX_DEFAULTS } from '../config';
import { NativeClient, normalizeNativeCapabilities, RATE_LIMITS_READ_METHOD } from '../native';
import { CodexService } from '../service';
import { advance } from '../jobs';
import { CodexStore } from '../storage';
import { saveCheckpointWithResetWake } from '../checkpoint-cli';

const nowMs = Date.now();
const owner = { accountId: 'acct-save', threadId: 'thread-save' };

function clientFor(response: unknown): NativeClient {
  const capabilities = normalizeNativeCapabilities({ version: '0.160.0', methods: [RATE_LIMITS_READ_METHOD] });
  return new NativeClient({ request: async () => response }, capabilities, {
    ownerId: 'native-fixture',
    pid: 101,
    accountId: owner.accountId,
    threadIds: [owner.threadId],
    loadedThreadsObservedAtMs: nowMs,
    protocolVersion: '0.160.0'
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-checkpoint-auto-'));
  const store = new CodexStore(join(root, 'cache'));
  const checkpoints = new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: () => false });
  const service = new CodexService({
    config: CODEX_DEFAULTS,
    store,
    now: () => nowMs,
    projectRoot: root,
    checkpointExists: (expectedOwner, id, _projectRoot, resetGeneration) => checkpoints.list().some((entry) =>
      entry.id === id
      && entry.owner.accountId === expectedOwner.accountId
      && entry.owner.threadId === expectedOwner.threadId
      && entry.resetGeneration === resetGeneration)
  });
  return { root, store, checkpoints, service };
}

describe('automatic checkpoint reset registration', () => {
  test('accepts an owner observed after an asynchronous production discovery', async () => {
    const state = fixture();
    try {
      const resetAtMs = Date.now() + 30_000;
      const result = await saveCheckpointWithResetWake({
        checkpoints: state.checkpoints,
        service: state.service,
        owner,
        body: 'Save after native discovery completes.',
        lane: 'feature',
        worktree: state.root,
        resolveClient: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const client = clientFor({
            accountId: owner.accountId,
            rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: resetAtMs } }
          });
          client.owner.loadedThreadsObservedAtMs = Date.now();
          return client;
        }
      });
      expect(result.withheldReason).toBeUndefined();
      expect(result.wake?.job.resetGeneration).toBe(resetAtMs);
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('saves first, then registers a wake against the fresh native account and reset identity', async () => {
    const state = fixture();
    try {
      const resetAtMs = nowMs + 30_000;
      const result = await saveCheckpointWithResetWake({
        checkpoints: state.checkpoints,
        service: state.service,
        owner,
        body: 'Continue from the verified checkpoint.',
        lane: 'feature',
        worktree: state.root,
        nowMs,
        resolveClient: async () => clientFor({
          accountId: owner.accountId,
          ordinaryUsageAllowed: true,
          rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: resetAtMs } }
        })
      });

      expect(state.checkpoints.peek(result.checkpoint.id)?.owner).toEqual(owner);
      expect(state.checkpoints.peek(result.checkpoint.id)?.resetGeneration).toBe(resetAtMs);
      expect(result.wake?.job.owner).toEqual(owner);
      expect(result.wake?.job.resetGeneration).toBe(resetAtMs);
      expect(state.checkpoints.peek(result.checkpoint.id)?.body).toContain('verified checkpoint');
      const timeline = state.store.read({ ...owner, agentId: `job-${result.wake?.job.id}` }, 'timeline') as Record<string, unknown>;
      expect(timeline).toMatchObject({ checkpointId: result.checkpoint.id, resetAtMs, resetGeneration: resetAtMs, projectRoot: state.root });
      expect(result.withheldReason).toBeUndefined();
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('updates a scheduled wake to the exact replacement checkpoint in the same reset window', async () => {
    const state = fixture();
    try {
      const resetAtMs = nowMs + 30_000;
      const save = (body: string) => saveCheckpointWithResetWake({
        checkpoints: state.checkpoints,
        service: state.service,
        owner,
        body,
        lane: 'feature',
        worktree: state.root,
        nowMs,
        resolveClient: async () => clientFor({
          accountId: owner.accountId,
          rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: resetAtMs } }
        })
      });
      const first = await save('First checkpoint.');
      const second = await save('Replacement checkpoint.');
      expect(second.wake?.job.id).toBe(first.wake?.job.id);
      expect(state.service.jobs()).toHaveLength(1);
      expect(state.checkpoints.list().some((entry) => entry.id === first.checkpoint.id)).toBe(false);
      const timeline = state.store.read({ ...owner, agentId: `job-${second.wake?.job.id}` }, 'timeline');
      expect(timeline).toMatchObject({ checkpointId: second.checkpoint.id, resetAtMs });
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('does not replace the checkpoint of a wake that has already entered native submission', async () => {
    const state = fixture();
    try {
      const resetAtMs = nowMs + 30_000;
      const save = (body: string) => saveCheckpointWithResetWake({
        checkpoints: state.checkpoints,
        service: state.service,
        owner,
        body,
        lane: 'feature',
        worktree: state.root,
        nowMs,
        resolveClient: async () => clientFor({
          accountId: owner.accountId,
          rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: resetAtMs } }
        })
      });
      const first = await save('Submitted checkpoint.');
      if (first.wake === null) throw new Error('fixture did not register a wake');
      const identity = { ...owner, agentId: `job-${first.wake.job.id}` };
      state.store.write(identity, 'job', advance(first.wake.job, { type: 'submitting' }));
      const second = await save('Manual replacement.');
      expect(second.wake).toBeNull();
      expect(second.withheldReason).toContain('already started');
      expect(state.checkpoints.peek(second.checkpoint.id)?.body).toBe('Manual replacement.');
      expect(state.store.read(identity, 'timeline')).toMatchObject({ checkpointId: first.checkpoint.id });
      expect(state.service.jobs()).toHaveLength(1);
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('keeps a manual checkpoint when the native owner is unavailable and explains why no wake was registered', async () => {
    const state = fixture();
    try {
      const result = await saveCheckpointWithResetWake({
        checkpoints: state.checkpoints,
        service: state.service,
        owner,
        body: 'Manual save remains available.',
        lane: 'feature',
        worktree: state.root,
        requestedResetGeneration: nowMs + 123_000,
        nowMs,
        resolveClient: async () => null
      });

      expect(result.checkpoint.id).toBeTruthy();
      expect(state.checkpoints.peek(result.checkpoint.id)?.body).toContain('Manual save');
      expect(state.checkpoints.peek(result.checkpoint.id)?.resetGeneration).toBeUndefined();
      expect(result.wake).toBeNull();
      expect(result.withheldReason).toMatch(/native owner/i);
      expect(state.service.jobs()).toHaveLength(0);
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('does not register a reset observed for a different account', async () => {
    const state = fixture();
    try {
      const result = await saveCheckpointWithResetWake({
        checkpoints: state.checkpoints,
        service: state.service,
        owner,
        body: 'Keep the ordinary save.',
        lane: 'feature',
        worktree: state.root,
        nowMs,
        resolveClient: async () => clientFor({
          accountId: 'acct-foreign',
          rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: nowMs + 30_000 } }
        })
      });

      expect(state.checkpoints.peek(result.checkpoint.id)?.owner).toEqual(owner);
      expect(state.checkpoints.peek(result.checkpoint.id)?.resetGeneration).toBeUndefined();
      expect(result.wake).toBeNull();
      expect(result.withheldReason).toMatch(/account/i);
      expect(state.service.jobs()).toHaveLength(0);
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('does not register a reset from a stale loaded-thread observation', async () => {
    const state = fixture();
    try {
      const staleClient = clientFor({
        accountId: owner.accountId,
        rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: nowMs + 30_000 } }
      });
      staleClient.owner.loadedThreadsObservedAtMs = nowMs - 5_001;
      const result = await saveCheckpointWithResetWake({
        checkpoints: state.checkpoints,
        service: state.service,
        owner,
        body: 'Keep the ordinary save.',
        lane: 'feature',
        worktree: state.root,
        nowMs,
        resolveClient: async () => staleClient
      });

      expect(state.checkpoints.peek(result.checkpoint.id)?.resetGeneration).toBeUndefined();
      expect(result.wake).toBeNull();
      expect(result.withheldReason).toMatch(/native owner/i);
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('does not persist a caller-supplied reset generation that contradicts the native reset', async () => {
    const state = fixture();
    try {
      const observedResetAtMs = nowMs + 30_000;
      const result = await saveCheckpointWithResetWake({
        checkpoints: state.checkpoints,
        service: state.service,
        owner,
        body: 'Keep the ordinary save.',
        lane: 'feature',
        worktree: state.root,
        requestedResetGeneration: observedResetAtMs + 1,
        nowMs,
        resolveClient: async () => clientFor({
          accountId: owner.accountId,
          rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: observedResetAtMs } }
        })
      });

      expect(state.checkpoints.peek(result.checkpoint.id)?.resetGeneration).toBeUndefined();
      expect(result.wake).toBeNull();
      expect(result.withheldReason).toMatch(/does not match/i);
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });
});
