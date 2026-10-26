import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { nativeControlOwner, nativeControlSocketPath } from '../live-sessions';

describe('native control-socket ownership evidence', () => {
  test('represents the socket by endpoint without fabricating a process id', () => {
    const owner = nativeControlOwner('child-thread', 'acct-1', '/tmp/codex-control.sock');
    expect(owner).not.toHaveProperty('pid');
    expect(owner.threadIds).toEqual(['child-thread']);
    expect(owner.socketPath).toBe('unix:///tmp/codex-control.sock');
  });

});

describe('control socket discovery through an aliased Codex home', () => {
  test('a socket under a symlinked CODEX_HOME is found (macOS /var -> /private/var)', () => {
    const real = mkdtempSync('/tmp/cpk-home-') /* short: macOS caps socket paths at 104 bytes */;
    const alias = `${real}-alias`;
    const previous = process.env['CODEX_HOME'];
    const previousSocket = process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'];
    mkdirSync(join(real, 'app-server-control'));
    symlinkSync(real, alias);
    const server = Bun.serve({ unix: join(real, 'app-server-control', 'app-server-control.sock'), fetch: () => new Response('') });
    try {
      process.env['CODEX_HOME'] = alias;
      delete process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'];
      expect(nativeControlSocketPath()).toBe(join(realpathSync(real), 'app-server-control', 'app-server-control.sock'));
    } finally {
      server.stop(true);
      if (previous === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = previous;
      if (previousSocket !== undefined) process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'] = previousSocket;
      rmSync(alias, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('control socket published as a symlink (Codex 0.164 daemon)', () => {
  // Codex 0.164 publishes app-server-control.sock as a symlink to the daemon's
  // socket under /tmp/codex-daemon-<uid>/. The link is followed once, and the
  // target must still sit under an allowed root.
  function withSymlinkedSocket(targetDir: (home: string) => string, check: (home: string, target: string) => void): void {
    const home = mkdtempSync('/tmp/cpk-sym-');
    const previous = process.env['CODEX_HOME'];
    const previousSocket = process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'];
    const dir = targetDir(home);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, 'app-server-control'));
    const target = join(dir, 's');
    const server = Bun.serve({ unix: target, fetch: () => new Response('') });
    symlinkSync(target, join(home, 'app-server-control', 'app-server-control.sock'));
    try {
      process.env['CODEX_HOME'] = home;
      delete process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'];
      check(home, target);
    } finally {
      server.stop(true);
      if (previous === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = previous;
      if (previousSocket !== undefined) process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'] = previousSocket;
      rmSync(`${home}-out`, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('a symlink to a socket under an allowed root resolves to the target', () => {
    withSymlinkedSocket((home) => join(home, 'daemon'), (_home, target) => {
      expect(nativeControlSocketPath()).toBe(join(realpathSync(join(target, '..')), 's'));
    });
  });

  test('a symlink to a socket outside the allowed roots is refused', () => {
    withSymlinkedSocket((home) => `${home}-out`, () => {
      expect(nativeControlSocketPath()).toBeNull();
    });
  });
});
