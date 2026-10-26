import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeHandoff } from '../agent-budget';
import { CodexCheckpoints } from '../checkpoint';
import { CODEX_DEFAULTS, type CodexConfig } from '../config';
import { KEEPALIVE_PING } from '../jobs';
import type { RolloutReading } from '../rollout';
import { CodexStore } from '../storage';
import { runTick, type TickInput } from '../tick';

// Checkpoint roots must be "safe" (not under tmpdir), so project fixtures live
// beside the tests and are removed afterwards; state stores stay in tmpdir.
const FIXTURES = join(import.meta.dir, '.tick-fixtures');
mkdirSync(FIXTURES, { recursive: true });
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));

// Checkpoint saves stamp the real clock, so the hook clock must be real too.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const MAIN = '019a0000-0000-7000-8000-00000000main';
const CHILD = '019a0000-0000-7000-8000-0000000child';
const RESET = NOW + 2 * 3_600_000;
const config: CodexConfig = { ...CODEX_DEFAULTS, keepalive: { ...CODEX_DEFAULTS.keepalive, enabled: false } };

function rollout(options: { five?: number; ctx?: number; meta?: { threadId: string; parentThreadId?: string } } = {}): RolloutReading {
  return {
    meta: options.meta ? { threadId: options.meta.threadId, sessionId: MAIN, parentThreadId: options.meta.parentThreadId ?? null, creatorAccountId: 'acct-1' } : { threadId: MAIN, sessionId: MAIN, parentThreadId: null, creatorAccountId: 'acct-1' },
    tokenUsage: options.ctx === undefined ? null : { last: { totalTokens: options.ctx }, modelContextWindow: 100 },
    tokenUsageObservedAtMs: options.ctx === undefined ? null : NOW - 1_000,
    rateLimits: options.five === undefined ? null : {
      rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: options.five, windowDurationMins: 300, resetsAt: RESET / 1000 }, secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: (NOW + 5 * 86_400_000) / 1000 } }
    },
    rateLimitsObservedAtMs: options.five === undefined ? null : NOW - 1_000,
    compactedSinceUsage: false
  };
}

interface Harness {
  store: CodexStore;
  project: string;
  tick: (input: TickInput, reading?: RolloutReading, nowMs?: number) => { output: string; json: Record<string, unknown> };
}

function harness(name: string): Harness {
  const store = new CodexStore(mkdtempSync(join(tmpdir(), `codex-tick-${name}-`)));
  const project = mkdtempSync(join(FIXTURES, `${name}-`));
  return {
    store,
    project,
    tick: (input, reading = rollout(), nowMs = NOW) => {
      const result = runTick({ cwd: project, session_id: MAIN, ...input }, { config, store, nowMs, rollout: reading, projectRoot: () => project });
      return { output: result.output, json: JSON.parse(result.output) as Record<string, unknown> };
    }
  };
}

