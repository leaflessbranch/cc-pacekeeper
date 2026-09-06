#!/usr/bin/env bun
/** Bounded PostToolUse observer. It records facts, never raw prompts. */
import { parseRateLimitsResponse, parseThreadTokenUsage, type NativeRateLimitsResponse } from './native';
import { CodexStore, type StateIdentity } from './storage';
import type { NativeClient } from './native';
import { readFileSync } from 'fs';

export interface RefreshInput {
  hook_event_name?: unknown;
  event?: unknown;
  thread_id?: unknown;
  session_id?: unknown;
  account_id?: unknown;
  now_ms?: unknown;
  rateLimits?: unknown;
  rate_limits?: unknown;
  tokenUsage?: unknown;
  token_usage?: unknown;
  authenticated?: unknown;
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value : null; }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : Date.now(); }

export function refreshObservations(input: RefreshInput, store = new CodexStore()): StateIdentity {
  const nowMs = number(input.now_ms);
  const rawLimits = input.rateLimits ?? input.rate_limits;
  const parsedLimits = rawLimits && typeof rawLimits === 'object' ? parseRateLimitsResponse(rawLimits as NativeRateLimitsResponse, nowMs) : null;
  const parsedUsage = input.tokenUsage === undefined && input.token_usage === undefined ? null : parseThreadTokenUsage(input.tokenUsage ?? input.token_usage);
  const identity: StateIdentity = {
    accountId: text(input.account_id) ?? parsedLimits?.accountId ?? null,
    threadId: text(input.thread_id) ?? text(input.session_id) ?? 'unknown-thread'
  };
  const existing = store.read(identity, 'timeline');
  const prior = typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {};
  const event = text(input.hook_event_name) ?? text(input.event) ?? 'unknown';
  const buckets = parsedLimits?.buckets.map((bucket) => ({ id: bucket.id, kind: bucket.kind, usedPercent: bucket.usedPercent, durationMinutes: bucket.durationMinutes, resetsAtMs: bucket.resetsAtMs, valid: bucket.valid })) ?? [];
  store.write(identity, 'timeline', {
    ...prior,
    lastObservedAtMs: nowMs,
    ...(event === 'PostToolUse' ? { lastWorkAtMs: nowMs, lastToolActivityAtMs: nowMs } : {}),
    ...(parsedLimits ? { rateLimits: { accountId: parsedLimits.accountId, planType: parsedLimits.planType, rateLimitReachedType: parsedLimits.rateLimitReachedType, buckets, spendControlReached: parsedLimits.spendControlReached, diagnostics: parsedLimits.diagnostics } } : {}),
    ...(parsedUsage ? { tokenUsage: { currentTokens: parsedUsage.currentTokens, contextWindow: parsedUsage.contextWindow, usedPercent: parsedUsage.usedPercent, cache: parsedUsage.cache, diagnostics: parsedUsage.diagnostics } } : {}),
    ...(typeof input.authenticated === 'boolean' ? { authenticated: input.authenticated } : {})
  });
  return identity;
}

/** Refresh through the already selected owner. A failed request writes no fake zeros. */
export async function refreshFromOwner(
  client: Pick<NativeClient, 'readRateLimits'>,
  identity: { accountId: string | null; threadId: string },
  store = new CodexStore(),
  options: { tokenUsage?: unknown; authenticated?: boolean } = {}
): Promise<StateIdentity | null> {
  try {
    const rateLimits = await client.readRateLimits();
    return refreshObservations({
      hook_event_name: 'native-refresh',
      thread_id: identity.threadId,
      account_id: identity.accountId ?? undefined,
      now_ms: Date.now(),
      rateLimits,
      tokenUsage: options.tokenUsage,
      authenticated: options.authenticated
    }, store);
  } catch { return null; }
}

function main(): void {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as RefreshInput;
    refreshObservations(input);
  } catch { /* hooks remain inert when input or state is unavailable */ }
  process.stdout.write('{}\n');
}

if (import.meta.main) main();
