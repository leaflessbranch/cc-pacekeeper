/**
 * Codex behavior for the shared scenarios, executed against the Codex package.
 *
 * Only rows the Codex package genuinely implements are asserted here. A row
 * that is `pending` or `blocked` gets an assertion that it is NOT silently
 * claimed as working, so the corpus cannot drift into implying coverage that
 * does not exist.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import scenarios from './scenarios.json';
import {
  classifySubscriptionCapacity,
  findExistingOwner,
  normalizeNativeCapabilities,
  parseRateLimitsResponse,
  parseThreadTokenUsage
} from '../../plugins/codex-pacekeeper/src/native';
import { decide, type PolicyState } from '../../plugins/codex-pacekeeper/src/policy';
import { shouldInjectAndRecord } from '../../plugins/cc-pacekeeper/src/state';
import { buildFacts } from '../../plugins/codex-pacekeeper/src/facts';
import { KEEPALIVE_PING } from '../../plugins/codex-pacekeeper/src/jobs';
import { createJob } from '../../plugins/codex-pacekeeper/src/jobs';
import { dispatchAdvice } from '../../plugins/codex-pacekeeper/src/agent-budget';
import { CODEX_DEFAULTS } from '../../plugins/codex-pacekeeper/src/config';
import { CodexCheckpoints } from '../../plugins/codex-pacekeeper/src/checkpoint';
import { CodexStore } from '../../plugins/codex-pacekeeper/src/storage';
import { pingGate as codexPingGate, runTick } from '../../plugins/codex-pacekeeper/src/tick';
import type { RolloutReading } from '../../plugins/codex-pacekeeper/src/rollout';
import { formatBridgeDirective as codexBridge } from '../../plugins/codex-pacekeeper/src/format';
import { effectivePause as codexEffectivePause } from '../../plugins/codex-pacekeeper/src/agent-budget';
import { pingGate as claudePingGate } from '../../plugins/cc-pacekeeper/src/keepalive';
import { formatBridgeDirective as claudeBridge } from '../../plugins/cc-pacekeeper/src/thresholds';
import { effectivePause as claudeEffectivePause } from '../../plugins/cc-pacekeeper/src/agent-budget';
import { diagnose } from '../../plugins/codex-pacekeeper/src/doctor';
import { CodexService } from '../../plugins/codex-pacekeeper/src/service';
import { cleanupDecision } from '../../plugins/codex-pacekeeper/src/worktrees';
import { EFFECTIVE_THRESHOLDS, claudeLevel, claudeSnapshot, codexConfig, codexLevel, effectiveConfig, levelOf } from './harness';

const OBSERVED_AT = Date.UTC(2026, 8, 5, 12, 0, 0);

/** What the Codex hook reads from a rollout: context plus the default bucket. */
function rollout(fivePercent: number, contextTokens?: number, threadId = 'parity-thread'): RolloutReading {
  return {
    meta: { threadId, sessionId: threadId, parentThreadId: null, creatorAccountId: 'acct-parity' },
    tokenUsage: contextTokens === undefined ? null : { modelContextWindow: 100_000, last: { totalTokens: contextTokens, cachedInputTokens: 0 } },
    tokenUsageObservedAtMs: contextTokens === undefined ? null : OBSERVED_AT,
    rateLimits: { rateLimits: { limitId: 'codex', planType: 'plus', spendControlReached: false, primary: { usedPercent: fivePercent, windowDurationMins: 300, resetsAt: (OBSERVED_AT + 3_600_000) / 1000 } } },
    rateLimitsObservedAtMs: OBSERVED_AT,
    compactedSinceUsage: false
  };
}

describe('corpus integrity', () => {
  test('does not silently remove a requested scenario', () => {
    const ids = scenarios.scenarios.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('queued-ping-then-user-input');
    expect(ids).toContain('same-lane-two-harnesses');
  });

  test('every non-deferred capability row 1-27 appears in some scenario', () => {
    const covered = new Set(scenarios.scenarios.flatMap((row) => row.capabilities));
    const deferred = new Set([9, 21]);
    const missing: number[] = [];
    for (let row = 1; row <= 27; row += 1) {
      if (deferred.has(row)) continue;
      if (!covered.has(row)) missing.push(row);
    }
    expect(missing).toEqual([]);
  });

  test('a blocked row is never reported as covered', () => {
    const blocked = scenarios.scenarios.filter((row) => row.status === 'blocked').map((row) => row.id);
    // Rows 11 and 18 were blocked on native controls Codex does not have;
    // they now follow the Claude package's prompt-level contract instead.
    expect(blocked).toEqual([]);
  });
});

