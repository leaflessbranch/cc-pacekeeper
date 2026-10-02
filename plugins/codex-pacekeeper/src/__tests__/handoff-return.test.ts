import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS } from '../config';
import { acknowledgeHandoff, writeHandoff } from '../agent-budget';
import { parseCompletedWaitAgentIds, recordParentHandoffReturn } from '../refresh';
import { CodexStore } from '../storage';

const ACCOUNT = 'acct-one';
const PARENT = 'parent-thread';
const CHILD = 'child-thread';
const AGENT = 'agent-one';
const NOW = 1_700_000_000_000;

function setup(): { root: string; cache: string; store: CodexStore } {
  const root = mkdtempSync(join(tmpdir(), 'codex-handoff-return-project-'));
  const cache = mkdtempSync(join(tmpdir(), 'codex-handoff-return-cache-'));
  return { root, cache, store: new CodexStore(cache) };
}

function addOwnedChild(store: CodexStore, childThreadId = CHILD, agentId = AGENT, parentThreadId = PARENT): void {
  store.write({ accountId: ACCOUNT, threadId: childThreadId, agentId }, 'owner', {
    source: 'native-thread-parent',
    accountId: ACCOUNT,
    childThreadId,
    parentThreadId,
    agentId,
    observedAtMs: NOW
  });
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolUse',
    session_id: PARENT,
    account_id: ACCOUNT,
    tool_name: 'multi_agent_v1wait_agent',
    tool_response: { status: { [AGENT]: { completed: null } }, timed_out: false },
    turn_id: 'parent-turn',
    now_ms: NOW,
    ...overrides
  };
}

describe('parent wait_agent handoff return', () => {
  test('recognizes only completed ids from the native namespaced wait_agent result', () => {
    const response = {
      status: {
        [AGENT]: { completed: null },
        'agent-running': { running: null },
        'agent-failed': { errored: 'failed' }
      },
      timed_out: false
    };
    expect(parseCompletedWaitAgentIds('multi_agent_v1wait_agent', response)).toEqual([AGENT]);
    expect(parseCompletedWaitAgentIds('wait_agent', response)).toEqual([]);
    expect(parseCompletedWaitAgentIds('multi_agent_v1wait_agent', { ...response, timed_out: true })).toEqual([]);
    expect(parseCompletedWaitAgentIds('multi_agent_v1wait_agent', { status: 'bad', timed_out: false })).toEqual([]);
  });

  test('returns one matching owned handoff, survives restart, and waits for explicit parent acknowledgement', () => {
    const { root, cache, store } = setup();
    try {
      addOwnedChild(store);
      writeHandoff({
        cwd: root,
        checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name,
        checkpointSubdir: CODEX_DEFAULTS.checkpoint_subdir,
        agentId: AGENT,
        trigger: 'budget_pause',
        body: 'Verified result from the child.',
        ownership: { accountId: ACCOUNT, childThreadId: CHILD, parentThreadId: PARENT }
      });
      const context = recordParentHandoffReturn(input({ cwd: root }), store, ACCOUNT, root, CODEX_DEFAULTS);
      expect(context).toContain('Verified result from the child.');
      expect(context).toContain(`handoffs ack ${AGENT} --account-id ${ACCOUNT} --thread-id ${CHILD} --parent-thread-id ${PARENT}`);
      expect(store.read({ accountId: ACCOUNT, threadId: PARENT, agentId: `wait-return-${AGENT}` }, 'owner')).toMatchObject({
        source: 'native-wait-agent-completion',
        accountId: ACCOUNT,
        parentThreadId: PARENT,
        childThreadId: CHILD,
        agentId: AGENT,
        turnId: 'parent-turn'
      });

      const restarted = new CodexStore(cache);
      expect(recordParentHandoffReturn(input({ cwd: root }), restarted, ACCOUNT, root, CODEX_DEFAULTS)).toBe(context);
      acknowledgeHandoff(root, CODEX_DEFAULTS.checkpoint_dir_name, AGENT, { accountId: ACCOUNT, childThreadId: CHILD, parentThreadId: PARENT }, CODEX_DEFAULTS.checkpoint_subdir);
      expect(recordParentHandoffReturn(input({ cwd: root }), restarted, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  });

  test('refuses foreign account, parent, legacy files, and ambiguous child ownership', () => {
    const { root, cache, store } = setup();
    try {
      addOwnedChild(store);
      writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: AGENT, trigger: 'budget_pause', body: 'legacy' });
      expect(recordParentHandoffReturn(input({ cwd: root }), store, 'acct-two', root, CODEX_DEFAULTS)).toBeNull();
      expect(recordParentHandoffReturn(input({ cwd: root, session_id: 'other-parent' }), store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
      expect(recordParentHandoffReturn(input({ cwd: root }), store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();

      const ownedAgent = 'agent-two';
      addOwnedChild(store, 'owned-child', ownedAgent);
      writeHandoff({
        cwd: root,
        checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name,
        agentId: ownedAgent,
        trigger: 'budget_pause',
        body: 'owned but ambiguous',
        ownership: { accountId: ACCOUNT, childThreadId: 'owned-child', parentThreadId: PARENT }
      });
      addOwnedChild(store, 'second-child', ownedAgent);
      const ownedInput = input({ cwd: root, tool_response: { status: { [ownedAgent]: { completed: null } }, timed_out: false } });
      expect(recordParentHandoffReturn(ownedInput, store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
      expect(recordParentHandoffReturn(input({ cwd: root }), store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  });

  test('rejects non-PostToolUse and stale or contradictory response identities', () => {
    const { root, cache, store } = setup();
    try {
      addOwnedChild(store);
      writeHandoff({
        cwd: root,
        checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name,
        agentId: AGENT,
        trigger: 'budget_pause',
        body: 'result',
        ownership: { accountId: ACCOUNT, childThreadId: CHILD, parentThreadId: PARENT }
      });
      expect(recordParentHandoffReturn(input({ cwd: root, hook_event_name: 'PreToolUse' }), store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
      expect(recordParentHandoffReturn(input({ cwd: root, account_id: 'acct-two' }), store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
      expect(recordParentHandoffReturn(input({ cwd: root, thread_id: PARENT, session_id: 'other-parent' }), store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
      expect(recordParentHandoffReturn(input({ cwd: root, now_ms: NOW - 1 }), store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
      expect(recordParentHandoffReturn(input({ cwd: root, tool_response: { status: { [AGENT]: { completed: null } }, timed_out: true } }), store, ACCOUNT, root, CODEX_DEFAULTS)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
