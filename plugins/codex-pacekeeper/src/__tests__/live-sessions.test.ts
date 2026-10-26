import { describe, expect, test } from 'bun:test';
import { nativeControlOwner } from '../live-sessions';

describe('native control-socket ownership evidence', () => {
  test('represents the socket by endpoint without fabricating a process id', () => {
    const owner = nativeControlOwner('child-thread', 'acct-1', '/tmp/codex-control.sock');
    expect(owner).not.toHaveProperty('pid');
    expect(owner.threadIds).toEqual(['child-thread']);
    expect(owner.socketPath).toBe('unix:///tmp/codex-control.sock');
  });

});