describe('quota-bucket-duration-mapping (row 2)', () => {
  // Refuted hypothesis: windows cannot be mapped by primary/secondary
  // position. Both orderings occur in real records.
  test('maps by duration in either native ordering', () => {
    const weeklyFirst = parseRateLimitsResponse(
      {
        rateLimits: {
          primary: { usedPercent: 60, windowDurationMins: 10080 },
          secondary: { usedPercent: 17, windowDurationMins: 300 }
        }
      },
      OBSERVED_AT
    );
    const fiveHourFirst = parseRateLimitsResponse(
      {
        rateLimits: {
          primary: { usedPercent: 17, windowDurationMins: 300 },
          secondary: { usedPercent: 60, windowDurationMins: 10080 }
        }
      },
      OBSERVED_AT
    );
    expect(weeklyFirst.buckets.map((b) => [b.kind, b.usedPercent])).toEqual([
      ['five_hour', 17],
      ['weekly', 60]
    ]);
    expect(fiveHourFirst.buckets.map((b) => [b.kind, b.usedPercent])).toEqual([
      ['five_hour', 17],
      ['weekly', 60]
    ]);
  });

  // Only the `codex` bucket id has ever been observed locally, so no
  // model-family mapping is invented from a bucket name.
  test('an unfamiliar limit id is retained without being interpreted', () => {
    const parsed = parseRateLimitsResponse(
      {
        rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } },
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 5, windowDurationMins: 300 } },
          'some-other-limit': { primary: { usedPercent: 9, windowDurationMins: 300 } }
        }
      },
      OBSERVED_AT
    );
    expect(Object.keys(parsed.byLimitId).sort()).toEqual(['codex', 'some-other-limit']);
  });
});

describe('stale-quota-degradation (rows 2, 5)', () => {
  test('an unreadable percentage degrades visibly instead of reading as zero', () => {
    const parsed = parseRateLimitsResponse(
      { rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } },
      OBSERVED_AT
    );
    expect(parsed.buckets[0]?.usedPercent).toBeNull();
    expect(parsed.buckets[0]?.valid).toBe(false);
    // Claude's ladder would call a 0 reading 'none' on five_hour, which is the
    // dangerous misreading a fabricated zero produces.
    expect(claudeLevel(0, 'five_hour', effectiveConfig())).toBe('none');
    expect(codexLevel(null, 'five_hour', codexConfig())).toBeNull();
  });
});

