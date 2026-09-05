import { describe, expect, test } from 'bun:test';
import { CODEX_DEFAULTS } from '../config';
import { decide, type PolicyState } from '../policy';
import type { CodexFacts } from '../facts';

const NOW = 1_700_000_000_000;

function facts(overrides: Partial<CodexFacts> = {}): CodexFacts {
  return {
    accountId: 'acct-1',
    planType: 'plus',
    fiveHour: { usedPercent: 10, level: 'none', resetsAtMs: NOW + 3_600_000, rolledOver: false },
    weekly: { usedPercent: 10, level: 'none', resetsAtMs: NOW + 86_400_000, rolledOver: false },
    unknownBuckets: [],
    context: null,
    stale: false,
    capacity: 'included',
    automationAllowed: true,
    blockers: [],
    diagnostics: [],
    ...overrides
  };
}

const empty: PolicyState = { levels: {}, lastInjectedAtMs: {}, blockResetAtMs: null, savedThisCycle: false };

function at(level: 'notify' | 'warn' | 'critical', percent: number): CodexFacts {
  return facts({
    fiveHour: { usedPercent: percent, level, resetsAtMs: NOW + 3_600_000, rolledOver: false }
  });
}

describe('injection and debounce', () => {
  test('a first crossing injects', () => {
    const result = decide(
      { event: 'UserPromptSubmit', facts: at('warn', 86), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    );
    expect(result.inject).toBe(true);
    expect(result.level).toBe('warn');
  });

  test('an unchanged level within the debounce window does not re-inject', () => {
    const state = decide(
      { event: 'UserPromptSubmit', facts: at('warn', 86), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    ).nextState;
    const again = decide(
      { event: 'UserPromptSubmit', facts: at('warn', 86), state, nowMs: NOW + 1_000 },
      CODEX_DEFAULTS
    );
    expect(again.inject).toBe(false);
  });

  // Preserved Claude behavior: an ordinary reminder re-emits once the debounce
  // window elapses, even with no escalation.
  test('the same level re-emits after the debounce window', () => {
    const state = decide(
      { event: 'UserPromptSubmit', facts: at('warn', 86), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    ).nextState;
    const later = decide(
      {
        event: 'UserPromptSubmit',
        facts: at('warn', 86),
        state,
        nowMs: NOW + CODEX_DEFAULTS.debounce_seconds * 1000 + 1
      },
      CODEX_DEFAULTS
    );
    expect(later.inject).toBe(true);
  });

  test('an escalation injects immediately, ignoring the debounce window', () => {
    const state = decide(
      { event: 'UserPromptSubmit', facts: at('warn', 86), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    ).nextState;
    const escalated = decide(
      { event: 'UserPromptSubmit', facts: at('critical', 96), state, nowMs: NOW + 1_000 },
      CODEX_DEFAULTS
    );
    expect(escalated.inject).toBe(true);
    expect(escalated.level).toBe('critical');
  });

  test('a drop in level does not inject', () => {
    const state = decide(
      { event: 'UserPromptSubmit', facts: at('critical', 96), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    ).nextState;
    const dropped = decide(
      { event: 'UserPromptSubmit', facts: at('warn', 86), state, nowMs: NOW + 1_000 },
      CODEX_DEFAULTS
    );
    expect(dropped.inject).toBe(false);
  });

  test('a meter with no readable level never injects', () => {
    const result = decide(
      {
        event: 'UserPromptSubmit',
        facts: facts({
          fiveHour: { usedPercent: null, level: null, resetsAtMs: null, rolledOver: false }
        }),
        state: empty,
        nowMs: NOW
      },
      CODEX_DEFAULTS
    );
    expect(result.inject).toBe(false);
  });
});

describe('block identity and re-arm', () => {
  // A new block is a new decision context: the previous block's levels must
  // not suppress the first reminder of the new one.
  test('a block reset clears the recorded levels', () => {
    const state = decide(
      { event: 'UserPromptSubmit', facts: at('critical', 96), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    ).nextState;
    const afterReset = decide(
      {
        event: 'UserPromptSubmit',
        facts: facts({
          fiveHour: { usedPercent: 5, level: 'none', resetsAtMs: NOW + 20_000_000, rolledOver: false }
        }),
        state,
        nowMs: NOW + 3_700_000
      },
      CODEX_DEFAULTS
    );
    // The previous block's 'critical' is gone, so it cannot suppress the new
    // block's first reminder.
    expect(afterReset.nextState.levels['five_hour']).toBeUndefined();
    expect(afterReset.nextState.blockResetAtMs).toBe(NOW + 20_000_000);
  });

  test('the new block can reach critical again without being suppressed', () => {
    const first = decide(
      { event: 'UserPromptSubmit', facts: at('critical', 96), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    ).nextState;
    // Same level, new block: the old record must not debounce this away.
    const newBlock = decide(
      {
        event: 'UserPromptSubmit',
        facts: facts({
          fiveHour: { usedPercent: 96, level: 'critical', resetsAtMs: NOW + 20_000_000, rolledOver: false }
        }),
        state: first,
        nowMs: NOW + 1_000
      },
      CODEX_DEFAULTS
    );
    expect(newBlock.inject).toBe(true);
  });
});

describe('event mapping', () => {
  test('Stop does not re-enter while a continuation is already active', () => {
    const result = decide(
      {
        event: 'Stop',
        facts: at('critical', 96),
        state: empty,
        nowMs: NOW,
        continuationActive: true
      },
      CODEX_DEFAULTS
    );
    expect(result.inject).toBe(false);
    expect(result.reason).toContain('continuation');
  });

  test('Stop injects when no continuation is active', () => {
    const result = decide(
      { event: 'Stop', facts: at('critical', 96), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    );
    expect(result.inject).toBe(true);
  });

  test('SessionEnd never injects, since nothing can consume it', () => {
    const result = decide(
      { event: 'SessionEnd', facts: at('critical', 96), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    );
    expect(result.inject).toBe(false);
  });

  test('a synthetic keepalive turn suppresses all other policy output', () => {
    const result = decide(
      { event: 'UserPromptSubmit', facts: at('critical', 96), state: empty, nowMs: NOW, synthetic: true },
      CODEX_DEFAULTS
    );
    expect(result.inject).toBe(false);
    expect(result.reason).toContain('synthetic');
  });
});

describe('activity accounting', () => {
  // A synthetic submission must not look like the user being present.
  test('a synthetic event does not advance the user activity anchor', () => {
    const result = decide(
      { event: 'UserPromptSubmit', facts: facts(), state: empty, nowMs: NOW, synthetic: true },
      CODEX_DEFAULTS
    );
    expect(result.nextState.lastUserActivityAtMs).toBeUndefined();
  });

  test('a real prompt advances the user activity anchor', () => {
    const result = decide(
      { event: 'UserPromptSubmit', facts: facts(), state: empty, nowMs: NOW },
      CODEX_DEFAULTS
    );
    expect(result.nextState.lastUserActivityAtMs).toBe(NOW);
  });
});

describe('purity', () => {
  test('the decision never mutates the state it was given', () => {
    const state: PolicyState = { levels: {}, lastInjectedAtMs: {}, blockResetAtMs: null, savedThisCycle: false };
    const snapshot = JSON.stringify(state);
    decide({ event: 'UserPromptSubmit', facts: at('critical', 96), state, nowMs: NOW }, CODEX_DEFAULTS);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
