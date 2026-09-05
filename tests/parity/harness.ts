/**
 * Black-box behavioral harness for the two harnesses' shared scenarios.
 *
 * A scenario names inputs plus the observations a correct implementation must
 * produce. The Claude side executes the SHIPPED runtime, so a recorded outcome
 * is the behavior that actually ships rather than a restatement of the policy
 * we wish it had. The Codex side executes its own package. Neither production
 * package imports this harness or the other's runtime.
 *
 * The frozen contract is the user's EFFECTIVE configuration, not the package
 * defaults: the audit refuted the assumption that defaults describe this
 * install, so a test pinning defaults would freeze a contract nobody runs.
 * Every identity, path and destination below is synthetic.
 */
import { computeSnapshot, levelForMeter, type Snapshot } from '../../plugins/cc-pacekeeper/src/thresholds';
import { DEFAULT_CONFIG, type Config } from '../../plugins/cc-pacekeeper/src/config';
import type { UsageData } from '../../plugins/cc-pacekeeper/src/vendor/usage-types';
import type { Level, Meter } from '../../plugins/cc-pacekeeper/src/state';

/**
 * Thresholds observed in the live install. They differ from package defaults
 * on every meter, which is precisely why they are recorded here.
 */
export const EFFECTIVE_THRESHOLDS = {
  context: { notify: 0, warn: 70, critical: 85 },
  five_hour: { notify: 50, warn: 80, critical: 90 },
  weekly: { notify: 50, warn: 95, critical: 98 }
} as const;

export const EFFECTIVE_KEEPALIVE = {
  require_pending: false,
  max_idle_hours: 72
} as const;

/** The shipped defaults, kept so a test can prove the override is real. */
export const PACKAGE_DEFAULT_THRESHOLDS = {
  context: { notify: 60, warn: 75, critical: 90 },
  five_hour: { notify: 70, warn: 85, critical: 95 },
  weekly: { notify: 50, warn: 70, critical: 85 }
} as const;

/** The effective config, built from the shipped defaults exactly as the
 *  runtime merges a partial user config over them. */
export function effectiveConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    thresholds: {
      context: { ...EFFECTIVE_THRESHOLDS.context },
      five_hour: { ...EFFECTIVE_THRESHOLDS.five_hour },
      weekly: { ...EFFECTIVE_THRESHOLDS.weekly }
    },
    keepalive: { ...DEFAULT_CONFIG.keepalive, ...EFFECTIVE_KEEPALIVE }
  };
}

export function defaultConfig(): Config {
  return DEFAULT_CONFIG;
}

/** Run the shipped Claude level ladder for one meter. */
export function claudeLevel(percent: number, meter: Meter, cfg: Config): Level {
  return levelForMeter(percent, meter, cfg);
}

export interface MeterInputs {
  contextPercent?: number | null;
  fiveHourPercent?: number;
  fiveHourResetAt?: string;
  weeklyPercent?: number;
  weeklyResetAt?: string;
}

/** Run the shipped Claude snapshot computation over synthetic readings. */
export function claudeSnapshot(inputs: MeterInputs, cfg: Config, now: number): Snapshot {
  const usage: UsageData = {
    sessionUsage: inputs.fiveHourPercent,
    sessionResetAt: inputs.fiveHourResetAt,
    weeklyUsage: inputs.weeklyPercent,
    weeklyResetAt: inputs.weeklyResetAt
  };
  return computeSnapshot(
    { contextPercent: inputs.contextPercent ?? null, usage },
    cfg,
    now
  );
}

/** Level for one meter in a snapshot, or 'none' when the meter is absent. */
export function levelOf(snapshot: Snapshot, meter: Meter): Level {
  return snapshot.readings.find((reading) => reading.meter === meter)?.level ?? 'none';
}

export type { Level, Meter, Config, Snapshot };