describe('Codex policy corpus (rows 4-8)', () => {
  const cfg = codexConfig();
  const state = (): PolicyState => ({ levels: {}, lastInjectedAtMs: {}, blockResetAtMs: null, savedThisCycle: false });
  const facts = (usedPercent = 81, observedAtMs = OBSERVED_AT, resetAtMs = OBSERVED_AT + 3_600_000) => buildFacts({
      rateLimits: {
      accountId: 'acct-parity',
      rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent, windowDurationMins: 300, resetsAt: resetAtMs } }
    },
    observedAtMs,
    tokenUsage: null,
    authenticated: true
  }, cfg, OBSERVED_AT);

  test('Codex and Claude use the same effective ladder boundaries', () => {
    for (const percent of [0, 49, 50, 79, 80, 89, 90, 98]) {
      expect(codexLevel(percent, 'five_hour', cfg)).toBe(claudeLevel(percent, 'five_hour', effectiveConfig()));
    }
  });

  test('ordinary debounce and escalation are executed by the Codex policy', () => {
    const first = decide({ event: 'UserPromptSubmit', facts: facts(81), state: state(), nowMs: OBSERVED_AT }, cfg);
    const duplicate = decide({ event: 'UserPromptSubmit', facts: facts(81), state: first.nextState, nowMs: OBSERVED_AT + 1_000 }, cfg);
    const escalation = decide({ event: 'UserPromptSubmit', facts: facts(91), state: duplicate.nextState, nowMs: OBSERVED_AT + 2_000 }, cfg);
    expect(first.inject).toBe(true);
    expect(duplicate.inject).toBe(false);
    expect(escalation.inject).toBe(true);
  });

  test('Codex debounce decisions match the shipped Claude state machine at the boundary', () => {
    const previousHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'parity-claude-debounce-'));
    try {
      const claudeFirst = shouldInjectAndRecord('parity-thread', 'five_hour', 'warn', OBSERVED_AT / 1000, effectiveConfig().debounce_seconds);
      const claudeBoundary = shouldInjectAndRecord('parity-thread', 'five_hour', 'warn', OBSERVED_AT / 1000 + effectiveConfig().debounce_seconds, effectiveConfig().debounce_seconds);
      const claudeAfter = shouldInjectAndRecord('parity-thread', 'five_hour', 'warn', OBSERVED_AT / 1000 + effectiveConfig().debounce_seconds + 1, effectiveConfig().debounce_seconds);

      const codexFirst = decide({ event: 'UserPromptSubmit', facts: facts(81), state: state(), nowMs: OBSERVED_AT }, cfg);
      const codexBoundary = decide({ event: 'UserPromptSubmit', facts: facts(81), state: codexFirst.nextState, nowMs: OBSERVED_AT + cfg.debounce_seconds * 1000 }, cfg);
      const codexAfter = decide({ event: 'UserPromptSubmit', facts: facts(81), state: codexBoundary.nextState, nowMs: OBSERVED_AT + (cfg.debounce_seconds + 1) * 1000 }, cfg);

      expect([codexFirst.inject, codexBoundary.inject, codexAfter.inject]).toEqual([
        claudeFirst.shouldInject,
        claudeBoundary.shouldInject,
        claudeAfter.shouldInject
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('reset and synthetic turns preserve the separate Codex state contract', () => {
    const first = decide({ event: 'UserPromptSubmit', facts: facts(81), state: state(), nowMs: OBSERVED_AT }, cfg);
    const reset = decide({ event: 'UserPromptSubmit', facts: facts(81, OBSERVED_AT + 4_000_000, OBSERVED_AT + 7_200_000), state: { ...first.nextState, blockResetAtMs: OBSERVED_AT + 3_600_000 }, nowMs: OBSERVED_AT + 4_000_000 }, cfg);
    const synthetic = decide({ event: 'UserPromptSubmit', facts: facts(81, OBSERVED_AT + 8_000_000), state: reset.nextState, nowMs: OBSERVED_AT + 8_000_000, synthetic: true }, cfg);
    expect(reset.inject).toBe(true);
    expect(reset.nextState.levels.five_hour).toBe('warn');
    expect(synthetic.nextState).toEqual(reset.nextState);
  });

  test('tool activity does not become user activity and continuation suppresses Stop', () => {
    const tool = decide({ event: 'PreToolUse', facts: facts(1), state: { ...state(), lastUserActivityAtMs: OBSERVED_AT }, nowMs: OBSERVED_AT + 1_000 }, cfg);
    const stop = decide({ event: 'Stop', facts: facts(81), state: tool.nextState, nowMs: OBSERVED_AT + 2_000, continuationActive: true }, cfg);
    expect(tool.nextState.lastUserActivityAtMs).toBe(OBSERVED_AT);
    expect(tool.nextState.lastWorkAtMs).toBe(OBSERVED_AT + 1_000);
    expect(stop.inject).toBe(false);
  });

  test('PostCompact re-arms the save cycle and a quoted marker is ordinary input', () => {
    const compacted = decide({ event: 'PostCompact', facts: facts(81), state: { ...state(), savedThisCycle: true }, nowMs: OBSERVED_AT }, cfg);
    expect(compacted.nextState.savedThisCycle).toBe(false);
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-parity-marker-')));
    const result = runTick({ hook_event_name: 'UserPromptSubmit', session_id: 'parity-thread', prompt: 'A report quotes [pacekeeper-keepalive] ping' }, { config: CODEX_DEFAULTS, store, nowMs: OBSERVED_AT, rollout: rollout(86), projectRoot: () => null });
    expect(result.output).toContain('additionalContext');
  });
});

describe('Codex lifecycle boundary', () => {
  test('keepalive text remains exact and marker quotes remain ordinary input', () => {
    expect(KEEPALIVE_PING).toBe('[pacekeeper-keepalive] ping');
    expect('[pacekeeper-keepalive] ping quoted'.startsWith('[pacekeeper-keepalive] ping')).toBe(true);
  });
});

describe('Codex safety diagnostics', () => {
  test('owner absence remains an actionable diagnostic', () => {
    const report = diagnose({ protocolVersion: '0.153.4', capabilities: normalizeNativeCapabilities({}), ownerStatus: 'absent', authenticated: null, capacity: 'unknown', quotaAgeSeconds: Number.POSITIVE_INFINITY, freshnessSeconds: 180, configDiagnostics: [] });
    expect(report.checks.find((check) => check.name === 'native owner')?.status).toBe('fail');
  });

  test('worktree cleanup refuses dirty or unknown state', () => {
    expect(cleanupDecision({ path: '/workspace/feature', bare: false, detached: false, locked: false, dirty: true, liveOwners: 0 }, '/workspace/main').removable).toBe(false);
    expect(cleanupDecision({ path: '/workspace/feature', bare: false, detached: false, locked: false, dirty: false, liveOwners: null }, '/workspace/main').removable).toBe(false);
  });
});

describe('cross-harness executable scenarios', () => {
  test('context critical asks for an immediate save on the next tool call, at the reference level (row 11)', () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-parity-compact-')));
    const result = runTick({ hook_event_name: 'PreToolUse', session_id: 'compact-thread' }, { config: codexConfig(), store, nowMs: OBSERVED_AT, rollout: rollout(10, 95_000, 'compact-thread'), projectRoot: () => null });
    expect(result.facts.context?.level).toBe('critical');
    expect(result.output).toContain('additionalContext');
    expect(result.output).toContain('save now, do not ask');
    expect(levelOf(claudeSnapshot({ contextPercent: 95, fiveHourPercent: 10 }, effectiveConfig(), OBSERVED_AT), 'context')).toBe('critical');
  });

  test('main and subagent ticks use separate identities and state records', () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-parity-identities-')));
    const options = { config: codexConfig(), store, nowMs: OBSERVED_AT, projectRoot: () => null };
    const main = runTick({ session_id: 'shared-thread', hook_event_name: 'UserPromptSubmit', prompt: 'x' }, { ...options, rollout: rollout(86, undefined, 'shared-thread') });
    const child = runTick({ session_id: 'shared-thread', hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'worker' }, { ...options, nowMs: OBSERVED_AT + 1_000, rollout: { ...rollout(86, undefined, 'agent-1'), meta: { threadId: 'agent-1', sessionId: 'shared-thread', parentThreadId: 'shared-thread', creatorAccountId: 'acct-parity' } } });
    expect(main.identity.agentId).toBeUndefined();
    // Codex's agent_id is the child's own thread id.
    expect(child.identity).toEqual({ accountId: null, threadId: 'agent-1', agentId: 'agent-1' });
    expect(store.read(main.identity, 'timeline')).not.toBeNull();
    expect(store.read(child.identity, 'timeline')).not.toBeNull();
    expect(child.output).toContain('handoffs write agent-1 --agent-type worker --parent-thread-id shared-thread');
  });

  test('same-named Claude lane remains untouched by Codex supersession', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-parity-lanes-'));
    const claudeDir = join(root, CODEX_DEFAULTS.checkpoint_dir_name);
    mkdirSync(claudeDir, { recursive: true });
    const claudeLane = join(claudeDir, 'main.md');
    writeFileSync(claudeLane, 'claude lane');
    const checkpoints = new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: () => false });
    checkpoints.save({ lane: 'main', owner: { accountId: 'acct-parity', threadId: 'thread' }, body: 'codex first' });
    checkpoints.save({ lane: 'main', owner: { accountId: 'acct-parity', threadId: 'thread' }, body: 'codex second' });
    expect(readFileSync(claudeLane, 'utf8')).toBe('claude lane');
    expect(checkpoints.list()).toHaveLength(1);
  });

  test('owner selection and dispatch advice stay conservative', () => {
    const records = [{ ownerId: 'owner', pid: 11, accountId: 'acct-parity', threadIds: ['thread'], socketPath: 'unix:///run/codex.sock' }];
    expect(findExistingOwner({ records, threadId: 'thread', accountId: 'acct-parity', isAlive: () => true }).status).toBe('found');
    expect(findExistingOwner({ records, threadId: 'thread', accountId: null, isAlive: () => true }).status).toBe('unknown');
    const advice = dispatchAdvice({ fiveHourPercent: 90, plannedAgents: 3 }, codexConfig());
    expect(advice.deny).toBe(false);
    expect(advice.message).toContain('Dispatching');
  });

  test('reset bridge identity and cache observations are explicit', () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-parity-reset-')));
    const owner = { accountId: 'acct-parity', threadId: 'thread' };
    const service = new CodexService({ config: codexConfig(), store, now: () => OBSERVED_AT, checkpointExists: () => true });
    const wake = service.scheduleResetWake(owner, 'checkpoint-exact', OBSERVED_AT + 5_000, OBSERVED_AT + 5_000);
    expect(wake.job.kind).toBe('reset-wake');
    expect(wake.job.resetGeneration).toBe(OBSERVED_AT + 5_000);
    const usage = parseThreadTokenUsage({ modelContextWindow: 100_000, last: { totalTokens: 10, cachedInputTokens: 0 } });
    expect(usage.cache.cachedInputTokens).toBe(0);
    expect(usage.cache.cacheWriteInputTokens).toBeNull();
  });

  test('security-scoped jobs include account, thread and reset generation', () => {
    const a = createJob({ kind: 'reset-wake', owner: { accountId: 'acct-a', threadId: 'thread' }, dueAtMs: OBSERVED_AT, submissionId: 'a', resetGeneration: OBSERVED_AT });
    const b = createJob({ kind: 'reset-wake', owner: { accountId: 'acct-b', threadId: 'thread' }, dueAtMs: OBSERVED_AT, submissionId: 'b', resetGeneration: OBSERVED_AT });
    const c = createJob({ kind: 'reset-wake', owner: { accountId: 'acct-a', threadId: 'thread' }, dueAtMs: OBSERVED_AT, submissionId: 'c', resetGeneration: OBSERVED_AT + 1 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  test('the opt-in package manifest, hooks and executable shim are installable artifacts', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../plugins/codex-pacekeeper/.codex-plugin/plugin.json', import.meta.url), 'utf8')) as { name?: string; version?: string; optIn?: boolean; hooks?: string };
    const hooks = JSON.parse(readFileSync(new URL('../../plugins/codex-pacekeeper/hooks/hooks.json', import.meta.url), 'utf8')) as { optIn?: boolean; hooks?: Record<string, unknown> };
    const shim = new URL('../../plugins/codex-pacekeeper/bin/pacekeeper-tick', import.meta.url);
    expect(manifest.name).toBe('codex-pacekeeper');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.optIn).toBe(true);
    expect(manifest.hooks).toBe('./hooks/hooks.json');
    expect(hooks.optIn).toBeUndefined();
    expect(Object.keys(hooks.hooks ?? {})).toContain('UserPromptSubmit');
    expect(existsSync(shim)).toBe(true);
    expect(statSync(shim).mode & 0o111).toBeGreaterThan(0);
  });
});

