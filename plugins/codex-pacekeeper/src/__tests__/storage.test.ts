import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, isAbsolute } from 'path';
import { CodexStore, identityKey } from '../storage';

function store(): { store: CodexStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'codex-pacekeeper-state-'));
  return { store: new CodexStore(root), root };
}

const identity = { accountId: 'acct-1', threadId: 'thread-1' };

describe('identity keys', () => {
  // Refuted hypothesis: a session id does not uniquely identify a thread. The
  // same thread id under two accounts must never collide.
  test('the same thread in different accounts yields different keys', () => {
    expect(identityKey({ accountId: 'acct-1', threadId: 'shared' }))
      .not.toBe(identityKey({ accountId: 'acct-2', threadId: 'shared' }));
  });

  test('an agent is scoped under its thread without colliding with the thread', () => {
    const thread = identityKey(identity);
    const agent = identityKey({ ...identity, agentId: 'agent-1' });
    expect(agent).not.toBe(thread);
    expect(identityKey({ ...identity, agentId: 'agent-2' })).not.toBe(agent);
  });

  test('an unknown account is distinct from a named one', () => {
    expect(identityKey({ accountId: null, threadId: 'thread-1' })).not.toBe(identityKey(identity));
  });

  // Raw ids must never become path segments.
  test('hostile identifiers cannot escape the state directory', () => {
    for (const hostile of ['../../etc/passwd', 'a/b', '..', '.', 'x\u0000y', '~/secret']) {
      const key = identityKey({ accountId: 'acct-1', threadId: hostile });
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(key).not.toContain('..');
      expect(key).not.toContain('/');
    }
  });

  test('the key is stable across calls', () => {
    expect(identityKey(identity)).toBe(identityKey(identity));
  });
});

describe('state read and write', () => {
  test('a missing record reads as null rather than throwing', () => {
    expect(store().store.read(identity, 'timeline')).toBeNull();
  });

  test('a written record round-trips', () => {
    const { store: s } = store();
    s.write(identity, 'timeline', { lastPromptAtMs: 1_700_000_000_000 });
    expect(s.read(identity, 'timeline')).toEqual({ lastPromptAtMs: 1_700_000_000_000 });
  });

  test('records for different identities do not overwrite each other', () => {
    const { store: s } = store();
    s.write(identity, 'timeline', { value: 'a' });
    s.write({ ...identity, agentId: 'agent-1' }, 'timeline', { value: 'b' });
    expect(s.read(identity, 'timeline')).toEqual({ value: 'a' });
    expect(s.read({ ...identity, agentId: 'agent-1' }, 'timeline')).toEqual({ value: 'b' });
  });

  test('every file stays inside the state root', () => {
    const { store: s, root } = store();
    s.write({ accountId: '../escape', threadId: '../../oops' }, 'timeline', { value: 1 });
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      const rel = relative(root, join(root, file));
      expect(isAbsolute(rel)).toBe(false);
      expect(rel.startsWith('..')).toBe(false);
    }
  });

  // A crash mid-write must not leave a truncated file that reads as valid.
  test('a corrupt record reads as null instead of throwing', () => {
    const { store: s, root } = store();
    s.write(identity, 'timeline', { value: 'a' });
    const file = s.pathFor(identity, 'timeline');
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, '{"value": tru');
    expect(s.read(identity, 'timeline')).toBeNull();
  });

  test('a replaced record leaves no temporary file behind', () => {
    const { store: s, root } = store();
    s.write(identity, 'timeline', { value: 'a' });
    s.write(identity, 'timeline', { value: 'b' });
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.includes('.tmp'));
    expect(files).toEqual([]);
    expect(s.read(identity, 'timeline')).toEqual({ value: 'b' });
  });

  test('the last writer wins without corrupting the record', () => {
    const { store: s } = store();
    for (let i = 0; i < 20; i += 1) s.write(identity, 'timeline', { value: i });
    expect(s.read(identity, 'timeline')).toEqual({ value: 19 });
  });
});

describe('isolation from the Claude runtime', () => {
  test('the Codex state root is a distinct subtree', () => {
    const { store: s } = store();
    expect(s.root).toContain('codex');
  });

  test('no credential or raw prompt text is persisted by the store itself', () => {
    const { store: s, root } = store();
    s.write(identity, 'job', { kind: 'keepalive', dueAtMs: 1_700_000_000_000 });
    const written = readFileSync(s.pathFor(identity, 'job'), 'utf8');
    expect(written).not.toContain('acct-1');
    expect(written).not.toContain('thread-1');
  });
});
