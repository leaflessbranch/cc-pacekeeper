import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, parse, resolve, sep } from 'path';
import { CODEX_DEFAULTS } from '../config';
import { CodexCheckpoints, firstGoalLine, GoalChangedError, isUnsafeCheckpointRoot, sanitizeLane } from '../checkpoint';

/**
 * Fixture roots necessarily live in a temporary directory, which production
 * refuses on purpose. Rather than weakening that rule, these tests keep the
 * real predicate under test (see the `root safety` block below) and give the
 * store an equivalent predicate for fixtures: still refusing the filesystem
 * root and a home directory, but permitting the disposable fixture tree.
 */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'codex-pacekeeper-projects-'));

function fixtureRootIsUnsafe(dir: string): boolean {
  const resolved = resolve(dir);
  if (resolved === parse(resolved).root || resolved === homedir()) return true;
  return !resolved.startsWith(FIXTURE_ROOT + sep);
}

function projectRoot(): string {
  return mkdtempSync(join(FIXTURE_ROOT, 'project-'));
}

function checkpoints(root = projectRoot()): { store: CodexCheckpoints; root: string } {
  return {
    store: new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: fixtureRootIsUnsafe }),
    root
  };
}

const owner = { accountId: 'acct-1', threadId: 'thread-1' };

describe('root safety', () => {
  // Production deliberately refuses transient and over-broad roots. Codex must
  // apply the same refusal rather than relaxing it for convenience.
  test('refuses transient and over-broad roots', () => {
    expect(isUnsafeCheckpointRoot(tmpdir())).toBe(true);
    expect(isUnsafeCheckpointRoot(join(tmpdir(), 'anything'))).toBe(true);
    expect(isUnsafeCheckpointRoot('/')).toBe(true);
  });

  test('accepts an ordinary project directory', () => {
    // A path that is neither transient nor over-broad. Checked as a pure
    // predicate so it does not depend on this machine's directory layout.
    expect(isUnsafeCheckpointRoot('/srv/workspace/a-project')).toBe(false);
  });

  test('constructing against an unsafe root throws rather than writing there', () => {
    expect(() => new CodexCheckpoints(join(tmpdir(), 'nope'), CODEX_DEFAULTS)).toThrow();
  });
});

describe('lane names', () => {
  test('a hostile lane cannot escape the checkpoint directory', () => {
    for (const hostile of ['../../etc', 'a/b', '..', '', '.']) {
      const lane = sanitizeLane(hostile);
      expect(lane).not.toContain('/');
      expect(lane).not.toContain('..');
      expect(lane.length).toBeGreaterThan(0);
    }
  });

  test('an ordinary branch name survives recognizably', () => {
    expect(sanitizeLane('feat/issue-19')).toBe('feat-issue-19');
  });
});