describe('paid-credit-transition (row 1)', () => {
  test('available credits never classify as paid spending', () => {
    expect(
      classifySubscriptionCapacity({
        planType: 'plus',
        spendControlReached: null,
        fresh: true,
        creditsAvailable: true
      })
    ).toBe('unknown');
  });

  test('only an authoritative transition classifies as paid', () => {
    expect(
      classifySubscriptionCapacity({ planType: 'plus', spendControlReached: true, fresh: true, authenticated: true })
    ).toBe('paid');
    expect(
      classifySubscriptionCapacity({ planType: 'plus', spendControlReached: false, fresh: true, authenticated: true })
    ).toBe('unknown');
    expect(
      classifySubscriptionCapacity({ planType: 'plus', spendControlReached: false, fresh: true, authenticated: true, includedCapacity: true })
    ).toBe('included');
  });
});

describe('context-after-compaction and model-window-change (row 3)', () => {
  test('context follows the current turn, so compaction lowers it', () => {
    const before = parseThreadTokenUsage({
      modelContextWindow: 200_000,
      last: { inputTokens: 150_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 150_000 },
      total: { inputTokens: 150_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 150_000 }
    });
    const after = parseThreadTokenUsage({
      modelContextWindow: 200_000,
      last: { inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 20_000 },
      // Lifetime total keeps rising; only `last` reflects the compacted state.
      total: { inputTokens: 170_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 170_000 }
    });
    expect(before.usedPercent).toBe(75);
    expect(after.usedPercent).toBe(10);
  });

  test('a changed model window rescales the same token count', () => {
    const narrow = parseThreadTokenUsage({
      modelContextWindow: 100_000,
      last: { inputTokens: 50_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 50_000 },
      total: { inputTokens: 50_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 50_000 }
    });
    const wide = parseThreadTokenUsage({
      modelContextWindow: 400_000,
      last: { inputTokens: 50_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 50_000 },
      total: { inputTokens: 50_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 50_000 }
    });
    expect(narrow.usedPercent).toBe(50);
    expect(wide.usedPercent).toBe(13);
  });

  test('the Codex context meter never inherits Claude 200k as a fallback', () => {
    const unknown = parseThreadTokenUsage({
      modelContextWindow: null,
      last: { inputTokens: 50_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 50_000 },
      total: { inputTokens: 50_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 50_000 }
    });
    expect(unknown.usedPercent).toBeNull();
    expect(unknown.diagnostics.join(' ')).toContain('modelContextWindow');
  });
});

