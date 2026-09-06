import { describe, expect, test } from 'bun:test';
import { CODEX_DEFAULTS } from '../config';
import { buildFacts, meterLevel, readNativeFacts } from '../facts';
import { parseRateLimitsResponse } from '../native';

const NOW = 1_700_000_000_000;
const FRESH = NOW - 10_000;
const STALE = NOW - 10 * 60 * 1000;

function rateLimits(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    rateLimits: {
      planType: 'plus',
      spendControlReached: false,
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: (NOW + 86_400_000) / 1000 },
      ...overrides
    }
  };
}

describe('meter levels', () => {
  const cfg = CODEX_DEFAULTS;

  test('an unknown percentage has no level rather than a safe-looking none', () => {
    expect(meterLevel(null, 'five_hour', cfg)).toBeNull();
  });

  test('levels follow the configured ladder inclusively', () => {
    expect(meterLevel(cfg.thresholds.five_hour.critical, 'five_hour', cfg)).toBe('critical');
    expect(meterLevel(cfg.thresholds.five_hour.warn, 'five_hour', cfg)).toBe('warn');
    expect(meterLevel(cfg.thresholds.five_hour.notify, 'five_hour', cfg)).toBe('notify');
    expect(meterLevel(cfg.thresholds.five_hour.notify - 1, 'five_hour', cfg)).toBe('none');
  });
});

describe('fact assembly', () => {
  test('maps windows by duration and reports levels for each', () => {
    const facts = buildFacts(
      { rateLimits: rateLimits(), observedAtMs: FRESH, tokenUsage: null, authenticated: true },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.fiveHour?.usedPercent).toBe(42);
    expect(facts.weekly?.usedPercent).toBe(20);
    expect(facts.fiveHour?.resetsAtMs).toBe(NOW + 3_600_000);
  });

  test('a reading older than the freshness window is marked stale', () => {
    const fresh = buildFacts(
      { rateLimits: rateLimits(), observedAtMs: FRESH, tokenUsage: null, authenticated: true },
      CODEX_DEFAULTS,
      NOW
    );
    const stale = buildFacts(
      { rateLimits: rateLimits(), observedAtMs: STALE, tokenUsage: null, authenticated: true },
      CODEX_DEFAULTS,
      NOW
    );
    expect(fresh.stale).toBe(false);
    expect(stale.stale).toBe(true);
  });

  // A stale reading must not be usable as included capacity, or automation
  // would spend against a limit it can no longer see.
  test('a stale reading disables subscription automation', () => {
    const stale = buildFacts(
      { rateLimits: rateLimits(), observedAtMs: STALE, tokenUsage: null, authenticated: true },
      CODEX_DEFAULTS,
      NOW
    );
    expect(stale.capacity).toBe('unknown');
    expect(stale.automationAllowed).toBe(false);
    expect(stale.blockers.join(' ')).toContain('stale');
  });

  test('fresh included capacity permits automation', () => {
    const facts = buildFacts(
      { rateLimits: rateLimits(), observedAtMs: FRESH, tokenUsage: null, authenticated: true },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.capacity).toBe('included');
    expect(facts.automationAllowed).toBe(true);
    expect(facts.blockers).toEqual([]);
  });

  test('paid capacity disables automation, with no purchase path', () => {
    const facts = buildFacts(
      {
        rateLimits: rateLimits({ spendControlReached: true }),
        observedAtMs: FRESH,
        tokenUsage: null,
        authenticated: true
      },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.capacity).toBe('paid');
    expect(facts.automationAllowed).toBe(false);
  });

  test('an unauthenticated account never reads as included capacity', () => {
    const facts = buildFacts(
      { rateLimits: rateLimits(), observedAtMs: FRESH, tokenUsage: null, authenticated: false },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.capacity).toBe('unsupported');
    expect(facts.automationAllowed).toBe(false);
  });

  // A rolled-over reset means the cached percentage describes an ended block.
  test('a reset in the past marks the window rolled over and unusable', () => {
    const facts = buildFacts(
      {
        rateLimits: rateLimits({
          primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: (NOW - 60_000) / 1000 }
        }),
        observedAtMs: FRESH,
        tokenUsage: null,
        authenticated: true
      },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.fiveHour?.rolledOver).toBe(true);
    expect(facts.fiveHour?.level).toBeNull();
  });

  test('an unreadable percentage yields no level and blocks automation', () => {
    const facts = buildFacts(
      {
        rateLimits: rateLimits({ primary: { usedPercent: null, windowDurationMins: 300 } }),
        observedAtMs: FRESH,
        tokenUsage: null,
        authenticated: true
      },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.fiveHour?.usedPercent).toBeNull();
    expect(facts.fiveHour?.level).toBeNull();
    expect(facts.automationAllowed).toBe(false);
  });

  test('context comes from the current turn and its native window', () => {
    const facts = buildFacts(
      {
        rateLimits: rateLimits(),
        observedAtMs: FRESH,
        authenticated: true,
        tokenUsage: {
          modelContextWindow: 200_000,
          last: { inputTokens: 150_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 150_000 },
          total: { inputTokens: 900_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 900_000 }
        }
      },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.context?.usedPercent).toBe(75);
    expect(facts.context?.level).toBe('warn');
  });

  test('an unknown context window produces no context meter at all', () => {
    const facts = buildFacts(
      {
        rateLimits: rateLimits(),
        observedAtMs: FRESH,
        authenticated: true,
        tokenUsage: {
          modelContextWindow: null,
          last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10 },
          total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10 }
        }
      },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.context?.usedPercent).toBeNull();
    expect(facts.context?.level).toBeNull();
  });

  test('unknown buckets are retained without being interpreted', () => {
    const facts = buildFacts(
      {
        rateLimits: rateLimits({
          primary: { usedPercent: 5, windowDurationMins: 15 },
          secondary: null
        }),
        observedAtMs: FRESH,
        tokenUsage: null,
        authenticated: true
      },
      CODEX_DEFAULTS,
      NOW
    );
    expect(facts.fiveHour).toBeNull();
    expect(facts.unknownBuckets).toHaveLength(1);
    expect(facts.unknownBuckets[0]?.durationMinutes).toBe(15);
  });

  test('native account/read supplies subscription authentication when no override is given', async () => {
    const facts = await readNativeFacts({
      readRateLimits: async () => parseRateLimitsResponse(rateLimits(), NOW),
      readAccount: async () => ({ kind: 'chatgpt', authenticated: true, planType: 'plus', requiresOpenaiAuth: true, diagnostics: [] })
    }, CODEX_DEFAULTS, { nowMs: NOW });
    expect(facts.capacity).toBe('included');
    expect(facts.automationAllowed).toBe(true);
  });
});
