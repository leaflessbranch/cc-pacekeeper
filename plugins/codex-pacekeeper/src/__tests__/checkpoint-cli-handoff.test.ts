import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS } from '../config';
import { CodexStore } from '../storage';

describe('handoff CLI owner verification', () => {
  test('requires the persisted native child-parent mapping for write, ack and archive', () => {
    const root = mkdtempSync(join(import.meta.dir, '.handoff-cli-project-'));
    const cache = mkdtempSync(join(tmpdir(), 'codex-handoff-cli-cache-'));
    const home = mkdtempSync(join(tmpdir(), 'codex-handoff-cli-home-'));
    const config = mkdtempSync(join(tmpdir(), 'codex-handoff-cli-config-'));
    const cli = join(import.meta.dir, '..', 'checkpoint-cli.ts');
    const owner = { accountId: 'acct-one', childThreadId: 'child-thread', parentThreadId: 'parent-thread' };
    const env = { ...process.env, XDG_CACHE_HOME: cache, CODEX_HOME: home, XDG_CONFIG_HOME: config };
    const run = (...args: string[]) => execFileSync('bun', ['run', cli, 'handoffs', ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const scope = ['--account-id', owner.accountId, '--thread-id', owner.childThreadId, '--parent-thread-id', owner.parentThreadId, '--cwd', root];
    try {
      execFileSync('git', ['init', '-q', root]);
      expect(() => run('write', 'agent-one', ...scope, '--body', 'result')).toThrow();

      const store = new CodexStore(cache);
      store.write({ accountId: owner.accountId, threadId: owner.childThreadId, agentId: 'agent-one' }, 'owner', {
        source: 'native-thread-parent',
        ...owner,
        agentId: 'agent-one',
        observedAtMs: 1_700_000_000_000
      });
      expect(run('write', 'agent-one', ...scope, '--body', 'result')).toContain('Wrote handoff:');
      expect(run('list', '--account-id', 'acct-two', '--parent-thread-id', owner.parentThreadId, '--thread-id', owner.childThreadId, '--cwd', root)).toContain('No pending handoffs.');
      expect(() => run('ack', 'agent-one', ...scope.map((value, index) => index === 1 ? 'acct-two' : value))).toThrow();
      expect(() => run('archive', 'agent-one', ...scope)).toThrow(/acknowledged/);
      expect(run('ack', 'agent-one', ...scope)).toContain('Acknowledged handoff:');
      expect(run('archive', 'agent-one', ...scope)).toContain('Archived handoff:');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  });
});