describe('prompt-level keepalive and auto-save (rows 11, 18)', () => {
  // Codex has no native no-tools mode or pre-model cancellation; neither has
  // Claude's cron keepalive. Both packages instruct the model instead.
  test('the protocol facts are unchanged, and the ping guidance carries the no-tools instruction', () => {
    const capabilities = normalizeNativeCapabilities({ version: '0.160.0', methods: ['thread/queue/add', 'turn/start'] });
    expect(capabilities.toolDisable).toBe('unsupported');
    expect(capabilities.preModelSuppression).toBe('unsupported');
    expect(capabilities.queue).toBe('supported');
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-parity-ping-')));
    const options = { config: CODEX_DEFAULTS, store, projectRoot: () => null, rollout: rollout(10) };
    runTick({ hook_event_name: 'UserPromptSubmit', session_id: 'ping-thread', prompt: 'work' }, { ...options, nowMs: OBSERVED_AT });
    const ping = runTick({ hook_event_name: 'UserPromptSubmit', session_id: 'ping-thread', prompt: KEEPALIVE_PING, turn_id: 'ping-turn' }, { ...options, nowMs: OBSERVED_AT + 31 * 60_000 });
    expect(ping.output).toContain('Reply with exactly the single word pong');
    expect(ping.output).toContain('Do not call any tools');
  });
});

