import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { advance, createJob } from '../jobs';
import { NativeClient, normalizeNativeCapabilities, RATE_LIMITS_READ_METHOD, THREAD_READ_METHOD } from '../native';
import { correlateOwnedInFlightPrompt } from '../refresh';
import { runTick } from '../tick';
import { CodexStore } from '../storage';
import { CODEX_DEFAULTS } from '../config';

const NOW = 1_700_000_000_000;
const owner = { accountId: 'acct-turn', threadId: 'thread-turn' };
const activeTurn = {
  thread: {
    id: owner.threadId,
    turns: [{ id: 'turn-native', status: 'inProgress', itemsView: 'full', items: [
      { id: 'user-item', type: 'userMessage', clientId: 'client-message', content: [] }
    ] }]
  }
};

function storeWithQueuedJob(root: string, turnId?: string): CodexStore {
  const store = new CodexStore(root);
  const created = createJob({ kind: 'reset-wake', owner, dueAtMs: NOW, submissionId: 'client-message', resetGeneration: NOW + 60_000 });
  let queued = advance(advance(created, { type: 'submitting' }), { type: 'accepted', queuedSubmissionId: 'queue-1' });
  if (turnId !== undefined) queued = { ...queued, turnId };
  store.write({ ...owner, agentId: `job-${queued.id}` }, 'job', queued);
  return store;
}

function clientFor(input: { accountId: string; turn?: unknown }) {
  const calls: string[] = [];
  const capabilities = normalizeNativeCapabilities({ version: '0.160.0', methods: [RATE_LIMITS_READ_METHOD, THREAD_READ_METHOD] });
  const client = new NativeClient({
    request: async (method) => {
      calls.push(method);
      if (method === RATE_LIMITS_READ_METHOD) return { accountId: input.accountId, rateLimits: {} };
      return input.turn ?? activeTurn;
    }
  }, capabilities, {
    ownerId: 'native-control', accountId: null, threadIds: [owner.threadId], protocolVersion: '0.160.0'
  });
  return { client, calls };
}

describe('pre-completion owned synthetic correlation', () => {
  test('binds the native turn before tick policy and stays idempotent after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-turn-bind-'));
    try {
      const store = storeWithQueuedJob(root);
      const { client } = clientFor({ accountId: owner.accountId });
      expect(await correlateOwnedInFlightPrompt(client, owner.threadId, owner.accountId, 'turn-native', store, NOW)).toBe('bound');

      const job = store.list('job')[0] as Record<string, unknown>;
      expect(job).toMatchObject({ state: 'running', turnId: 'turn-native', submissionId: 'client-message' });
      const afterRestart = new CodexStore(root);
      expect(await correlateOwnedInFlightPrompt(client, owner.threadId, owner.accountId, 'turn-native', afterRestart, NOW + 1)).toBe('already-bound');

      const result = runTick({ hook_event_name: 'UserPromptSubmit', thread_id: owner.threadId, account_id: owner.accountId, turn_id: 'turn-native', prompt: '[pacekeeper-resume] ordinary user text', now_ms: NOW }, { config: CODEX_DEFAULTS, store: afterRestart });
      expect(JSON.parse(result.output)).toEqual({});
      expect(afterRestart.read(owner, 'timeline')).not.toHaveProperty('lastUserActivityAtMs');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('rejects foreign accounts, late native turns and conflicting stored turn ids', async () => {
    const foreignRoot = mkdtempSync(join(tmpdir(), 'codex-turn-foreign-'));
    const lateRoot = mkdtempSync(join(tmpdir(), 'codex-turn-late-'));
    const conflictRoot = mkdtempSync(join(tmpdir(), 'codex-turn-conflict-'));
    try {
      const foreignStore = storeWithQueuedJob(foreignRoot);
      const foreign = clientFor({ accountId: 'acct-other' });
      expect(await correlateOwnedInFlightPrompt(foreign.client, owner.threadId, owner.accountId, 'turn-native', foreignStore, NOW)).toBe('foreign-owner');
      expect((foreignStore.list('job')[0] as Record<string, unknown>)['state']).toBe('queued');

      const lateStore = storeWithQueuedJob(lateRoot);
      const late = clientFor({ accountId: owner.accountId, turn: { thread: { id: owner.threadId, turns: [{ ...activeTurn.thread.turns[0], status: 'completed' }] } } });
      expect(await correlateOwnedInFlightPrompt(late.client, owner.threadId, owner.accountId, 'turn-native', lateStore, NOW)).toBe('unavailable');
      expect((lateStore.list('job')[0] as Record<string, unknown>)['state']).toBe('queued');

      const conflictStore = storeWithQueuedJob(conflictRoot, 'turn-old');
      const conflict = clientFor({ accountId: owner.accountId });
      expect(await correlateOwnedInFlightPrompt(conflict.client, owner.threadId, owner.accountId, 'turn-native', conflictStore, NOW)).toBe('conflict');
      expect((conflictStore.list('job')[0] as Record<string, unknown>)['turnId']).toBe('turn-old');
    } finally {
      rmSync(foreignRoot, { recursive: true, force: true });
      rmSync(lateRoot, { recursive: true, force: true });
      rmSync(conflictRoot, { recursive: true, force: true });
    }
  });

  test('leaves unmatched client ids and multiple owned candidates unbound', async () => {
    const unmatchedRoot = mkdtempSync(join(tmpdir(), 'codex-turn-unmatched-'));
    const ambiguousRoot = mkdtempSync(join(tmpdir(), 'codex-turn-ambiguous-'));
    try {
      const unmatchedStore = storeWithQueuedJob(unmatchedRoot);
      const wrongClientId = clientFor({ accountId: owner.accountId, turn: {
        thread: { ...activeTurn.thread, turns: [{
          ...activeTurn.thread.turns[0],
          items: [{ id: 'user-item', type: 'userMessage', clientId: 'different-client', content: [] }]
        }] }
      } });
      expect(await correlateOwnedInFlightPrompt(wrongClientId.client, owner.threadId, owner.accountId, 'turn-native', unmatchedStore, NOW)).toBe('unmatched');
      expect((unmatchedStore.list('job')[0] as Record<string, unknown>)['state']).toBe('queued');

      const ambiguousStore = storeWithQueuedJob(ambiguousRoot);
      const duplicate = advance(advance(createJob({ kind: 'keepalive', owner, dueAtMs: NOW, submissionId: 'client-message' }), { type: 'submitting' }), { type: 'accepted', queuedSubmissionId: 'queue-duplicate' });
      ambiguousStore.write({ ...owner, agentId: `job-${duplicate.id}` }, 'job', duplicate);
      const exact = clientFor({ accountId: owner.accountId });
      expect(await correlateOwnedInFlightPrompt(exact.client, owner.threadId, owner.accountId, 'turn-native', ambiguousStore, NOW)).toBe('ambiguous');
      expect(ambiguousStore.list('job').every((job) => (job as Record<string, unknown>)['state'] === 'queued')).toBe(true);
    } finally {
      rmSync(unmatchedRoot, { recursive: true, force: true });
      rmSync(ambiguousRoot, { recursive: true, force: true });
    }
  });
});