describe('save and list', () => {
  test('a saved checkpoint exists on disk before save reports success', () => {
    const { store } = checkpoints();
    const saved = store.save({ lane: 'main', owner, body: 'Goal: something' });
    expect(existsSync(saved.file)).toBe(true);
    // The persisted content is verified, not assumed.
    expect(readFileSync(saved.file, 'utf8')).toContain('Goal: something');
    expect(saved.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('each checkpoint gets a unique id', () => {
    const { store } = checkpoints();
    const a = store.save({ lane: 'main', owner, body: 'a' });
    const b = store.save({ lane: 'other', owner, body: 'b' });
    expect(a.id).not.toBe(b.id);
  });

  test('saving supersedes only the same lane', () => {
    const { store } = checkpoints();
    store.save({ lane: 'main', owner, body: 'first' });
    store.save({ lane: 'other', owner, body: 'other-lane' });
    store.save({ lane: 'main', owner, body: 'second' });
    const lanes = store.list().map((entry) => entry.lane).sort();
    expect(lanes).toEqual(['main', 'other']);
    expect(store.list().find((entry) => entry.lane === 'main')?.body).toContain('second');
  });

  test('metadata records harness, account, thread and lane ownership', () => {
    const { store } = checkpoints();
    const saved = store.save({ lane: 'main', owner, body: 'x', branch: 'feat/example', worktree: '/srv/work/example' });
    const raw = readFileSync(saved.file, 'utf8');
    expect(raw).toContain('harness: codex');
    expect(raw).toContain('branch: "feat/example"');
    expect(raw).toContain('worktree: "/srv/work/example"');
    expect(store.list()[0]?.owner.threadId).toBe('thread-1');
    expect(store.list()[0]?.branch).toBe('feat/example');
  });

  test('reset generation provenance round-trips with the exact checkpoint id', () => {
    const { store } = checkpoints();
    const saved = store.save({ lane: 'main', owner, body: 'wake me', resetGeneration: 42 });
    expect(store.peek(saved.id)?.resetGeneration).toBe(42);
  });
});

describe('isolation from Claude lanes', () => {
  test('Codex writes only inside its own subtree', () => {
    const { store, root } = checkpoints();
    store.save({ lane: 'main', owner, body: 'x' });
    const checkpointDir = join(root, CODEX_DEFAULTS.checkpoint_dir_name);
    const topLevel = readdirSync(checkpointDir);
    // Nothing loose in the shared root: everything is under codex/.
    expect(topLevel).toEqual([CODEX_DEFAULTS.checkpoint_subdir]);
  });

  test('a same-named Claude lane is neither read nor superseded', () => {
    const { store, root } = checkpoints();
    const claudeDir = join(root, CODEX_DEFAULTS.checkpoint_dir_name);
    mkdirSync(claudeDir, { recursive: true });
    const claudeLane = join(claudeDir, 'main.md');
    writeFileSync(claudeLane, 'claude owns this');

    store.save({ lane: 'main', owner, body: 'codex' });
    store.save({ lane: 'main', owner, body: 'codex again' });

    expect(readFileSync(claudeLane, 'utf8')).toBe('claude owns this');
    expect(store.list()).toHaveLength(1);
  });
});

describe('resume (Claude semantics)', () => {
  test('resume prints and archives in one step; replay reports already-consumed', () => {
    const { store } = checkpoints();
    const saved = store.save({ lane: 'main', owner, body: 'resume me' });
    const first = store.resume(saved.id);
    expect(first.status).toBe('resumed');
    if (first.status !== 'resumed') throw new Error('unreachable');
    expect(first.body).toContain('resume me');
    expect(existsSync(saved.file)).toBe(false);
    expect(store.list()).toHaveLength(0);
    expect(store.resume(saved.id).status).toBe('already-consumed');
  });

  test('the claim/acknowledge pair underneath stays crash-recoverable', () => {
    const { store } = checkpoints();
    const saved = store.save({ lane: 'main', owner, body: 'two phase' });
    const claim = store.claim(saved.id);
    expect(claim.status).toBe('claimed');
    // A consumer that died before acknowledging leaves the file active; a
    // retried resume finds the same claim and completes it.
    expect(existsSync(saved.file)).toBe(true);
    expect(store.resume(saved.id).status).toBe('resumed');
    expect(store.listArchived()[0]?.disposition).toBe('consumed');
  });

  test('an unknown id is reported, not silently treated as success', () => {
    expect(checkpoints().store.resume('no-such-id').status).toBe('not-found');
  });

  test('an ambiguous bare resume consumes nothing', () => {
    const { store } = checkpoints();
    store.save({ lane: 'main', owner, body: 'a' });
    store.save({ lane: 'other', owner, body: 'b' });
    expect(store.resumeLane(undefined).status).toBe('ambiguous');
    expect(store.list()).toHaveLength(2);
  });

  test('a single lane resumes unambiguously', () => {
    const { store } = checkpoints();
    store.save({ lane: 'main', owner, body: 'only' });
    expect(store.resumeLane(undefined).status).toBe('resumed');
    expect(store.list()).toHaveLength(0);
  });

  test('select resolves an id, a lane, or a 1-based list index', () => {
    const { store } = checkpoints();
    const a = store.save({ lane: 'alpha', owner, body: 'a' });
    const b = store.save({ lane: 'beta', owner, body: 'b' });
    expect(store.select(a.id)?.id).toBe(a.id);
    expect(store.select('beta')?.id).toBe(b.id);
    expect(store.select('1')?.id).toBe(store.listNewestFirst()[0]?.id);
    expect(store.select('9')).toBeNull();
  });

  test('archives record distinct dispositions', () => {
    const { store } = checkpoints();
    const first = store.save({ lane: 'main', owner, body: 'old' });
    const second = store.save({ lane: 'main', owner, body: 'new' });
    expect(store.peek(first.id)?.disposition).toBe('superseded');
    expect(store.peek(second.id)?.disposition).toBeUndefined();
    expect(store.discard(second.id).status).toBe('resumed');
    expect(store.peek(second.id)?.disposition).toBe('discarded');
  });
});

describe('lanes are shared across threads (review #1)', () => {
  test('another thread can continue a lane, and an unknown account never locks one', () => {
    const { store } = checkpoints();
    store.save({ lane: 'main', owner: { accountId: null, threadId: 'thread-A' }, body: 'A, account unknown' });
    store.save({ lane: 'main', owner: { accountId: 'acct-1', threadId: 'thread-A' }, body: 'A, account known' });
    const b = store.save({ lane: 'main', owner: { accountId: 'acct-1', threadId: 'thread-B' }, body: 'B continues' });
    expect(store.list().map((entry) => entry.id)).toEqual([b.id]);
    const resumed = store.resume(b.id, { accountId: null, threadId: 'thread-C' });
    expect(resumed.status).toBe('resumed');
  });
});

describe('goal lock', () => {
  test('a changed Goal is refused unless --goal-changed; a goal-less body is never refused', () => {
    const { store } = checkpoints();
    store.save({ lane: 'main', owner, body: '## Goal\nship the parser\n\n## Next\nA' });
    expect(() => store.save({ lane: 'main', owner, body: '## Goal\nrewrite everything\n\n## Next\nB' })).toThrow(GoalChangedError);
    expect(() => store.save({ lane: 'main', owner, body: 'no goal section' })).not.toThrow();
    // A goal-less save dissolves the lock for the next save.
    expect(() => store.save({ lane: 'main', owner, body: '## Goal\nrewrite everything' })).not.toThrow();
    expect(() => store.save({ lane: 'main', owner, body: '## Goal\nsomething else', goalChanged: true })).not.toThrow();
  });

  test('a lane resumed recently still anchors its goal', () => {
    const { store } = checkpoints();
    const saved = store.save({ lane: 'main', owner, body: '## Goal\nkeep me\n' });
    store.resume(saved.id);
    expect(() => store.save({ lane: 'main', owner, body: '## Goal\ndrifted' })).toThrow(GoalChangedError);
    expect(() => store.save({ lane: 'main', owner, body: '## Goal\nkeep me\n\n## Status\nmore' })).not.toThrow();
  });

  test('firstGoalLine summarizes the goal section', () => {
    expect(firstGoalLine('## Goal\n\n  "do the thing"\nscope\n## Next\nx')).toBe('"do the thing"');
    expect(firstGoalLine('nothing')).toBeNull();
  });
});