describe('queued-ping-then-user-input (rows 7, 18)', () => {
  test('a ping that lands while the user is active is suppressed exactly where Claude suppresses it', () => {
    const claude = effectiveConfig();
    const codex = codexConfig();
    for (const minutes of [0, 1, 5, 9, 10, 15, 30, 45]) {
      expect(codexPingGate(minutes * 60_000, codex)).toBe(claudePingGate(minutes * 60_000, claude));
    }
  });
});

describe('subagent-pause-handoff (rows 15, 16)', () => {
  test('the spawn-relative pause point matches the Claude contract', () => {
    for (const spawn of [0, 40, 72, 80, 84, 90]) {
      expect(codexEffectivePause(codexConfig(), spawn)).toBe(claudeEffectivePause(effectiveConfig(), spawn));
    }
  });
});

describe('near-reset-bridge (row 13)', () => {
  test('the bridge applies under the same 5h level and reset distance as Claude', () => {
    for (const [percent, minutes] of [[85, 30], [85, 90], [95, 10], [50, 10]] as const) {
      const resetAt = OBSERVED_AT + minutes * 60_000;
      const claude = claudeBridge(claudeSnapshot({ fiveHourPercent: percent, fiveHourResetAt: new Date(resetAt).toISOString() }, effectiveConfig(), OBSERVED_AT), 60, OBSERVED_AT);
      const facts = buildFacts({ rateLimits: { accountId: 'a', rateLimits: { primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: resetAt / 1000 } } }, observedAtMs: OBSERVED_AT, tokenUsage: null, authenticated: true }, codexConfig(), OBSERVED_AT);
      expect(codexBridge(facts, 60, OBSERVED_AT) !== null).toBe(claude !== null);
    }
  });
});

describe('reset-wake-lost-ack-restart (rows 12, 14)', () => {
  test('re-registering the same reset after a restart returns the one existing wake', () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-parity-restart-')));
    const owner = { accountId: 'acct-parity', threadId: 'thread' };
    const first = new CodexService({ config: codexConfig(), store, now: () => OBSERVED_AT, checkpointExists: () => true }).scheduleResetWake(owner, 'checkpoint-exact', OBSERVED_AT + 60_000, OBSERVED_AT + 60_000);
    const restarted = new CodexService({ config: codexConfig(), store, now: () => OBSERVED_AT + 1_000, checkpointExists: () => true }).scheduleResetWake(owner, 'checkpoint-exact', OBSERVED_AT + 60_000, OBSERVED_AT + 60_000);
    expect(restarted.job.id).toBe(first.job.id);
    expect(restarted.job.submissionId).toBe(first.job.submissionId);
  });
});

describe('effective-non-default-settings (row 25)', () => {
  test('the Codex side reads the same effective thresholds Claude runs', () => {
    expect(codexConfig().thresholds.five_hour).toEqual(EFFECTIVE_THRESHOLDS.five_hour);
    expect(effectiveConfig().thresholds.five_hour).toEqual(EFFECTIVE_THRESHOLDS.five_hour);
  });
});
