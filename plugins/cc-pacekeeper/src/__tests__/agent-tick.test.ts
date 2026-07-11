import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RESUME_MARKER, writeHandoff } from '../agent-budget';
import { saveCheckpoint } from '../checkpoint';

const TICK = path.join(import.meta.dir, '..', 'tick.ts');

/**
 * v0.4 agent-budget + auto-loop wiring, exercised through the real tick binary
 * under a sandboxed HOME (same pattern as keepalive-wiring.test.ts). No model
 * id anywhere in the fixtures, so no model-info fetch is attempted.
 */

let HOME = '';
let counter = 0;
const newSid = (): string => `agent-tick-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

beforeEach(() => {
    HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-agent-tick-'));
    fs.mkdirSync(path.join(HOME, '.cache', 'cc-pacekeeper'), { recursive: true });
    fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(HOME, 'proj'), { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeUsage(sessionUsage: number, resetInMs = 3 * 3600_000): string {
    const resetAt = new Date(Date.now() + resetInMs).toISOString();
    fs.writeFileSync(
        path.join(HOME, '.cache', 'cc-pacekeeper', 'usage.json'),
        JSON.stringify({ sessionUsage, sessionResetAt: resetAt, weeklyUsage: 40, fetchedAt: Date.now() })
    );
    return resetAt;
}

/** Transcript whose latest assistant usage yields the given context length. */
function writeTranscript(contextTokens: number): string {
    const p = path.join(HOME, 't.jsonl');
    fs.writeFileSync(p, JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', usage: { input_tokens: contextTokens } }
    }) + '\n');
    return p;
}

function runTick(payload: Record<string, unknown>): string {
    const res = spawnSync('bun', ['run', '--silent', TICK], {
        input: JSON.stringify({ cwd: path.join(HOME, 'proj'), ...payload }),
        env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude') },
        encoding: 'utf8'
    });
    return res.stdout ?? '';
}

function sessionState(): Record<string, Record<string, unknown>> {
    try {
        return JSON.parse(fs.readFileSync(path.join(HOME, '.cache', 'cc-pacekeeper', 'session-state.json'), 'utf8'));
    } catch {
        return {};
    }
}

describe('auto-loop (main thread)', () => {
    test('fires once per block, then is idempotent on the same resetsAt', () => {
        writeUsage(86, 10 * 60_000);
        const sid = newSid();
        const first = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
        expect(first).toContain('auto-renewal');
        expect(first).toContain(RESUME_MARKER);
        expect(first).toContain('This overrides any keepalive single-word instruction');
        expect(first).toContain('do not ask the user first');

        const second = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
        expect(second).not.toContain('auto-renewal');
    });

    test('does not re-fire on sub-minute resetsAt jitter within the same block', () => {
        const sid = newSid();
        // Same block, but the usage API jitters resetsAt at sub-second
        // precision between fetches (observed live: 6 re-fires in one block).
        // Pin base to mid-minute so the jittered offsets below never cross
        // a minute boundary and the test stays deterministic.
        const base = Math.floor((Date.now() + 10 * 60_000) / 60_000) * 60_000 + 30_000;
        const writeJittered = (pct: number, offsetMs: number): void => {
            fs.writeFileSync(
                path.join(HOME, '.cache', 'cc-pacekeeper', 'usage.json'),
                JSON.stringify({ sessionUsage: pct, sessionResetAt: new Date(base + offsetMs).toISOString(), weeklyUsage: 40, fetchedAt: Date.now() })
            );
        };
        writeJittered(86, 287);
        expect(runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' })).toContain('auto-renewal');
        writeJittered(91, -912); // different second, same minute
        expect(runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' })).not.toContain('auto-renewal');
        writeJittered(93, 485);
        expect(runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' })).not.toContain('auto-renewal');
    });

    test('suppresses the legacy ask-style 5h nudge after the auto directive fired this block', () => {
        writeUsage(86, 2 * 3600_000);
        const sid = newSid();
        expect(runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' })).toContain('auto-renewal');
        // Usage climbs in the same block: no re-fire (idempotent) AND no
        // legacy "ask the user whether to save" nudge — the save already
        // happened without asking.
        writeUsage(92, 2 * 3600_000);
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
        expect(out).not.toContain('auto-renewal');
        expect(out).not.toContain('ask the user');
        const stop = runTick({ session_id: sid, hook_event_name: 'Stop' });
        expect(stop).not.toContain('limits remain elevated');
    });

    test('ignores a stale five_hour reading (rollover, cache not refreshed)', () => {
        const sid = newSid();
        // resetsAt in the past: percent is the ENDED block's value.
        writeUsage(94, -5 * 60_000);
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
        expect(out).not.toContain('auto-renewal');
        expect(out).toContain('5h rolled over (was 94%');
        // Subagents spawned against stale data get the default pause floor,
        // not an instant pause at the ended block's 94%.
        runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-st' });
        const sub = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'ag-st' });
        expect(sub).not.toContain('PAUSED-BUDGET');
    });

    test('re-fires when the block resetsAt changes (new block)', () => {
        writeUsage(86, 10 * 60_000);
        const sid = newSid();
        expect(runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' })).toContain('auto-renewal');
        // New block: different resetsAt, usage climbed again.
        writeUsage(87, 4 * 3600_000);
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
        expect(out).toContain('auto-renewal');
    });

    test('takes precedence over the bridge directive on the same tick', () => {
        // 86% with reset in 10m < bridge.max_wait_min would normally emit the
        // bridge "wait it out" text — the auto directive must win instead.
        writeUsage(86, 10 * 60_000);
        const sid = newSid();
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
        expect(out).toContain('auto-renewal');
        expect(out).not.toContain('close enough to wait out');
    });

    test('does not fire below five_hour_pct', () => {
        writeUsage(80);
        const sid = newSid();
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
        expect(out).not.toContain('auto-renewal');
    });

    test('does not fire from a subagent tick even at the threshold', () => {
        writeUsage(86, 10 * 60_000);
        const sid = newSid();
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'ag-x' });
        expect(out).not.toContain('auto-renewal');
    });
});

describe('ctx auto-save crossing re-arm [G4]', () => {
    // usable window = 200k * 0.8 = 160k; critical at 90% = 144k.
    test('fires at critical, stays quiet while armed, re-fires after dipping below warn', () => {
        const sid = newSid();
        const transcript = writeTranscript(150_000); // ~94% — critical

        const first = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
        expect(first).toContain('Context window at critical');
        expect(first).toContain('do not ask');

        const second = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
        expect(second).not.toContain('Context window at critical');

        // Compaction happened: ctx drops below warn → disarm.
        writeTranscript(50_000); // ~31%
        runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });

        // Climb again → re-fire.
        writeTranscript(150_000);
        const fourth = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
        expect(fourth).toContain('Context window at critical');
    });

    test('combined 5h+ctx: single auto-loop directive covers both, ctx directive suppressed', () => {
        writeUsage(86, 10 * 60_000);
        const sid = newSid();
        const transcript = writeTranscript(150_000);
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
        expect(out).toContain('auto-renewal');
        expect(out).toContain('context also critical — one save covers both');
        expect(out).not.toContain('Context window at critical —');
        // Follow-up tick: neither directive re-fires (both armed).
        const again = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
        expect(again).not.toContain('auto-renewal');
        expect(again).not.toContain('Context window at critical');
    });
});

describe('resume-marker prompt [G5]', () => {
    test('injects orientation (resume + handoffs archive) instead of suppressing', () => {
        writeUsage(20);
        const proj = path.join(HOME, 'proj');
        saveCheckpoint({
            cwd: proj, checkpointDirName: '.claude-checkpoints',
            frontmatter: { trigger: 'auto_block_renewal', name: 'feat-x' },
            body: '## Goal\nfinish'
        });
        writeHandoff({ cwd: proj, checkpointDirName: '.claude-checkpoints', agentId: 'ag-1', trigger: 'budget_pause', body: 'b' });

        const sid = newSid();
        const out = runTick({
            session_id: sid, hook_event_name: 'UserPromptSubmit',
            prompt: `${RESUME_MARKER} lane feat-x — resume and re-dispatch`
        });
        expect(out).toContain('pacekeeper-checkpoint resume');
        expect(out).toContain('handoffs archive');
        expect(out).toContain('feat-x');
        expect(out).toContain('ag-1');
        // Not treated as a keepalive ping (no suppression/block).
        expect(out).not.toContain('"decision":"block"');
    });

    test('a prompt quoting the resume marker mid-text does not trigger orientation', () => {
        // Regression: a pasted subagent report that merely QUOTES the resume
        // marker must not be misclassified as the auto-wake trigger.
        writeUsage(20);
        const sid = newSid();
        const out = runTick({
            session_id: sid, hook_event_name: 'UserPromptSubmit',
            prompt: `subagent report: "${RESUME_MARKER} orientation done"`
        });
        expect(out).not.toContain('Auto-wake fired');
        expect(out).not.toContain('handoffs archive');
        // Still gets the normal per-prompt heartbeat.
        expect(out).toContain('[pacekeeper]');
    });
});

describe('subagent branches', () => {
    test('SubagentStart injects the contract and snapshots blockPctAtStart on the agent key', () => {
        writeUsage(80);
        const sid = newSid();
        const out = runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-s', agent_type: 'Explore' });
        expect(out).toContain('Pause at 85%');
        expect(out).toContain('Cascade clause');
        expect(out).toContain('ag-s');
        const entry = sessionState()[`${sid}:ag-s`];
        expect(entry?.blockPctAtStart).toBe(80);
    });

    test('subagent PreToolUse gets the compact tick line with the baked pause point, no ctx', () => {
        writeUsage(45);
        const sid = newSid();
        runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-t' });
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'ag-t' });
        expect(out).toContain('5h 45%');
        expect(out).toContain('pause at 75%');
        expect(out).not.toContain('ctx');
        expect(out).not.toContain('session '); // no main-thread time segment
    });

    test('subagent PreToolUse escalates to the pause directive at/above the effective pause', () => {
        writeUsage(86);
        const sid = newSid();
        runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-u' });
        const out = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'ag-u' });
        expect(out).toContain('PAUSED-BUDGET ag-u');
        expect(out).toContain('handoffs write ag-u');
    });

    test('SubagentStop accumulates the burn delta into the main entry', () => {
        writeUsage(45);
        const sid = newSid();
        runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-v' });
        writeUsage(52); // agent burned 7% of the block
        runTick({ session_id: sid, hook_event_name: 'SubagentStop', agent_id: 'ag-v' });
        const main = sessionState()[sid];
        expect(main?.agentBurnPct).toBe(7);
        expect(main?.agentRuns).toBe(1);
    });

    test('main tick line surfaces `agents ~N%` after subagent burn', () => {
        writeUsage(45);
        const sid = newSid();
        runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-w' });
        writeUsage(52);
        runTick({ session_id: sid, hook_event_name: 'SubagentStop', agent_id: 'ag-w' });
        const out = runTick({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'carry on' });
        expect(out).toContain('agents ~7%');
    });

    test('burn accumulator resets on block rollover and stale totals are not displayed', () => {
        writeUsage(45);
        const sid = newSid();
        runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-x' });
        writeUsage(52);
        runTick({ session_id: sid, hook_event_name: 'SubagentStop', agent_id: 'ag-x' });
        expect(sessionState()[sid]?.agentBurnPct).toBe(7);

        // New block (different resetsAt minute): the old total must neither
        // display nor seed the next accumulation.
        writeUsage(3, 4 * 3600_000);
        const line = runTick({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'carry on' });
        expect(line).not.toContain('agents ~');
        runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-y' });
        writeUsage(8, 4 * 3600_000);
        runTick({ session_id: sid, hook_event_name: 'SubagentStop', agent_id: 'ag-y' });
        expect(sessionState()[sid]?.agentBurnPct).toBe(5);
        expect(sessionState()[sid]?.agentRuns).toBe(1);
    });

    test('SubagentStop notes an existing handoff for the agent', () => {
        writeUsage(86);
        const proj = path.join(HOME, 'proj');
        writeHandoff({ cwd: proj, checkpointDirName: '.claude-checkpoints', agentId: 'ag-z', trigger: 'budget_pause', body: 'b' });
        const sid = newSid();
        runTick({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'ag-z' });
        const out = runTick({ session_id: sid, hook_event_name: 'SubagentStop', agent_id: 'ag-z' });
        expect(out).toContain('paused on budget');
        expect(out).toContain('ag-z');
    });
});

describe('dispatch advisory', () => {
    test('cautions (advisory only) on Agent dispatch when 5h is at warn+', () => {
        writeUsage(80); // warn at 85 default? warn threshold five_hour is 85... 80 is notify.
        const sid = newSid();
        // 80 is below warn (85) — no advisory.
        const quiet = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Agent' });
        expect(quiet).not.toContain('inherit this budget');
        // 86 is warn+ → advisory appears, and it is context-only (no deny).
        writeUsage(86, 10 * 60_000);
        const out = runTick({ session_id: newSid(), hook_event_name: 'PreToolUse', tool_name: 'Agent' });
        expect(out).toContain('inherit this budget');
        expect(out).not.toContain('"permissionDecision":"deny"');
        expect(out).not.toContain('"decision":"block"');
    });
});
