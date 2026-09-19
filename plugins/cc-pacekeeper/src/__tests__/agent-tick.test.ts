import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
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
    for (const f of fixtures.splice(0)) {
        try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

/** Git fixtures that must sit outside the tmpdir to pass isUnsafeRoot. */
const FIXTURE_BASE = path.join(import.meta.dir, '.tick-fixtures');
const fixtures: string[] = [];

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

function runTick(payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): string {
    const env: Record<string, string | undefined> = {
        ...process.env, HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), ...extraEnv
    };
    // The developer's own auto-compact window override must not steer ctx% here.
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const res = spawnSync('bun', ['run', '--silent', TICK], {
        input: JSON.stringify({ cwd: path.join(HOME, 'proj'), ...payload }),
        env,
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
    // denominator = the 200k auto-compact point; critical at 90% = 180k.
    test('fires at critical, stays quiet while armed, re-fires after dipping below warn', () => {
        const sid = newSid();
        const transcript = writeTranscript(190_000); // ~95% — critical

        const first = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
        expect(first).toContain('Context window at critical');
        expect(first).toContain('do not ask');

        const second = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
        expect(second).not.toContain('Context window at critical');

        // Compaction happened: ctx drops below warn → disarm.
        writeTranscript(50_000); // ~25%
        runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });

        // Climb again → re-fire.
        writeTranscript(190_000);
        const fourth = runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
        expect(fourth).toContain('Context window at critical');
    });

    // With auto-compaction off the session stops at the limit instead of
    // compacting, so "pacekeeper re-injects this checkpoint" would be false.
    test('with DISABLE_AUTO_COMPACT set, the directive says to start a fresh session', () => {
        const sid = newSid();
        const transcript = writeTranscript(190_000);
        const out = runTick(
            { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript },
            { DISABLE_AUTO_COMPACT: '1' }
        );
        expect(out).toContain('Context window at critical');
        expect(out).toContain('start a fresh session from that checkpoint');
        expect(out).not.toContain('re-injects this checkpoint');
        // There is no compaction to wait for, so it must not say to wait for one.
        expect(out).not.toContain('until compaction runs');
    });

    test('combined 5h+ctx: single auto-loop directive covers both, ctx directive suppressed', () => {
        writeUsage(86, 10 * 60_000);
        const sid = newSid();
        const transcript = writeTranscript(190_000);
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

describe('stop_hook_active continuation guard', () => {
    // A Stop directive goes out as additionalContext, which re-opens the turn
    // under Claude Code's continuation cap. Once we're inside that continuation
    // (stop_hook_active), re-injecting the same directive is the loop that ends
    // in the harness's "hook blocked the turn from ending N times" override.
    test('a Stop that WOULD fire a directive stays silent when stop_hook_active', () => {
        writeUsage(86, 2 * 3600_000); // 5h at warn+ → auto-renewal directive on Stop
        const sid = newSid();
        // Normal Stop (not a continuation): the directive fires.
        const first = runTick({ session_id: sid, hook_event_name: 'Stop' });
        expect(first).toContain('auto-renewal');
        // A fresh session in the same state, but flagged as a continuation:
        // silent, so the loop is bounded at one turn instead of the cap.
        const cont = runTick({ session_id: newSid(), hook_event_name: 'Stop', stop_hook_active: true });
        expect(cont).toBe('{}');
    });

    test('SubagentStop is silenced under stop_hook_active too', () => {
        const out = runTick({
            session_id: newSid(), hook_event_name: 'SubagentStop',
            agent_id: 'ag-cont', stop_hook_active: true
        });
        expect(out).toBe('{}');
    });

    // Defense in depth for the loop: even WITHOUT the stop_hook_active flag, a
    // once-per-block Stop directive must fire at most once across repeated plain
    // Stops in the same block — its idempotency arming and its emission share a
    // tick, so the second Stop already self-suppresses. Locks that in so a future
    // change can't silently reintroduce the churn on harnesses that omit the flag.
    test('a once-per-block Stop directive does not re-fire on the next plain Stop', () => {
        writeUsage(86, 2 * 3600_000); // 5h at warn+ → auto-renewal directive on Stop
        const sid = newSid();
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).toContain('auto-renewal');
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).toBe('{}');
        expect(runTick({ session_id: sid, hook_event_name: 'Stop' })).toBe('{}');
    });
});

describe('SessionStart(compact) re-orientation', () => {
    /** Transcript: a huge pre-compaction usage, then the boundary Claude Code writes. */
    function writeCompactedTranscript(): string {
        const p = path.join(HOME, 't.jsonl');
        fs.writeFileSync(p, [
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 32, cache_read_input_tokens: 830_000 } } }),
            JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 830_032, postTokens: 21_531 } })
        ].join('\n') + '\n');
        return p;
    }

    test('injects this session\'s checkpoint body and reports the post-compaction ctx', () => {
        const sid = newSid();
        writeUsage(40);
        const transcript = writeCompactedTranscript();
        // A prior tick establishes sessionStartedAt.
        runTick({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi', transcript_path: transcript });
        saveCheckpoint({
            cwd: path.join(HOME, 'proj'), checkpointDirName: '.claude-checkpoints',
            frontmatter: { name: 'lane' }, body: '## Goal\nFinish the migration\n\n## Next\n1. Run bun test\n'
        });
        const out = runTick({ session_id: sid, hook_event_name: 'SessionStart', source: 'compact', transcript_path: transcript });
        const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
        expect(ctx).toContain('Context was just compacted');
        expect(ctx).toContain('Finish the migration');
        expect(ctx).toContain('1. Run bun test');
        // The 830k pre-compaction reading must not leak into this tick.
        expect(ctx).not.toContain('Context window at critical');
        expect(ctx).not.toMatch(/ctx (8|9)\d%/);
    });

    /** HOME/proj as a git repo with a linked worktree at HOME/proj/.worktrees/wt. */
    function projectWithWorktree(): { proj: string; wt: string } {
        // NOT under HOME: everything below the tmpdir is an unsafe root, which
        // lookupRoot refuses (it is where the CLI would refuse to save).
        fs.mkdirSync(FIXTURE_BASE, { recursive: true });
        const proj = fs.mkdtempSync(path.join(FIXTURE_BASE, 'proj-'));
        fixtures.push(proj);
        // Sandboxed HOME and no global config: a contributor's gpgsign or
        // core.hooksPath must not decide whether this test can run.
        const env = { ...process.env, HOME, GIT_CONFIG_GLOBAL: '/dev/null' };
        execFileSync('git', ['init', '-q', proj], { env });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: proj, env });
        const wt = path.join(proj, '.worktrees', 'wt');
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', wt], { cwd: proj, env });
        return { proj, wt };
    }

    // The CLI anchors saves at the main repo root, so a session running inside
    // a linked worktree must look there too.
    test('a session in a linked worktree finds the checkpoint saved at the main root', () => {
        const { proj, wt } = projectWithWorktree();
        const sid = newSid();
        writeUsage(40);
        const transcript = writeCompactedTranscript();
        runTick({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi', transcript_path: transcript, cwd: wt });
        saveCheckpoint({
            cwd: proj, checkpointDirName: '.claude-checkpoints',
            frontmatter: { name: 'lane' }, body: '## Goal\nFinish the migration\n\n## Next\n1. Run bun test\n'
        });
        const out = runTick({ session_id: sid, hook_event_name: 'SessionStart', source: 'compact', transcript_path: transcript, cwd: wt });
        const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
        expect(ctx).toContain('Finish the migration');
        expect(ctx).not.toContain('no checkpoint was saved this session');
    });

    test('the startup banner in a worktree points at the main root checkpoint', () => {
        const { proj, wt } = projectWithWorktree();
        writeUsage(40);
        saveCheckpoint({
            cwd: proj, checkpointDirName: '.claude-checkpoints',
            frontmatter: { name: 'lane' }, body: '## Goal\nFinish the migration\n'
        });
        const out = runTick({ session_id: newSid(), hook_event_name: 'SessionStart', source: 'startup', cwd: wt });
        const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
        expect(ctx).toContain('Active checkpoint found');
    });

    // Claude Code fires SessionStart(compact) ~200 ms before it flushes the
    // boundary line, so the transcript still describes the discarded
    // conversation: report nothing rather than its size.
    test('a compact start before the boundary is flushed reports no context and disarms the auto-save', () => {
        const sid = newSid();
        writeUsage(40);
        const transcript = writeTranscript(190_000); // pre-compaction size, no boundary yet
        // Arm ctxAutoSaveArmed the way a real critical climb would.
        expect(runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript }))
            .toContain('Context window at critical');
        expect(sessionState()[sid]?.ctxAutoSaveArmed).toBe(true);

        const out = runTick({ session_id: sid, hook_event_name: 'SessionStart', source: 'compact', transcript_path: transcript });
        const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
        expect(ctx).toContain('Context was just compacted');
        expect(ctx).not.toContain('Context window at critical');
        expect(ctx).not.toContain('ctx 9');
        expect(sessionState()[sid]?.ctxAutoSaveArmed).toBe(false);
    });

    // The auto-loop fires on the very tick that disarms, and must not re-arm:
    // the 5h climb happens between the two ticks, in the same block, so the
    // once-per-block directive is still pending when the compaction lands.
    test('the auto-loop firing on a compact start does not re-arm the ctx auto-save', () => {
        const sid = newSid();
        const resetAt = writeUsage(40); // below auto.five_hour_pct: no auto directive yet
        const transcript = writeTranscript(190_000);
        expect(runTick({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript }))
            .toContain('Context window at critical');
        expect(sessionState()[sid]?.ctxAutoSaveArmed).toBe(true);
        expect(sessionState()[sid]?.lastAutoFireResetAt).toBeUndefined();

        // Same block (identical sessionResetAt), now above auto.five_hour_pct.
        fs.writeFileSync(
            path.join(HOME, '.cache', 'cc-pacekeeper', 'usage.json'),
            JSON.stringify({ sessionUsage: 90, sessionResetAt: resetAt, weeklyUsage: 40, fetchedAt: Date.now() })
        );
        const out = runTick({ session_id: sid, hook_event_name: 'SessionStart', source: 'compact', transcript_path: transcript });
        expect(out).toContain('5h 90%');
        // SessionStart does not surface the auto directive's text, but the
        // once-per-block stamp is written by that block and nothing else, so
        // it proves the guarded branch ran on this tick.
        expect(sessionState()[sid]?.lastAutoFireResetAt).toBeTruthy();
        expect(sessionState()[sid]?.ctxAutoSaveArmed).toBe(false);
    });

    test('a compact start does not ask the one-time channel onboarding question', () => {
        fs.mkdirSync(path.join(HOME, '.config', 'cc-pacekeeper'), { recursive: true });
        fs.writeFileSync(
            path.join(HOME, '.config', 'cc-pacekeeper', 'config.json'),
            JSON.stringify({ channels: { preferred: [], target: '', asked: false } })
        );
        const sid = newSid();
        writeUsage(40);
        const transcript = writeCompactedTranscript();
        runTick({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi', transcript_path: transcript });
        const compact = runTick({ session_id: sid, hook_event_name: 'SessionStart', source: 'compact', transcript_path: transcript });
        expect(compact).not.toContain('No away-channel is configured');
        // The same state on a real startup still asks — this is a compact-only gate.
        const startup = runTick({ session_id: newSid(), hook_event_name: 'SessionStart', source: 'startup' });
        expect(startup).toContain('No away-channel is configured');
    });

    test('a normal startup still gets the pointer banner, not the body', () => {
        const sid = newSid();
        writeUsage(40);
        saveCheckpoint({
            cwd: path.join(HOME, 'proj'), checkpointDirName: '.claude-checkpoints',
            frontmatter: { name: 'lane' }, body: '## Goal\nFinish the migration\n\n## Next\n1. Run bun test\n'
        });
        const out = runTick({ session_id: sid, hook_event_name: 'SessionStart', source: 'startup' });
        const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
        expect(ctx).toContain('Active checkpoint found');
        expect(ctx).toContain('checkpoint resume');
        expect(ctx).not.toContain('1. Run bun test');
    });
});
