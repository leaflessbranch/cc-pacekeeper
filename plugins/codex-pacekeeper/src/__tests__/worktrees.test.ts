import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexStore } from '../storage';
import { cleanupDecision, listWorktrees } from '../worktrees';

describe('worktree liveness from the hook timelines', () => {
  test('a recently active Codex session occupies its worktree; a stale or ended one does not', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-worktree-live-')));
    try {
      const repo = join(root, 'repo');
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
      const feature = join(root, 'feature');
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feature', feature]);
      const store = new CodexStore(join(root, 'cache'));
      const sessions = join(root, 'claude-sessions');
      const now = Date.now();
      store.write({ accountId: null, threadId: 'live' }, 'timeline', { threadId: 'live', cwd: feature, lastEventAtMs: now - 60_000 });
      store.write({ accountId: null, threadId: 'ended' }, 'timeline', { threadId: 'ended', cwd: repo, lastEventAtMs: now - 60_000, sessionEndedAtMs: now - 30_000 });
      store.write({ accountId: null, threadId: 'stale' }, 'timeline', { threadId: 'stale', cwd: repo, lastEventAtMs: now - 3 * 3_600_000 });
      execFileSync('mkdir', ['-p', sessions]);
      const rows = listWorktrees({ cwd: repo, store, claudeSessionsDir: sessions }) ?? [];
      const featureRow = rows.find((row) => row.path === feature);
      const mainRow = rows.find((row) => row.path === repo);
      expect(featureRow?.liveOwners).toBe(1);
      expect(mainRow?.liveOwners).toBe(0);
      expect(featureRow && cleanupDecision(featureRow, repo).removable).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