function context(json: Record<string, unknown>): string {
  return ((json['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] as string | undefined) ?? '';
}

describe('status injection', () => {
  test('every prompt gets the time, session and meter line, read from the rollout', () => {
    const h = harness('status');
    h.tick({ hook_event_name: 'SessionStart', source: 'startup' }, rollout({ five: 20, ctx: 30 }), NOW - 600_000);
    h.tick({ hook_event_name: 'PreToolUse' }, rollout({ five: 20, ctx: 30 }), NOW - 60_000);
    const { json } = h.tick({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }, rollout({ five: 20, ctx: 30 }));
    expect(context(json)).toMatch(/^\[pacekeeper\] \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} .* · session 10m · ctx 30% · 5h 20% \(2h00m\) · week 10%/);
  });

  test('a return after the idle threshold gets the away line once', () => {
    const h = harness('afk');
    h.tick({ hook_event_name: 'UserPromptSubmit', prompt: 'a' }, rollout(), NOW - 3_600_000);
    expect(context(h.tick({ hook_event_name: 'UserPromptSubmit', prompt: 'b' }).json)).toStartWith('⏱ You were away 1h00m — welcome back.');
    expect(context(h.tick({ hook_event_name: 'UserPromptSubmit', prompt: 'c' }, rollout(), NOW + 1_000).json)).toStartWith('[pacekeeper]');
  });

  test('a quoted keepalive marker is ordinary input', () => {
    const h = harness('quoted');
    h.tick({ hook_event_name: 'SessionStart', source: 'startup' });
    const { json } = h.tick({ hook_event_name: 'UserPromptSubmit', prompt: `see this log: ${KEEPALIVE_PING}` });
    expect(context(json)).toStartWith('[pacekeeper] ');
  });
});

describe('Stop (review #2)', () => {
  test('a notify-level meter never re-opens the turn', () => {
    const h = harness('stop-notify');
    h.tick({ hook_event_name: 'SessionStart', source: 'startup' }, rollout({ five: 72 }));
    for (const offset of [0, 120_000, 240_000]) {
      expect(h.tick({ hook_event_name: 'Stop', stop_hook_active: false }, rollout({ five: 72 }), NOW + offset).output).toBe('{}');
    }
  });

  test('a warn-level meter re-opens the turn once per level, and again on critical', () => {
    const h = harness('stop-warn');
    const noAuto: CodexConfig = { ...config, auto: { ...config.auto, enabled: false } };
    const stop = (five: number, at: number) => runTick({ cwd: h.project, session_id: MAIN, hook_event_name: 'Stop' }, { config: noAuto, store: h.store, nowMs: at, rollout: rollout({ five }), projectRoot: () => h.project });
    const first = JSON.parse(stop(86, NOW).output) as Record<string, unknown>;
    expect(first['decision']).toBe('block');
    expect(first['reason'] as string).toContain('End-of-turn reminder');
    for (const offset of [120_000, 240_000]) expect(stop(86, NOW + offset).output).toBe('{}');
    // Critical is a new level: one more reminder, then silence again.
    expect((JSON.parse(stop(96, NOW + 300_000).output) as Record<string, unknown>)['decision']).toBe('block');
    expect(stop(96, NOW + 500_000).output).toBe('{}');
  });

  test('stop_hook_active is always silent', () => {
    const h = harness('stop-active');
    expect(h.tick({ hook_event_name: 'Stop', stop_hook_active: true }, rollout({ five: 99, ctx: 99 })).output).toBe('{}');
  });
});

describe('auto-renewal and context auto-save', () => {
  test('5h at the auto threshold fires the renewal directive once per block, with the thread id', () => {
    const h = harness('auto');
    const first = context(h.tick({ hook_event_name: 'PreToolUse', tool_name: 'shell' }, rollout({ five: 86 })).json);
    expect(first).toContain('5-hour block auto-renewal');
    expect(first).toContain(`save --thread-id ${MAIN}`);
    expect(context(h.tick({ hook_event_name: 'PreToolUse', tool_name: 'shell' }, rollout({ five: 87 }), NOW + 120_000).json)).not.toContain('auto-renewal');
  });

  test('context critical asks for a save once per climb and re-arms after compaction', () => {
    const h = harness('ctx');
    expect(context(h.tick({ hook_event_name: 'PreToolUse' }, rollout({ ctx: 95 })).json)).toContain('Context window at critical');
    expect(context(h.tick({ hook_event_name: 'PreToolUse' }, rollout({ ctx: 96 }), NOW + 400_000).json)).not.toContain('Context window at critical');
    h.tick({ hook_event_name: 'PostCompact' }, rollout({ ctx: 20 }), NOW + 500_000);
    expect(context(h.tick({ hook_event_name: 'PreToolUse' }, rollout({ ctx: 95 }), NOW + 900_000).json)).toContain('Context window at critical');
  });

  test('a stop at context critical re-opens the turn with the save directive', () => {
    const h = harness('ctx-stop');
    const { json } = h.tick({ hook_event_name: 'Stop' }, rollout({ ctx: 95 }));
    expect(json['decision']).toBe('block');
    expect(json['reason'] as string).toContain('save now, do not ask');
  });
});

describe('checkpoint orientation', () => {
  test('SessionStart lists an active checkpoint; a compact start re-injects its body', () => {
    const h = harness('orient');
    new CodexCheckpoints(h.project, config).save({ lane: 'main', owner: { accountId: null, threadId: MAIN }, body: '## Goal\nship it\n\n## Next\nwrite tests' });
    const startup = context(h.tick({ hook_event_name: 'SessionStart', source: 'startup' }, rollout(), NOW - 60_000).json);
    expect(startup).toContain('Active checkpoint found (lane main');
    expect(startup).toContain('Goal: ship it');
    const compact = context(h.tick({ hook_event_name: 'SessionStart', source: 'compact' }, rollout({ ctx: 90 })).json);
    expect(compact).toContain('Context was just compacted');
    expect(compact).toContain('write tests');
  });

  test('a resume-marker prompt gets the wake orientation', () => {
    const h = harness('resume');
    new CodexCheckpoints(h.project, config).save({ lane: 'main', owner: { accountId: null, threadId: MAIN }, body: 'x' });
    expect(context(h.tick({ hook_event_name: 'UserPromptSubmit', prompt: '[pacekeeper-resume] abc' }).json)).toContain('Auto-wake fired. Run');
  });
});

describe('keepalive ping transparency', () => {
  test('a ping right after activity is suppressed; an idle ping gets pong guidance and leaves the idle clock alone', () => {
    const h = harness('ping');
    h.tick({ hook_event_name: 'UserPromptSubmit', prompt: 'work' }, rollout(), NOW - 60_000);
    const early = h.tick({ hook_event_name: 'UserPromptSubmit', prompt: KEEPALIVE_PING, turn_id: 't1' });
    expect(early.json['decision']).toBe('block');
    const idleAt = NOW + 40 * 60_000;
    const ping = h.tick({ hook_event_name: 'UserPromptSubmit', prompt: KEEPALIVE_PING, turn_id: 't2' }, rollout(), idleAt);
    expect(context(ping.json)).toContain('Reply with exactly the single word pong');
    expect(context(ping.json)).toContain('Do not call any tools');
    // The ping's own Stop is silent and transparent.
    expect(h.tick({ hook_event_name: 'Stop', turn_id: 't2' }, rollout({ five: 90 }), idleAt + 5_000).output).toBe('{}');
    const timeline = h.store.read({ accountId: null, threadId: MAIN }, 'timeline') as Record<string, unknown>;
    expect(timeline['lastEventAtMs']).toBe(NOW - 60_000);
  });
});

describe('subagents (review #3)', () => {
  test('agent_id is the child thread; its contract names the parent from the child rollout', () => {
    const h = harness('child');
    const start = context(h.tick({ hook_event_name: 'SubagentStart', agent_id: CHILD, agent_type: 'worker' }, rollout({ five: 40, meta: { threadId: CHILD, parentThreadId: MAIN } })).json);
    expect(start).toContain(`handoffs write ${CHILD} --agent-type worker --parent-thread-id ${MAIN}`);
    const child = h.store.read({ accountId: null, threadId: CHILD, agentId: CHILD }, 'timeline') as Record<string, unknown>;
    expect(child['parentThreadId']).toBe(MAIN);
    expect(child['spawnFiveHourPercent']).toBe(40);
    // The child's tool hook reaches its own state and pauses at its point.
    const pause = context(h.tick({ hook_event_name: 'PreToolUse', agent_id: CHILD }, rollout({ five: 76, meta: { threadId: CHILD } })).json);
    expect(pause).toContain('Subagent pause point 75% reached');
    expect(pause).toContain(`--parent-thread-id ${MAIN}`);
  });

  test("a child's handoff is surfaced to its parent exactly once, and its burn reaches the parent line", () => {
    const h = harness('handoff');
    h.tick({ hook_event_name: 'SubagentStart', agent_id: CHILD }, rollout({ five: 40, meta: { threadId: CHILD, parentThreadId: MAIN } }));
    writeHandoff({ cwd: h.project, checkpointDirName: config.checkpoint_dir_name, checkpointSubdir: config.checkpoint_subdir, agentId: CHILD, trigger: 'budget_pause', body: 'Next: finish part 2', provenance: { childThreadId: CHILD, parentThreadId: MAIN } });
    h.tick({ hook_event_name: 'SubagentStop', agent_id: CHILD }, rollout({ five: 55, meta: { threadId: CHILD } }));
    const first = context(h.tick({ hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, rollout({ five: 55 })).json);
    expect(first).toContain(`Subagent ${CHILD} paused on budget`);
    expect(first).toContain('Next: finish part 2');
    expect(first).toContain('agents ~15%');
    expect(context(h.tick({ hook_event_name: 'UserPromptSubmit', prompt: 'again' }, rollout({ five: 55 }), NOW + 1_000).json)).not.toContain('paused on budget');
  });
});

describe('concurrent hooks (review #7)', () => {
  test('locked updates keep fields written by interleaved writers', () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-tick-lock-')));
    const identity = { accountId: null, threadId: MAIN };
    store.update(identity, 'timeline', (prior) => ({ ...prior, a: 1 }));
    store.update(identity, 'timeline', (prior) => ({ ...prior, b: 2 }));
    expect(store.read(identity, 'timeline')).toEqual({ a: 1, b: 2 });
  });
});

describe('real rollout file', () => {
  test('the hook reads context and the default quota bucket from transcript_path', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const dir = join(home, 'sessions', '2027', '01', '15');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2027-01-15T00-00-00-${MAIN}.jsonl`);
    writeFileSync(file, [
      JSON.stringify({ timestamp: new Date(NOW - 5_000).toISOString(), type: 'session_meta', payload: { id: MAIN, session_id: MAIN, creator_account_id: 'acct-9' } }),
      JSON.stringify({ timestamp: new Date(NOW - 1_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 5_000 }, model_context_window: 10_000 }, rate_limits: { limit_id: 'codex', primary: { used_percent: 33.4, window_minutes: 300, resets_at: RESET / 1000 }, secondary: { used_percent: 12, window_minutes: 10_080, resets_at: (NOW + 86_400_000) / 1000 } } } })
    ].join('\n') + '\n');
    const previous = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = home;
    try {
      const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-tick-real-')));
      const result = runTick({ hook_event_name: 'UserPromptSubmit', session_id: MAIN, transcript_path: file, prompt: 'x' }, { config, store, nowMs: NOW, projectRoot: () => null });
      expect(result.facts.context?.usedPercent).toBe(50);
      expect(result.facts.fiveHour?.usedPercent).toBe(33);
      expect(result.facts.weekly?.usedPercent).toBe(12);
    } finally {
      if (previous === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = previous;
    }
  });
});

describe('directives are never spent where they cannot be delivered', () => {
  test('a SessionStart at the auto threshold leaves the renewal directive for the first prompt', () => {
    const h = harness('session-start-auto');
    const start = context(h.tick({ hook_event_name: 'SessionStart', source: 'startup' }, rollout({ five: 86, ctx: 95 })).json);
    expect(start).not.toContain('auto-renewal');
    const prompt = context(h.tick({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, rollout({ five: 86, ctx: 95 }), NOW + 1_000).json);
    expect(prompt).toContain('5-hour block auto-renewal');
    expect(prompt).toContain('context also critical');
  });
});
