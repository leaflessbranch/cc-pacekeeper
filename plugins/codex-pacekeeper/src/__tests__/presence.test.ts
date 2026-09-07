import { describe, expect, test } from 'bun:test';
import { fusePresence, probeSsh, type ProbeResult } from '../presence';

const unavailable: ProbeResult = { status: 'unavailable' };
const attachedActive: ProbeResult = { status: 'attached', idleSeconds: 10 };
const attachedIdle: ProbeResult = { status: 'attached', idleSeconds: 4_000 };
const detached: ProbeResult = { status: 'detached' };

const IDLE_SECONDS = 600;

describe('probe fusion', () => {
  test('an attached probe with recent activity reports online', () => {
    expect(
      fusePresence({ tmux: attachedActive, tty: unavailable, ssh: unavailable, loginctl: unavailable }, IDLE_SECONDS)
    ).toBe('online');
  });

  // The load-bearing asymmetry: degradation fails toward "assume present",
  // because a false afk reroutes output away from someone who is watching.
  test('an unavailable probe never votes afk', () => {
    expect(
      fusePresence({ tmux: unavailable, tty: unavailable, ssh: unavailable, loginctl: unavailable }, IDLE_SECONDS)
    ).toBe('unknown');
  });

  test('all probes unavailable is unknown, never afk', () => {
    const result = fusePresence(
      { tmux: unavailable, tty: unavailable, ssh: unavailable, loginctl: unavailable },
      IDLE_SECONDS
    );
    expect(result).not.toBe('afk');
  });

  test('one active probe outvotes several idle ones', () => {
    expect(
      fusePresence({ tmux: attachedIdle, tty: attachedIdle, ssh: attachedActive, loginctl: detached }, IDLE_SECONDS)
    ).toBe('online');
  });

  test('attachment without recent activity is afk, not online', () => {
    expect(
      fusePresence({ tmux: attachedIdle, tty: unavailable, ssh: unavailable, loginctl: unavailable }, IDLE_SECONDS)
    ).toBe('afk');
  });

  // A live socket lingers for minutes after a laptop closes, so connection
  // existence alone must not read as presence.
  test('a detached probe alone is not presence', () => {
    expect(
      fusePresence({ tmux: detached, tty: detached, ssh: detached, loginctl: detached }, IDLE_SECONDS)
    ).toBe('afk');
  });

  test('an attached probe with unknown idle time cannot claim online', () => {
    const noIdle: ProbeResult = { status: 'attached' };
    expect(
      fusePresence({ tmux: noIdle, tty: unavailable, ssh: unavailable, loginctl: unavailable }, IDLE_SECONDS)
    ).toBe('unknown');
  });

  test('the idle boundary is inclusive of activity within the window', () => {
    const boundary: ProbeResult = { status: 'attached', idleSeconds: IDLE_SECONDS };
    expect(
      fusePresence({ tmux: boundary, tty: unavailable, ssh: unavailable, loginctl: unavailable }, IDLE_SECONDS)
    ).toBe('online');
  });
});

describe('non-Linux fallback', () => {
  test('a platform with no probes reports unknown rather than claiming detection', () => {
    expect(
      fusePresence({ tmux: unavailable, tty: unavailable, ssh: unavailable, loginctl: unavailable }, IDLE_SECONDS)
    ).toBe('unknown');
  });
});

describe('SSH probe', () => {
  test('remote logins with unreadable tty activity are unavailable, not idle', () => {
    const result = probeSsh(Date.now(), IDLE_SECONDS * 1000, {
      who: () => 'user pts/9 2026-09-07 10:00 (fixture.invalid)',
      statAtimeMs: () => { throw new Error('permission denied'); }
    });
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('unreadable');
  });
});
