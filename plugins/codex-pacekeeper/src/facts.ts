/**
 * Turn native readings into the facts a pacing decision consumes.
 *
 * The central rule is that unknown stays unknown. A meter whose percentage
 * could not be read has a `null` level rather than `none`, because `none`
 * means "measured, and low" and would let automation proceed against a limit
 * nobody can see. The same applies after a block rolls over: the cached
 * percentage then describes an ended window and is display-only.
 */
import {
  classifySubscriptionCapacity,
  parseRateLimitsResponse,
  parseThreadTokenUsage,
  type CapacityClassification,
  type NativeRateLimitsResponse,
  type NormalizedQuotaBucket,
  type ParsedAccount
} from './native';
import type { CodexConfig } from './config';
import type { NativeClient } from './native';

export type Level = 'none' | 'notify' | 'warn' | 'critical';
export type MeterName = 'context' | 'five_hour' | 'weekly';

/** `null` percent means unreadable, which is not the same as zero. */
export function meterLevel(
  percent: number | null,
  meter: MeterName,
  config: CodexConfig
): Level | null {
  if (percent === null) return null;
  const levels = config.thresholds[meter];
  if (percent >= levels.critical) return 'critical';
  if (percent >= levels.warn) return 'warn';
  if (percent >= levels.notify) return 'notify';
  return 'none';
}

export interface WindowFact {
  usedPercent: number | null;
  level: Level | null;
  resetsAtMs: number | null;
  /** The reset time has passed, so `usedPercent` describes an ended window. */
  rolledOver: boolean;
}

export interface ContextFact {
  currentTokens: number | null;
  contextWindow: number | null;
  usedPercent: number | null;
  level: Level | null;
  cache: { cachedInputTokens: number | null; cacheWriteInputTokens: number | null };
}

export interface FactInputs {
  rateLimits: NativeRateLimitsResponse | null;
  /** When the rate-limit reading was taken. */
  observedAtMs: number;
  tokenUsage: unknown;
  /** `false` disables subscription automation; `null` is unobserved. */
  authenticated: boolean | null;
}

export interface CodexFacts {
  accountId: string | null;
  planType: string | null;
  fiveHour: WindowFact | null;
  weekly: WindowFact | null;
  /** Buckets whose duration matched no known window. Retained, not guessed at. */
  unknownBuckets: NormalizedQuotaBucket[];
  context: ContextFact | null;
  stale: boolean;
  capacity: CapacityClassification;
  /** True only when every gate for spending included capacity is satisfied. */
  automationAllowed: boolean;
  /** Why automation is disallowed. Empty exactly when it is allowed. */
  blockers: string[];
  diagnostics: string[];
}

function toWindowFact(
  bucket: NormalizedQuotaBucket | undefined,
  meter: MeterName,
  config: CodexConfig,
  nowMs: number
): WindowFact | null {
  if (bucket === undefined) return null;
  const rolledOver = bucket.resetsAtMs !== null && bucket.resetsAtMs <= nowMs;
  return {
    usedPercent: bucket.usedPercent,
    // After a rollover the percentage belongs to a window that has ended, so
    // it must not drive a decision even though it is still worth displaying.
    level: rolledOver ? null : meterLevel(bucket.usedPercent, meter, config),
    resetsAtMs: bucket.resetsAtMs,
    rolledOver
  };
}

