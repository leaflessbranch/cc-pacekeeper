import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodexCheckpoints } from '../checkpoint';
import { CODEX_DEFAULTS } from '../config';
import { CodexService } from '../service';
import { advance } from '../jobs';
import { ACCOUNT_IDENTITY, CodexStore } from '../storage';
import { discoverResetEvidence, saveCheckpointWithResetWake, type ResetEvidence } from '../checkpoint-cli';

const nowMs = Date.now();
const owner = { accountId: null, threadId: '019a0000-0000-7000-8000-0000000saver' };
const ACCOUNT = 'acct-save';

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
      entry.id === id && entry.owner.threadId === expectedOwner.threadId && entry.resetGeneration === resetGeneration)
  });
  return { root, store, checkpoints, service };
}

const evidence = (resetAtMs: number) => async (): Promise<ResetEvidence> => ({ accountId: ACCOUNT, resetAtMs });

describe('save registers the post-reset wake (Codex has no in-session cron)', () => {
  test('saves first, then registers a wake for the observed account and reset', async () => {
    const state = fixture();
    try {
      const resetAtMs = nowMs + 2 * 3_600_000;
      const result = await saveCheckpointWithResetWake({ checkpoints: state.checkpoints, service: state.service, owner, body: 'Continue.', lane: 'feature', worktree: state.root, nowMs, resetEvidence: evidence(resetAtMs) });
      expect(result.withheldReason).toBeUndefined();
      expect(state.checkpoints.peek(result.checkpoint.id)?.owner).toEqual({ accountId: ACCOUNT, threadId: owner.threadId });
      expect(state.checkpoints.peek(result.checkpoint.id)?.resetGeneration).toBe(resetAtMs);
      expect(result.wake?.job.owner).toEqual({ accountId: ACCOUNT, threadId: owner.threadId });
      expect(result.wake?.job.dueAtMs).toBe(resetAtMs + CODEX_DEFAULTS.auto.wake_delay_min * 60_000);
      const timeline = state.store.read({ accountId: ACCOUNT, threadId: owner.threadId, agentId: `job-${result.wake?.job.id}` }, 'timeline') as Record<string, unknown>;
      expect(timeline).toMatchObject({ checkpointId: result.checkpoint.id, resetAtMs, projectRoot: state.root });
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('a reset hours away still registers: the wake is not limited to the bridge window', async () => {
    const state = fixture();
    try {
      const result = await saveCheckpointWithResetWake({ checkpoints: state.checkpoints, service: state.service, owner, body: 'x', lane: 'feature', worktree: state.root, nowMs, resetEvidence: evidence(nowMs + 4.5 * 3_600_000) });
      expect(result.wake).not.toBeNull();
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('a replacement save in the same block retargets the one scheduled wake', async () => {
    const state = fixture();
    try {
      const resetAtMs = nowMs + 3_600_000;
      const save = (body: string) => saveCheckpointWithResetWake({ checkpoints: state.checkpoints, service: state.service, owner, body, lane: 'feature', worktree: state.root, nowMs, resetEvidence: evidence(resetAtMs) });
      const first = await save('First checkpoint.');
      const second = await save('Replacement checkpoint.');
      expect(second.wake?.job.id).toBe(first.wake?.job.id);
      expect(state.service.jobs()).toHaveLength(1);
      const timeline = state.store.read({ accountId: ACCOUNT, threadId: owner.threadId, agentId: `job-${second.wake?.job.id}` }, 'timeline');
      expect(timeline).toMatchObject({ checkpointId: second.checkpoint.id });
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('a wake already in native submission is not retargeted, but the save still lands', async () => {
    const state = fixture();
    try {
      const resetAtMs = nowMs + 3_600_000;
      const save = (body: string) => saveCheckpointWithResetWake({ checkpoints: state.checkpoints, service: state.service, owner, body, lane: 'feature', worktree: state.root, nowMs, resetEvidence: evidence(resetAtMs) });
      const first = await save('Submitted checkpoint.');
      if (first.wake === null) throw new Error('fixture did not register a wake');
      const identity = { accountId: ACCOUNT, threadId: owner.threadId, agentId: `job-${first.wake.job.id}` };
      state.store.write(identity, 'job', advance(first.wake.job, { type: 'submitting' }));
      const second = await save('Manual replacement.');
      expect(second.wake).toBeNull();
      expect(second.withheldReason).toContain('already started');
      expect(state.checkpoints.peek(second.checkpoint.id)?.body).toBe('Manual replacement.');
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  test('withheld evidence or a missing thread id still saves, and says why', async () => {
    const state = fixture();
    try {
      const withheld = await saveCheckpointWithResetWake({ checkpoints: state.checkpoints, service: state.service, owner, body: 'a', lane: 'one', worktree: state.root, nowMs, resetEvidence: async () => ({ withheld: 'no five-hour reset time has been observed for this thread' }) });
      expect(withheld.wake).toBeNull();
      expect(withheld.withheldReason).toContain('no five-hour reset');
      const anonymous = await saveCheckpointWithResetWake({ checkpoints: state.checkpoints, service: state.service, owner: { accountId: null, threadId: 'unknown' }, body: 'b', lane: 'two', worktree: state.root, nowMs, resetEvidence: evidence(nowMs + 60_000) });
      expect(anonymous.wake).toBeNull();
      expect(anonymous.withheldReason).toContain('CODEX_THREAD_ID');
      expect(state.checkpoints.list()).toHaveLength(2);
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });
});

describe('reset discovery without a control socket', () => {
  let home: string;
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-reset-evidence-'));
    previous = { CODEX_HOME: process.env['CODEX_HOME'], CODEX_PACEKEEPER_NATIVE_SOCKET: process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'] };
    process.env['CODEX_HOME'] = home;
    process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'] = join(home, 'absent.sock');
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test('uses the account record when it carries a future five-hour reset', async () => {
    const store = new CodexStore(join(home, 'cache'));
    const resetAtMs = nowMs + 3_600_000;
    store.write(ACCOUNT_IDENTITY, 'account', { accountId: ACCOUNT, quotaObservedAtMs: nowMs - 1_000, rateLimits: { accountId: ACCOUNT, rateLimits: { primary: { usedPercent: 86, windowDurationMins: 300, resetsAt: resetAtMs / 1000 } } } });
    expect(await discoverResetEvidence(owner.threadId, null, nowMs, store)).toEqual({ accountId: ACCOUNT, resetAtMs });
  });

  test("falls back to the thread's rollout, including its creating account", async () => {
    const store = new CodexStore(join(home, 'cache'));
    const dir = join(home, 'sessions', '2027', '03', '04');
    mkdirSync(dir, { recursive: true });
    const resetAtMs = nowMs + 3_600_000;
    writeFileSync(join(dir, `rollout-2027-03-04T00-00-00-${owner.threadId}.jsonl`), [
      JSON.stringify({ timestamp: new Date(nowMs - 5_000).toISOString(), type: 'session_meta', payload: { id: owner.threadId, creator_account_id: 'acct-rollout' } }),
      JSON.stringify({ timestamp: new Date(nowMs - 1_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 86, window_minutes: 300, resets_at: resetAtMs / 1000 } } } })
    ].join('\n') + '\n');
    expect(await discoverResetEvidence(owner.threadId, null, nowMs, store)).toEqual({ accountId: 'acct-rollout', resetAtMs });
  });

  test('a passed reset or an unknown account is withheld, not guessed', async () => {
    const store = new CodexStore(join(home, 'cache'));
    expect(await discoverResetEvidence(owner.threadId, null, nowMs, store)).toHaveProperty('withheld');
    store.write(ACCOUNT_IDENTITY, 'account', { accountId: ACCOUNT, quotaObservedAtMs: nowMs - 1_000, rateLimits: { accountId: ACCOUNT, rateLimits: { primary: { usedPercent: 86, windowDurationMins: 300, resetsAt: (nowMs - 1_000) / 1000 } } } });
    const passed = await discoverResetEvidence(owner.threadId, null, nowMs, store);
    expect('withheld' in passed && passed.withheld).toContain('already passed');
  });
});
