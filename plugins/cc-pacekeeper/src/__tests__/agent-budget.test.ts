import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { stateKey } from '../state';
import {
    effectivePause,
    formatSubagentContract,
    formatPauseDirective,
    handoffsDir,
    writeHandoff,
    listHandoffs,
    hasHandoff,
    archiveHandoff,
    RESUME_MARKER
} from '../agent-budget';
import { DEFAULT_CONFIG, type Config } from '../config';
import type { Snapshot } from '../thresholds';

let TMP: string;

beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-agent-budget-'));
});

afterEach(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

const CFG: Config = DEFAULT_CONFIG; // auto: { five_hour_pct: 85, subagent_pause_pct: 75, ... }

function snapWithFive(pct: number): Snapshot {
    return {
        readings: [{ meter: 'five_hour', percent: pct, level: 'none', resetsAt: new Date(Date.now() + 3600_000).toISOString() }],
        maxLevel: 'none'
    };
}

describe('stateKey', () => {
    test('main thread: bare session id', () => {
        expect(stateKey('sid-1')).toBe('sid-1');
        expect(stateKey('sid-1', undefined)).toBe('sid-1');
    });

    test('subagent: composite sid:agentId', () => {
        expect(stateKey('sid-1', 'agent-a')).toBe('sid-1:agent-a');
    });

    test('different agents under the same session get distinct keys', () => {
        expect(stateKey('sid-1', 'agent-a')).not.toBe(stateKey('sid-1', 'agent-b'));
        expect(stateKey('sid-1', 'agent-a')).not.toBe(stateKey('sid-1'));
    });
});

describe('effectivePause [G2]', () => {
    test('spawned well below threshold: plain subagent_pause_pct', () => {
        expect(effectivePause(CFG, 30)).toBe(75);
    });

    test('spawned just below threshold: start+5 wins over the floor', () => {
        expect(effectivePause(CFG, 72)).toBe(77);
    });

    test('spawned at the threshold: start+5 gives working room', () => {
        expect(effectivePause(CFG, 75)).toBe(80);
    });

    test('spawned above threshold: capped at five_hour_pct', () => {
        expect(effectivePause(CFG, 82)).toBe(85);
        expect(effectivePause(CFG, 90)).toBe(85);
    });
});

describe('formatSubagentContract', () => {
    test('bakes the concrete effective-pause number and spawn pct into the text', () => {
        const text = formatSubagentContract(snapWithFive(80), CFG, 'ag-1', 'Explore', 80);
        expect(text).toContain('Pause at 85%');
        expect(text).toContain('spawned at ~80%');
        expect(text).toContain('ag-1');
        expect(text).toContain('Explore');
    });

    test('[G1] carries the cascade clause', () => {
        const text = formatSubagentContract(snapWithFive(30), CFG, 'ag-2', undefined, 30);
        expect(text).toContain('Cascade clause');
        expect(text).toContain('PAUSED-BUDGET');
        expect(text).toContain('do not re-dispatch it or attempt its work yourself');
    });

    test('instructs handoff write via CLI verb and PAUSED-BUDGET return', () => {
        const text = formatSubagentContract(snapWithFive(30), CFG, 'ag-3', 'general-purpose', 30);
        expect(text).toContain('handoffs write ag-3');
        expect(text).toContain('PAUSED-BUDGET ag-3');
        // Children get their own contract — do not relay.
        expect(text).toContain('do not relay');
    });

    test('embeds the absolute CLI path when CLAUDE_PLUGIN_ROOT is set (subagent Bash has no PATH shim)', () => {
        const prev = process.env.CLAUDE_PLUGIN_ROOT;
        process.env.CLAUDE_PLUGIN_ROOT = '/opt/pk-root';
        try {
            const text = formatSubagentContract(snapWithFive(30), CFG, 'ag-5', undefined, 30);
            expect(text).toContain('/opt/pk-root/bin/pacekeeper-checkpoint handoffs write ag-5');
            expect(text).toContain('do not search the filesystem');
            const pause = formatPauseDirective(snapWithFive(90), 'ag-5', 85);
            expect(pause).toContain('/opt/pk-root/bin/pacekeeper-checkpoint handoffs write ag-5');
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
            else process.env.CLAUDE_PLUGIN_ROOT = prev;
        }
    });

    test('omits any ctx clause (step 0: transcript is shared with the parent)', () => {
        const text = formatSubagentContract(snapWithFive(30), CFG, 'ag-4', undefined, 30);
        expect(text).not.toContain('ctx');
        expect(text).not.toContain('context window');
    });
});

describe('formatPauseDirective', () => {
    test('names the agent, the pause pct, and the pause protocol', () => {
        const text = formatPauseDirective(snapWithFive(78), 'ag-9', 77);
        expect(text).toContain('77%');
        expect(text).toContain('handoffs write ag-9');
        expect(text).toContain('PAUSED-BUDGET ag-9');
        expect(text).toContain('Do not start new work');
    });
});

describe('handoff registry', () => {
    const DIR_NAME = '.claude-checkpoints';

    test('write → list → archive round-trip', () => {
        const written = writeHandoff({
            cwd: TMP, checkpointDirName: DIR_NAME,
            agentId: 'ag-a', agentType: 'Explore', trigger: 'budget_pause',
            body: '## Goal\nscan things\n\n## Done\nhalf\n\n## Next\nother half\n\n## Files touched\n- x.ts'
        });
        expect(written).toBe(path.join(handoffsDir(TMP, DIR_NAME), 'ag-a.md'));
        expect(hasHandoff(TMP, DIR_NAME, 'ag-a')).toBe(true);

        const listed = listHandoffs(TMP, DIR_NAME);
        expect(listed.length).toBe(1);
        expect(listed[0]!.frontmatter.agent_id).toBe('ag-a');
        expect(listed[0]!.frontmatter.agent_type).toBe('Explore');
        expect(listed[0]!.frontmatter.trigger).toBe('budget_pause');
        expect(listed[0]!.body).toContain('## Next');

        const moved = archiveHandoff(TMP, DIR_NAME, 'ag-a');
        expect(moved).toContain(path.join('handoffs', 'archive', 'ag-a.md'));
        expect(hasHandoff(TMP, DIR_NAME, 'ag-a')).toBe(false);
        expect(listHandoffs(TMP, DIR_NAME).length).toBe(0);
    });

    test('archived files do not appear in listHandoffs', () => {
        writeHandoff({ cwd: TMP, checkpointDirName: DIR_NAME, agentId: 'ag-b', trigger: 't', body: 'b' });
        writeHandoff({ cwd: TMP, checkpointDirName: DIR_NAME, agentId: 'ag-c', trigger: 't', body: 'c' });
        archiveHandoff(TMP, DIR_NAME, 'ag-b');
        const listed = listHandoffs(TMP, DIR_NAME);
        expect(listed.map(h => h.frontmatter.agent_id)).toEqual(['ag-c']);
    });

    test('archiveHandoff on a missing agent id returns null', () => {
        expect(archiveHandoff(TMP, DIR_NAME, 'nope')).toBeNull();
    });

    test('re-archiving the same agent id gets a numbered filename, no clobber', () => {
        writeHandoff({ cwd: TMP, checkpointDirName: DIR_NAME, agentId: 'ag-d', trigger: 't', body: 'v1' });
        archiveHandoff(TMP, DIR_NAME, 'ag-d');
        writeHandoff({ cwd: TMP, checkpointDirName: DIR_NAME, agentId: 'ag-d', trigger: 't', body: 'v2' });
        const moved = archiveHandoff(TMP, DIR_NAME, 'ag-d');
        expect(moved).toContain('ag-d-1.md');
    });
});

describe('RESUME_MARKER', () => {
    test('is the stable literal used across auto-loop, approve, and orientation', () => {
        expect(RESUME_MARKER).toBe('[pacekeeper-resume]');
    });
});
