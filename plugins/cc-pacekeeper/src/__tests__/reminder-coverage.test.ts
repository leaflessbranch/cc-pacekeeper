import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_CONFIG } from '../config';
import { saveCheckpoint } from '../checkpoint';

const TICK = path.join(import.meta.dir, '..', 'tick.ts');

/**
 * Issue 1 (escalation-reminder de-dup) and Issue 2 (away-routing) exercised
 * through the real tick binary under a sandboxed HOME — same pattern as
 * agent-tick.test.ts. No model id in fixtures, so no model-info fetch runs.
 *
 * Escalation is driven through the WEEKLY meter (warn 70, crit 85) with low 5h
 * usage and a far 5h reset, so auto-loop / 5h-bridge stay dormant. The config
 * sets debounce_seconds:0 so applyDebounce always fires — proving it's the
 * once-per-level COVERAGE gate (not the debounce timer) that stops the repeat.
 */

let HOME = '';
let counter = 0;
const newSid = (): string => `rc-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

function writeConfig(over: { preferred?: string[]; target?: string } = {}): void {
    const dir = path.join(HOME, '.config', 'cc-pacekeeper');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = {
        ...DEFAULT_CONFIG,
        debounce_seconds: 0,
        bridge: { ...DEFAULT_CONFIG.bridge, enabled: false },
        auto: { ...DEFAULT_CONFIG.auto, enabled: false },
        channels: {
            preferred: over.preferred ?? [],
            target: over.target ?? '',
            asked: true
        }
    };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
}

beforeEach(() => {
    HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-rc-'));
    fs.mkdirSync(path.join(HOME, '.cache', 'cc-pacekeeper'), { recursive: true });
    fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(HOME, 'proj'), { recursive: true });
    writeConfig();
});

afterEach(() => {
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

const WEEKLY_RESET_DEFAULT = 3 * 24 * 3600_000;

function writeUsage(weeklyUsage: number, weeklyResetInMs = WEEKLY_RESET_DEFAULT): string {
    const weeklyResetAt = new Date(Date.now() + weeklyResetInMs).toISOString();
    fs.writeFileSync(
        path.join(HOME, '.cache', 'cc-pacekeeper', 'usage.json'),
        JSON.stringify({
            sessionUsage: 10,
            sessionResetAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
            weeklyUsage,
            weeklyResetAt,
            fetchedAt: Date.now()
        })
    );
    return weeklyResetAt;
}

function setPresence(state: 'online' | 'afk' | 'unknown'): void {
    fs.writeFileSync(
        path.join(HOME, '.cache', 'cc-pacekeeper', 'presence-state.json'),
        JSON.stringify({ state, at: new Date().toISOString() })
    );
}

function runTick(payload: Record<string, unknown>): string {
    const res = spawnSync('bun', ['run', '--silent', TICK], {
        input: JSON.stringify({ cwd: path.join(HOME, 'proj'), ...payload }),
        env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude') },
        encoding: 'utf8'
    });
    return res.stdout ?? '';
}

/** A realistic turn: a prompt, which is where directiveIfEscalated fires. */
function prompt(sid: string): string {
    return runTick({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'go' });
}

const WARN_TEXT = 'ask the user whether to save a checkpoint';
const CRIT_TEXT = 'At critical threshold';

describe('Issue 1 — escalation reminder fires once per level (UserPromptSubmit path)', () => {
    test('warn fires once, then silent across turns at the same level', () => {
        writeUsage(72); // weekly warn
        const sid = newSid();
        expect(prompt(sid)).toContain(WARN_TEXT);
        // debounce_seconds:0 → without coverage this would re-fire every turn.
        expect(prompt(sid)).not.toContain(WARN_TEXT);
        expect(prompt(sid)).not.toContain(WARN_TEXT);
    });

    test('warn→critical fires a second time, then silent at critical', () => {
        const sid = newSid();
        writeUsage(72);
        expect(prompt(sid)).toContain(WARN_TEXT);
        expect(prompt(sid)).not.toContain(WARN_TEXT);
        writeUsage(88); // critical, same weekly window
        const crit = prompt(sid);
        expect(crit).toContain(CRIT_TEXT);
        expect(prompt(sid)).not.toContain(CRIT_TEXT);
    });

    test('coverage is shared with the Stop reminder', () => {
        const sid = newSid();
        writeUsage(72);
        expect(prompt(sid)).toContain(WARN_TEXT);        // covers weekly@warn
        // Stop in the same turn-sequence must not re-nag.
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).not.toContain('limits remain elevated');
    });

    test('a this-window checkpoint at warn suppresses warn but not a later critical', () => {
        const sid = newSid();
        const weeklyResetAt = writeUsage(72);
        saveCheckpoint({
            cwd: path.join(HOME, 'proj'),
            checkpointDirName: '.claude-checkpoints',
            frontmatter: { name: 'lane-a', meters: { weekly_pct: 72, weekly_resets_at: weeklyResetAt } },
            body: 'x'
        });
        expect(prompt(sid)).not.toContain(WARN_TEXT);    // warn covered by the save
        writeUsage(88, WEEKLY_RESET_DEFAULT);            // same window, now critical
        expect(prompt(sid)).toContain(CRIT_TEXT);        // warn-band save can't cover critical
    });

    test('a checkpoint from a different window does not suppress', () => {
        const sid = newSid();
        writeUsage(72);
        saveCheckpoint({
            cwd: path.join(HOME, 'proj'),
            checkpointDirName: '.claude-checkpoints',
            frontmatter: {
                name: 'lane-old',
                meters: { weekly_pct: 72, weekly_resets_at: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() }
            },
            body: 'x'
        });
        expect(prompt(sid)).toContain(WARN_TEXT);
    });

    // Note: the "new window re-arms" property is proven at the unit level in
    // reminder-coverage-unit.test.ts. Driving it through the tick binary is
    // confounded by applyDebounce's own window-agnostic same-level gate at
    // sub-second test speeds, so it isn't asserted here.
});

describe('Issue 2 — away-routing standing directive (Stop path)', () => {
    const AWAY_TEXT = 'stepped away';

    test('injected once per episode when away and a channel is configured', () => {
        writeConfig({ preferred: ['chan-a'], target: 'dest-1' });
        setPresence('afk');
        const sid = newSid();
        const first = runTick({ session_id: sid, hook_event_name: 'Stop' });
        expect(first).toContain(AWAY_TEXT);
        expect(first).toContain('chan-a');
        // Standing instruction — not repeated on the next away turn-end.
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).not.toContain(AWAY_TEXT);
    });

    test('returning online clears the marker; a later departure re-injects', () => {
        writeConfig({ preferred: ['chan-a'] });
        const sid = newSid();
        setPresence('afk');
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).toContain(AWAY_TEXT);
        setPresence('online');
        runTick({ session_id: sid, hook_event_name: 'Stop' }); // clears marker
        setPresence('afk');
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).toContain(AWAY_TEXT);
    });

    test('unknown presence does not clear the marker', () => {
        writeConfig({ preferred: ['chan-a'] });
        const sid = newSid();
        setPresence('afk');
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).toContain(AWAY_TEXT);
        setPresence('unknown');
        runTick({ session_id: sid, hook_event_name: 'Stop' }); // must NOT clear
        setPresence('afk');
        // Still same episode as far as the marker is concerned → no re-inject.
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).not.toContain(AWAY_TEXT);
    });

    test('no directive when no channel is configured', () => {
        // Default config: channels.preferred empty.
        setPresence('afk');
        const sid = newSid();
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).not.toContain(AWAY_TEXT);
    });
});