export function buildFacts(
  inputs: FactInputs,
  config: CodexConfig,
  nowMs: number
): CodexFacts {
  const blockers: string[] = [];

  if (inputs.rateLimits === null) {
    return {
      accountId: null,
      planType: null,
      fiveHour: null,
      weekly: null,
      unknownBuckets: [],
      context: null,
      stale: true,
      capacity: 'unknown',
      automationAllowed: false,
      blockers: ['no native rate-limit reading is available'],
      diagnostics: ['rate limits were not read']
    };
  }

  const parsed = parseRateLimitsResponse(inputs.rateLimits, inputs.observedAtMs);
  const ageMs = nowMs - inputs.observedAtMs;
  const invalidObservationTime = !Number.isFinite(inputs.observedAtMs) || inputs.observedAtMs > nowMs;
  const stale = invalidObservationTime || ageMs > config.usage_freshness_seconds * 1000;
  if (invalidObservationTime) blockers.push('the native quota observation time is invalid');
  else if (stale) blockers.push('the native quota reading is stale');
  if (parsed.accountId === null) blockers.push('the native account identity is unknown');

  const capacity = classifySubscriptionCapacity({
    planType: parsed.planType,
    spendControlReached: parsed.spendControlReached,
    rateLimitReachedType: parsed.rateLimitReachedType,
    fresh: !stale,
    ...(inputs.authenticated === null ? {} : { authenticated: inputs.authenticated }),
    creditsAvailable: parsed.credits.hasCredits
  });
  if (capacity !== 'included') {
    blockers.push(`subscription capacity is ${capacity}, not confirmed included`);
  }

  const byKind = new Map<string, NormalizedQuotaBucket>();
  const unknownBuckets: NormalizedQuotaBucket[] = [];
  for (const bucket of parsed.buckets) {
    if (bucket.kind === 'unknown') unknownBuckets.push(bucket);
    else if (!byKind.has(bucket.kind)) byKind.set(bucket.kind, bucket);
  }

  const fiveHour = toWindowFact(byKind.get('five_hour'), 'five_hour', config, nowMs);
  const weekly = toWindowFact(byKind.get('weekly'), 'weekly', config, nowMs);

  // An unreadable five-hour meter is the one that matters for pacing: without
  // it there is no basis for spending the block.
  if (fiveHour === null || fiveHour.usedPercent === null) {
    blockers.push('the five-hour window could not be read');
  } else if (fiveHour.rolledOver) {
    blockers.push('the five-hour window rolled over and has not been re-read');
  } else if (fiveHour.usedPercent >= 100) {
    blockers.push('the five-hour window is exhausted');
  }
  if (parsed.rateLimitReachedType !== null) {
    blockers.push(`the native rate-limit state is ${parsed.rateLimitReachedType}`);
  }

  const usage = inputs.tokenUsage === null ? null : parseThreadTokenUsage(inputs.tokenUsage);
  const context: ContextFact | null = usage === null
    ? null
    : {
        currentTokens: usage.currentTokens,
        contextWindow: usage.contextWindow,
        usedPercent: usage.usedPercent,
        level: meterLevel(usage.usedPercent, 'context', config),
        cache: usage.cache
      };

  return {
    accountId: parsed.accountId,
    planType: parsed.planType,
    fiveHour,
    weekly,
    unknownBuckets,
    context,
    stale,
    capacity,
    automationAllowed: blockers.length === 0,
    blockers,
    diagnostics: [...parsed.diagnostics, ...(usage?.diagnostics ?? [])]
  };
}

/** Read native facts through a selected existing owner; never falls back to an API. */
export async function readNativeFacts(
  client: Pick<NativeClient, 'readRateLimits'> & Partial<Pick<NativeClient, 'readAccount'>>,
  config: CodexConfig,
  options: { nowMs?: number; authenticated?: boolean | null; tokenUsage?: unknown } = {}
): Promise<CodexFacts> {
  const nowMs = options.nowMs ?? Date.now();
  try {
    const [rateLimitsResult, accountResult] = await Promise.allSettled([
      client.readRateLimits(),
      client.readAccount?.()
    ]);
    if (rateLimitsResult.status !== 'fulfilled') throw rateLimitsResult.reason;
    const account = accountResult.status === 'fulfilled' ? accountResult.value as ParsedAccount : null;
    const authenticated = options.authenticated !== undefined
      ? options.authenticated
      : account?.authenticated ?? null;
    return buildFacts({ rateLimits: rateLimitsResult.value, observedAtMs: nowMs, tokenUsage: options.tokenUsage ?? null, authenticated }, config, nowMs);
  } catch {
    return buildFacts({ rateLimits: null, observedAtMs: nowMs, tokenUsage: null, authenticated: options.authenticated ?? null }, config, nowMs);
  }
}
