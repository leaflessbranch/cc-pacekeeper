import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS } from '../config';
import { archiveHandoff, checkpointCliPath, listHandoffs, writeHandoff } from '../agent-budget';

describe('Codex handoff registry', () => {
  test('accepts a project-root alias for write, list and archive', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codex-handoff-root-alias-'));
    const root = join(fixture, 'project');
    const alias = join(fixture, 'project-alias');
    try {
      mkdirSync(root);
      symlinkSync(root, alias);
      writeHandoff({ cwd: alias, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'agent-1', trigger: 'budget_pause', body: 'Aliased project result.', provenance: { childThreadId: 'agent-1', parentThreadId: 'parent-thread' } });
      expect(listHandoffs(alias, CODEX_DEFAULTS.checkpoint_dir_name, 'codex', 'parent-thread')[0]?.body).toBe('Aliased project result.');
      expect(archiveHandoff(alias, CODEX_DEFAULTS.checkpoint_dir_name, 'agent-1', 'codex')).toContain('archive');
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

  test("lists a parent its own children's handoffs plus legacy ones that name no parent", () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-handoff-parent-'));
    try {
      writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'mine', trigger: 'budget_pause', body: 'a', provenance: { parentThreadId: 'parent-1' } });
      writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'theirs', trigger: 'budget_pause', body: 'b', provenance: { parentThreadId: 'parent-2' } });
      writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'legacy', trigger: 'budget_pause', body: 'c' });
      expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name, 'codex', 'parent-1').map((h) => h.frontmatter.agent_id).sort()).toEqual(['legacy', 'mine']);
      expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name).map((h) => h.frontmatter.agent_id).sort()).toEqual(['legacy', 'mine', 'theirs']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a rewrite replaces the handoff, as a paused child updating its notes', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-handoff-rewrite-'));
    try {
      writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'agent-1', trigger: 'budget_pause', body: 'first' });
      writeHandoff({ cwd: root, checkpointDirName: CODEX_DEFAULTS.checkpoint_dir_name, agentId: 'agent-1', trigger: 'budget_pause', body: 'second' });
      expect(listHandoffs(root, CODEX_DEFAULTS.checkpoint_dir_name).map((h) => h.body)).toEqual(['second']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
