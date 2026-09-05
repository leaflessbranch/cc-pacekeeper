/**
 * Claude reference behavior, executed against the shipped runtime.
 *
 * These are the frozen outcomes the Codex package must reproduce where a row
 * is in scope. They assert what the code does, not what the plan prose says it
 * should do; where the two differed, the code wins and the difference is
 * recorded in a comment.
 */
import { describe, expect, test } from 'bun:test';
import scenarios from './scenarios.json';
import {
  EFFECTIVE_THRESHOLDS,
  PACKAGE_DEFAULT_THRESHOLDS,
  claudeLevel,
  claudeSnapshot,
  defaultConfig,
  effectiveConfig,
  levelOf
} from './harness';

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const FUTURE = new Date(NOW + 60 * 60 * 1000).toISOString();
const PAST = new Date(NOW - 60 * 60 * 1000).toISOString();

describe('frozen effective configuration', () => {
  // The audit refuted "defaults describe this user". Freezing defaults would
  // freeze a contract that is not the one running.
  test('effective thresholds genuinely override the package defaults', () => {
    expect(EFFECTIVE_THRESHOLDS).not.toEqual(PACKAGE_DEFAULT_THRESHOLDS);
    const cfg = effectiveConfig();
    expect(cfg.thresholds.five_hour).toEqual({ notify: 50, warn: 80, critical: 90 });
    expect(cfg.thresholds.weekly).toEqual({ notify: 50, warn: 95, critical: 98 });
    expect(cfg.thresholds.context).toEqual({ notify: 0, warn: 70, critical: 85 });
  });

  test('the shipped defaults are unchanged by the override', () => {
    expect(defaultConfig().thresholds.five_hour).toEqual(PACKAGE_DEFAULT_THRESHOLDS.five_hour);
    expect(defaultConfig().thresholds.context).toEqual(PACKAGE_DEFAULT_THRESHOLDS.context);
  });

  test('keepalive overrides are preserved, not normalized to defaults', () => {
    const cfg = effectiveConfig();
    expect(cfg.keepalive.require_pending).toBe(false);
    expect(cfg.keepalive.max_idle_hours).toBe(72);
    // The default is the opposite on both, so a silent reset would be visible.
    expect(defaultConfig().keepalive.require_pending).toBe(true);
    expect(defaultConfig().keepalive.max_idle_hours).toBe(12);
  });
});

describe('threshold ladder (row 5)', () => {
  const cfg = effectiveConfig();

  test('boundaries are inclusive at each level', () => {
    expect(claudeLevel(80, 'five_hour', cfg)).toBe('warn');
    expect(claudeLevel(90, 'five_hour', cfg)).toBe('critical');
    expect(claudeLevel(79, 'five_hour', cfg)).toBe('notify');
    expect(claudeLevel(49, 'five_hour', cfg)).toBe('none');
  });

  test('a zero notify threshold makes every context reading at least notify', () => {
    // context.notify is 0 in the effective config, so 0% is already 'notify'.
    expect(claudeLevel(0, 'context', cfg)).toBe('notify');
    expect(claudeLevel(69, 'context', cfg)).toBe('notify');
    expect(claudeLevel(70, 'context', cfg)).toBe('warn');
    expect(claudeLevel(85, 'context', cfg)).toBe('critical');
  });

  test('the same percentage yields a different level under defaults', () => {
    // 80% five-hour is warn under the effective config but only notify under
    // defaults. This is the concrete cost of freezing the wrong contract.
    expect(claudeLevel(80, 'five_hour', cfg)).toBe('warn');
    expect(claudeLevel(80, 'five_hour', defaultConfig())).toBe('notify');
  });
});

describe('snapshot composition (rows 2, 3, 5)', () => {
  const cfg = effectiveConfig();

  test('reports each meter at its own level and the max across them', () => {
    const snapshot = claudeSnapshot(
      {
        contextPercent: 10,
        fiveHourPercent: 92,
        fiveHourResetAt: FUTURE,
        weeklyPercent: 60,
        weeklyResetAt: FUTURE
      },
      cfg,
      NOW
    );
    expect(levelOf(snapshot, 'five_hour')).toBe('critical');
    expect(levelOf(snapshot, 'weekly')).toBe('notify');
    expect(snapshot.maxLevel).toBe('critical');
    expect(snapshot.driver?.meter).toBe('five_hour');
  });

  test('an absent context reading produces no context meter rather than a zero', () => {
    const snapshot = claudeSnapshot(
      { contextPercent: null, fiveHourPercent: 10, fiveHourResetAt: FUTURE },
      cfg,
      NOW
    );
    expect(snapshot.readings.some((reading) => reading.meter === 'context')).toBe(false);
  });

  // Row 5 / block identity: a rolled-over reset means the cached percentage
  // describes an ended block and must never drive a decision.
  test('a reset in the past marks the reading stale', () => {
    const snapshot = claudeSnapshot({ fiveHourPercent: 95, fiveHourResetAt: PAST }, cfg, NOW);
    expect(snapshot.readings.find((row) => row.meter === 'five_hour')?.stale).toBe(true);
  });

  test('a live reset is not marked stale', () => {
    const snapshot = claudeSnapshot({ fiveHourPercent: 95, fiveHourResetAt: FUTURE }, cfg, NOW);
    expect(snapshot.readings.find((row) => row.meter === 'five_hour')?.stale).toBeFalsy();
  });
});

describe('scenario corpus integrity', () => {
  test('keeps the shipped Claude rows and explicit deferrals visible', () => {
    expect(scenarios.version).toBe(1);
    expect(scenarios.scenarios.length).toBeGreaterThanOrEqual(20);
    expect(
      scenarios.scenarios.filter((row) => row.codex === 'deferred').map((row) => row.id)
    ).toEqual(['deferred-model-arbitrage', 'deferred-away-routing']);
  });

  // A scenario that no test executes is an inventory entry pretending to be
  // coverage. Every row names the capability it belongs to and its real
  // status, so an unimplemented row stays visibly unimplemented.
  test('every scenario declares its capability rows and status', () => {
    for (const row of scenarios.scenarios) {
      expect(typeof row.id).toBe('string');
      expect(row.capabilities.length).toBeGreaterThan(0);
      expect(['covered', 'pending', 'blocked', 'deferred']).toContain(row.status);
    }
  });
});
