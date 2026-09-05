/**
 * Codex behavior for the shared scenarios, executed against the Codex package.
 *
 * Only rows the Codex package genuinely implements are asserted here. A row
 * that is `pending` or `blocked` gets an assertion that it is NOT silently
 * claimed as working, so the corpus cannot drift into implying coverage that
 * does not exist.
 */
import { describe, expect, test } from 'bun:test';
import scenarios from './scenarios.json';
import {
  classifySubscriptionCapacity,
  normalizeNativeCapabilities,
  parseRateLimitsResponse,
  parseThreadTokenUsage
} from '../../plugins/codex-pacekeeper/src/native';
import { EFFECTIVE_THRESHOLDS, claudeLevel, effectiveConfig } from './harness';

const OBSERVED_AT = Date.UTC(2026, 8, 5, 12, 0, 0);

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
    // Rows 4, 8, 13, 17, 19, 23, 26 and 27 have no scenario yet. Listing them
    // explicitly keeps the gap visible rather than letting an empty set pass.
    expect(missing).toEqual([4, 8, 13, 17, 19, 23, 26, 27]);
  });

  test('a blocked row is never reported as covered', () => {
    const blocked = scenarios.scenarios.filter((row) => row.status === 'blocked').map((row) => row.id);
    expect(blocked).toEqual([
      'keepalive-text-preservation',
      'keepalive-strict-no-tools',
      'precompact-save-barrier'
    ]);
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
      classifySubscriptionCapacity({ planType: 'plus', spendControlReached: true, fresh: true })
    ).toBe('paid');
    expect(
      classifySubscriptionCapacity({ planType: 'plus', spendControlReached: false, fresh: true })
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

describe('blocked native gates stay blocked (rows 11, 18)', () => {
  // These must fail loudly if someone later "implements" them by asserting a
  // capability the protocol does not have.
  test('no protocol version advertises tool disable, suppression or a save barrier', () => {
    const capabilities = normalizeNativeCapabilities({
      version: '0.153.4',
      methods: ['thread/queue/add', 'turn/start', 'thread/compact/start']
    });
    expect(capabilities.toolDisable).toBe('unsupported');
    expect(capabilities.preModelSuppression).toBe('unsupported');
    expect(capabilities.saveBarrier).toBe('unsupported');
  });
});

describe('effective-non-default-settings (row 25)', () => {
  test('the Codex side reads the same effective thresholds Claude runs', () => {
    expect(effectiveConfig().thresholds.five_hour).toEqual(EFFECTIVE_THRESHOLDS.five_hour);
  });
});
