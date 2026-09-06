import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS } from '../config';
import { archiveHandoff, checkpointCliPath, listHandoffs, writeHandoff } from '../agent-budget';

describe('Codex handoff registry', () => {
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
});

