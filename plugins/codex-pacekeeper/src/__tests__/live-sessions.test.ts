import { describe, expect, test } from 'bun:test';
import { ACCOUNT_READ_METHOD, NativeClient, normalizeNativeCapabilities, RATE_LIMITS_READ_METHOD, THREAD_READ_METHOD } from '../native';
import { nativeControlOwner, readVerifiedThreadParent } from '../live-sessions';
import { persistSubagentOwnership } from '../refresh';
import { CodexStore } from '../storage';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function clientFor(input: { accountId: string; loaded?: string[]; parent?: string | null }) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const methods = ['thread/loaded/list', RATE_LIMITS_READ_METHOD, THREAD_READ_METHOD, ACCOUNT_READ_METHOD];
  const capabilities = normalizeNativeCapabilities({ version: '0.160.0', methods });
  const client = new NativeClient({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return { data: input.loaded ?? ['child-thread', 'parent-thread'], nextCursor: null };
      if (method === RATE_LIMITS_READ_METHOD) return { accountId: input.accountId, rateLimits: {} };
      if (method === THREAD_READ_METHOD) return { thread: { id: 'child-thread', parentThreadId: input.parent === undefined ? 'parent-thread' : input.parent } };
      return {};
    }
  }, capabilities, {
    ownerId: 'native-control', accountId: input.accountId,
    threadIds: ['child-thread'], methods, protocolVersion: '0.160.0'
  });
  return { client, calls };
}

describe('native control-socket ownership evidence', () => {
  test('represents the socket by endpoint without fabricating a process id', () => {
    const owner = nativeControlOwner('child-thread', 'acct-1', '/tmp/codex-control.sock');
    expect(owner).not.toHaveProperty('pid');
    expect(owner.threadIds).toEqual(['child-thread']);
    expect(owner.socketPath).toBe('unix:///tmp/codex-control.sock');
  });

  test('binds only a loaded child and parent under the fresh matching account', async () => {
    const { client, calls } = clientFor({ accountId: 'acct-1' });
    const binding = await readVerifiedThreadParent(client, 'child-thread', 'acct-1');
    expect(binding).toMatchObject({ accountId: 'acct-1', childThreadId: 'child-thread', parentThreadId: 'parent-thread' });
    expect(client.owner.threadIds).toEqual(['child-thread', 'parent-thread']);
    expect(calls.some((call) => call.method === THREAD_READ_METHOD && JSON.stringify(call.params) === JSON.stringify({ threadId: 'child-thread', includeTurns: false }))).toBe(true);
  });

  test('rejects foreign-account, unloaded-parent and missing-parent observations', async () => {
    const foreign = clientFor({ accountId: 'acct-foreign' });
    expect(await readVerifiedThreadParent(foreign.client, 'child-thread', 'acct-1')).toBeNull();

    const unloaded = clientFor({ accountId: 'acct-1', loaded: ['child-thread'] });
    expect(await readVerifiedThreadParent(unloaded.client, 'child-thread', 'acct-1')).toBeNull();

    const noParent = clientFor({ accountId: 'acct-1', parent: null });
    expect(await readVerifiedThreadParent(noParent.client, 'child-thread', 'acct-1')).toBeNull();
  });

  test('persists one verified agent mapping idempotently and refuses a conflicting parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-subagent-owner-'));
    try {
      const store = new CodexStore(root);
      const binding = { accountId: 'acct-1', childThreadId: 'child-thread', parentThreadId: 'parent-thread', observedAtMs: 100 };
      expect(persistSubagentOwnership(store, binding, 'agent-1')).toBe(true);
      expect(persistSubagentOwnership(store, { ...binding, observedAtMs: 101 }, 'agent-1')).toBe(true);
      expect(persistSubagentOwnership(store, { ...binding, parentThreadId: 'other-parent', observedAtMs: 102 }, 'agent-1')).toBe(false);
      expect(store.read({ accountId: 'acct-1', threadId: 'child-thread', agentId: 'agent-1' }, 'owner')).toMatchObject({
        accountId: 'acct-1', childThreadId: 'child-thread', parentThreadId: 'parent-thread'
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
