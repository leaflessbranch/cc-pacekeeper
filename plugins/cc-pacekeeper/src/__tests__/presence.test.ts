import { describe, expect, test } from 'bun:test';
import { fuse, parseWhoRemoteTtys, type Signal } from '../presence';

const IDLE_MS = 10 * 60_000; // matches DEFAULT_CONFIG.presence.idle_minutes
const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);

const active = (name: string): Signal => ({ name, state: 'active', lastActivityMs: NOW - 60_000 });
const idle = (name: string): Signal => ({ name, state: 'idle', lastActivityMs: NOW - 60 * 60_000 });
const gone = (name: string): Signal => ({ name, state: 'unavailable' });

describe('fuse — ladder precedence', () => {
    test('recent hook event wins over every idle probe', () => {
        // The user demonstrably typed in this session; machine probes lag.
        const p = fuse([idle('tmux'), idle('tty'), idle('ssh')], 30_000, IDLE_MS);
        expect(p.state).toBe('online');
    });

    test('stale hook gap does not by itself force afk', () => {
        const p = fuse([active('tmux'), idle('tty')], 60 * 60_000, IDLE_MS);
        expect(p.state).toBe('online');
    });

    test('any active probe yields online', () => {
        const p = fuse([idle('tmux'), active('tty'), idle('ssh')], null, IDLE_MS);
        expect(p.state).toBe('online');
    });

    test('all available probes idle yields afk', () => {
        const p = fuse([idle('tmux'), idle('tty'), idle('ssh')], 60 * 60_000, IDLE_MS);
        expect(p.state).toBe('afk');
    });
});

describe('fuse — degradation must never fabricate afk', () => {
    test('all probes unavailable yields unknown, not afk', () => {
        // A false afk reroutes output away from a user who is watching, so
        // absence of information must never read as absence of the user.
        const p = fuse([gone('tmux'), gone('tty'), gone('ssh'), gone('loginctl')], null, IDLE_MS);
        expect(p.state).toBe('unknown');
    });

    test('empty probe set yields unknown', () => {
        expect(fuse([], null, IDLE_MS).state).toBe('unknown');
    });

    test('an unavailable probe alongside an idle one still yields afk', () => {
        // The idle probe is real evidence of absence; the unavailable one abstains.
        const p = fuse([gone('tmux'), idle('tty')], 60 * 60_000, IDLE_MS);
        expect(p.state).toBe('afk');
    });

    test('unavailable probes never outvote an active one', () => {
        const p = fuse([gone('tmux'), gone('loginctl'), active('ssh')], null, IDLE_MS);
        expect(p.state).toBe('online');
    });
});

describe('fuse — nesting: SSH x tmux', () => {
    test('detached tmux under live ssh does not read as present', () => {
        // The closed-laptop case: the socket lingers, nobody is there.
        const signals: Signal[] = [
            { name: 'tmux', state: 'idle', detail: 'no attached clients' },
            { name: 'ssh', state: 'idle', detail: '1 login(s), no readable tty' }
        ];
        expect(fuse(signals, 60 * 60_000, IDLE_MS).state).toBe('afk');
    });

    test('attached tmux with recent activity reads as present', () => {
        const p = fuse([active('tmux'), idle('ssh')], 60 * 60_000, IDLE_MS);
        expect(p.state).toBe('online');
    });

    test('bare ssh with recent tty activity reads as present', () => {
        const p = fuse([gone('tmux'), active('ssh')], 60 * 60_000, IDLE_MS);
        expect(p.state).toBe('online');
    });
});

describe('parseWhoRemoteTtys', () => {
    // Verbatim `who` output from a Linux box running tmux under X, with two
    // real SSH logins. Counting tmux panes or the X display as SSH would
    // fabricate remote presence on a purely local machine.
    const REAL_WHO = [
        'user    pts/0        2026-07-26 08:13 (192.0.2.10)',
        'user    pts/1        2026-07-22 16:12 (tmux(3816).%3)',
        'user    pts/2        2026-07-17 15:42 (tmux(3816).%2)',
        'user    pts/3        2026-07-26 08:37 (192.0.2.10)',
        'user    pts/4        2026-07-15 13:22 (tmux(3816).%1)',
        'user    seat0        2026-07-15 23:00 (login screen)',
        'user    :1           2026-07-15 23:00 (:1)'
    ].join('\n');

    test('counts only genuine remote logins', () => {
        expect(parseWhoRemoteTtys(REAL_WHO)).toEqual(['pts/0', 'pts/3']);
    });

    test('excludes tmux panes, X displays and the local console', () => {
        const local = REAL_WHO.split('\n').filter(l => !l.includes('192.0.2')).join('\n');
        expect(parseWhoRemoteTtys(local)).toEqual([]);
    });

    test('accepts hostnames as well as IPs', () => {
        const out = 'user    pts/5        2026-07-26 08:13 (workstation.lan)';
        expect(parseWhoRemoteTtys(out)).toEqual(['pts/5']);
    });

    test('empty output yields no logins', () => {
        expect(parseWhoRemoteTtys('')).toEqual([]);
    });
});

describe('fuse — lastActivityMs', () => {
    test('reports the most recent activity across probes', () => {
        const signals: Signal[] = [
            { name: 'tmux', state: 'idle', lastActivityMs: NOW - 3600_000 },
            { name: 'tty', state: 'idle', lastActivityMs: NOW - 900_000 }
        ];
        expect(fuse(signals, null, IDLE_MS).lastActivityMs).toBe(NOW - 900_000);
    });

    test('is null when no probe reported a timestamp', () => {
        expect(fuse([gone('tmux')], null, IDLE_MS).lastActivityMs).toBeNull();
    });
});
