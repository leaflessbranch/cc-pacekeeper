import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS } from '../config';
import { acknowledgeHandoff, archiveHandoff, checkpointCliPath, listHandoffs, writeHandoff } from '../agent-budget';

describe('Codex handoff registry', () => {
  test('accepts a project-root alias for scoped write, list, acknowledgement and archive', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codex-handoff-root-alias-'));
    const root = join(fixture, 'project');
    const alias = join(fixture, 'project-alias');
    const ownership = { accountId: 'acct-one', childThreadId: 'child-thread', parentThreadId: 'parent-thread' };
    try {
      mkdirSync(root);
      symlinkSync(root, alias);
      writeHandoff({ cwd: alias, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'agent-1', trigger: 'budget_pause', body: 'Aliased project result.', ownership });
      expect(listHandoffs(alias, CODEX_DEFAULTS.checkpoint_dir_name, 'codex', ownership)[0]?.body).toBe('Aliased project result.');
      expect(acknowledgeHandoff(alias, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', ownership)?.status).toBe('acknowledged');
      expect(archiveHandoff(alias, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', 'codex', ownership)).toContain('archive');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  test('rejects an owned-subtree symlink even through a legitimate project-root alias', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codex-handoff-alias-escape-'));
    const root = join(fixture, 'project');
    const alias = join(fixture, 'project-alias');
    const outside = join(fixture, 'outside');
    try {
      mkdirSync(join(root, CODEX_DEFAULTS.checkpoint_dir_name), { recursive: true });
      mkdirSync(outside);
      symlinkSync(root, alias);
      symlinkSync(outside, join(root, CODEX_DEFAULTS.checkpoint_dir_name, 'codex'));
      expect(() => writeHandoff({ cwd: alias, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'agent-1', trigger: 'budget_pause', body: 'Refuse escape.' })).toThrow(/symlink/);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  test('writes, lists and archives one owned handoff atomically', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-handoff-'));
    const file = writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'agent-1', agentType: 'worker', trigger: 'budget_pause', body: '## Goal\nresume work' });
    expect(file).toContain('codex');
    expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name)[0]?.body).toContain('resume work');
    expect(archiveHandoff(root, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1')).toContain('archive');
    expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name)).toHaveLength(0);
    expect(checkpointCliPath()).toEndWith('/bin/pacekeeper-checkpoint');
  });

  test('rejects symlinked handoff destination and unsafe agent ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-handoff-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'codex-handoff-outside-'));
    mkdirSync(join(root, CODEX_DEFAULTS.checkpoint_dir_name), { recursive: true });
    symlinkSync(outside, join(root, CODEX_DEFAULTS.checkpoint_dir_name, 'codex'));
    expect(() => writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'agent-2', trigger: 'budget_pause', body: 'body' })).toThrow(/symlink|handoff/i);
    expect(() => writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: '../escape', trigger: 'budget_pause', body: 'body' })).toThrow(/identifier|agent/i);
  });

  test('scopes handoffs to the native account and parent, with explicit idempotent receipt before archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-handoff-owned-'));
    const owner = { accountId: 'acct-one', childThreadId: 'child-thread', parentThreadId: 'parent-thread' };
    try {
      const target = writeHandoff({
        cwd: root,
        checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name,
        agentId: 'agent-1',
        trigger: 'budget_pause',
        body: 'Resume after the verified result.',
        ownership: owner
      });
      expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name, 'codex', { accountId: owner.accountId, parentThreadId: owner.parentThreadId })).toHaveLength(1);
      expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name, 'codex', { accountId: 'acct-two', parentThreadId: owner.parentThreadId })).toHaveLength(0);
      expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name, 'codex', { accountId: owner.accountId, parentThreadId: 'other-parent' })).toHaveLength(0);
      expect(archiveHandoff(root, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', 'codex', owner)).toBeNull();
      expect(acknowledgeHandoff(root, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', { ...owner, parentThreadId: 'other-parent' })).toBeNull();
      expect(acknowledgeHandoff(root, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', owner)?.status).toBe('acknowledged');
      expect(acknowledgeHandoff(root, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', owner)?.status).toBe('already-acknowledged');
      expect(archiveHandoff(root, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', 'codex', { ...owner, accountId: 'acct-two' })).toBeNull();
      expect(archiveHandoff(root, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', 'codex', owner)).toContain('archive');
      expect(target).toContain('agent-1.md');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('never adopts a legacy unowned handoff or overwrites an owned one with an unscoped write', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-handoff-legacy-'));
    const ownership = { accountId: 'acct-one', childThreadId: 'child-thread', parentThreadId: 'parent-thread' };
    try {
      writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'legacy-agent', trigger: 'budget_pause', body: 'legacy body' });
      expect(() => writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'legacy-agent', trigger: 'budget_pause', body: 'adopt', ownership })).toThrow(/matching native account and parent ownership/);
      writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'owned-agent', trigger: 'budget_pause', body: 'owned body', ownership });
      expect(() => writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'owned-agent', trigger: 'budget_pause', body: 'unowned overwrite' })).toThrow(/downgraded/);
      expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name, 'codex', { accountId: ownership.accountId, parentThreadId: ownership.parentThreadId }).map((item) => item.frontmatter.agent_id)).toEqual(['owned-agent']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
