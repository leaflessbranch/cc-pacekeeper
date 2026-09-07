#!/usr/bin/env bun
/** Bounded PostToolUse observer. It records facts, never raw prompts. */
import { parseRateLimitsResponse, parseThreadTokenUsage, type NativeRateLimitsResponse } from './native';
import { CodexStore, type StateIdentity } from './storage';
import { clientForExistingOwner } from './native-transport';
import { findLiveOwner } from './live-sessions';
import { normalizeNativeCapabilities, type NativeClient } from './native';
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
  pending_work?: unknown;
  pendingWork?: unknown;
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value : null; }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : Date.now(); }

export function refreshObservations(input: RefreshInput, store = new CodexStore()): StateIdentity {
  const nowMs = number(input.now_ms);
  const rawLimits = input.rateLimits ?? input.rate_limits;
  const parsedLimits = rawLimits && typeof rawLimits === 'object' ? parseRateLimitsResponse(rawLimits as NativeRateLimitsResponse, nowMs) : null;
  const rawUsage = input.tokenUsage ?? input.token_usage;
  const parsedUsage = rawUsage === undefined || rawUsage === null ? null : parseThreadTokenUsage(rawUsage);
  const identity: StateIdentity = {
    accountId: text(input.account_id) ?? parsedLimits?.accountId ?? null,
    threadId: text(input.thread_id) ?? text(input.session_id) ?? 'unknown-thread'
  };
  const existing = store.read(identity, 'timeline');
  const prior = typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {};
  const event = text(input.hook_event_name) ?? text(input.event) ?? 'unknown';
  // A fulfilled native call with an empty or malformed payload is not a fresh
  // quota/context observation. Keep the old clocks so a failed refresh cannot
  // turn stale values into an eligibility signal.
  const quotaObserved = parsedLimits !== null && (
    parsedLimits.buckets.length > 0
    || parsedLimits.rateLimitReachedType !== null
    || parsedLimits.spendControlReached !== null
    || Object.keys(parsedLimits.byLimitId).length > 0
  );
  const contextObserved = parsedUsage !== null && (
    parsedUsage.currentTokens !== null
    || parsedUsage.contextWindow !== null
    || parsedUsage.cache.cachedInputTokens !== null
    || parsedUsage.cache.cacheWriteInputTokens !== null
  );
  const authObserved = typeof input.authenticated === 'boolean';
  const priorQuotaAt = typeof prior['quotaObservedAtMs'] === 'number' ? prior['quotaObservedAtMs'] : undefined;
  const priorContextAt = typeof prior['contextObservedAtMs'] === 'number' ? prior['contextObservedAtMs'] : undefined;
  const priorAuthAt = typeof prior['authObservedAtMs'] === 'number' ? prior['authObservedAtMs'] : undefined;
  const observedTimes = [
    quotaObserved ? nowMs : priorQuotaAt,
    contextObserved ? nowMs : priorContextAt,
    authObserved ? nowMs : priorAuthAt
  ].filter((value): value is number => value !== undefined);
  const lastObservedAtMs = observedTimes.length === 0 ? undefined : Math.max(...observedTimes);
  store.write(identity, 'timeline', {
    ...prior,
    accountId: identity.accountId,
    threadId: identity.threadId,
    ...(lastObservedAtMs === undefined ? {} : { lastObservedAtMs }),
    ...(quotaObserved ? { quotaObservedAtMs: nowMs } : {}),
    ...(contextObserved ? { contextObservedAtMs: nowMs } : {}),
    ...(authObserved ? { authObservedAtMs: nowMs } : {}),
    ...(event === 'PostToolUse' ? { lastActivityAtMs: nowMs, lastWorkAtMs: nowMs, lastToolActivityAtMs: nowMs } : {}),
    ...(typeof input.pending_work === 'boolean' ? { pendingWork: input.pending_work } : typeof input.pendingWork === 'boolean' ? { pendingWork: input.pendingWork } : {}),
    ...(quotaObserved && parsedLimits ? { rateLimits: parsedLimits } : {}),
    ...(contextObserved && parsedUsage ? { tokenUsage: parsedUsage } : {}),
    // A fresh native account read that says "unknown" must clear the old
    // boolean, but it must not advance auth freshness until a boolean is read.
    ...(input.authenticated === null || typeof input.authenticated === 'boolean' ? { authenticated: input.authenticated } : {})
  });
  return identity;
}

/** Refresh through the already selected owner. A failed request writes no fake zeros. */
export async function refreshFromOwner(
  client: Pick<NativeClient, 'readRateLimits'> & Partial<Pick<NativeClient, 'readAccount'>>,
  identity: { accountId: string | null; threadId: string },
  store = new CodexStore(),
  options: { tokenUsage?: unknown; authenticated?: boolean } = {}
): Promise<StateIdentity | null> {
  try {
    const [rateLimitsResult, accountResult] = await Promise.allSettled([
      client.readRateLimits(),
      client.readAccount?.()
    ]);
    if (rateLimitsResult.status !== 'fulfilled') return null;
    const rateLimits = rateLimitsResult.value;
    if (identity.accountId !== null && rateLimits.accountId !== null && rateLimits.accountId !== identity.accountId) return null;
    const accountAuthenticated = accountResult.status === 'fulfilled' && accountResult.value !== undefined
      ? accountResult.value.authenticated ?? null
      : null;
    const authenticated = options.authenticated ?? accountAuthenticated;
    return refreshObservations({
      hook_event_name: 'native-refresh',
      thread_id: identity.threadId,
      account_id: identity.accountId ?? undefined,
      now_ms: Date.now(),
      rateLimits,
      ...(options.tokenUsage === undefined ? {} : { tokenUsage: options.tokenUsage }),
      authenticated
    }, store);
  } catch { return null; }
}

async function refreshThroughExistingOwner(input: RefreshInput, store: CodexStore): Promise<void> {
  const threadId = text(input.thread_id) ?? text(input.session_id);
  if (threadId === null) return;
  // An account id returned by the rate-limit read is an evidenced identity
  // source. It is safe to use for owner selection; an absent id remains
  // unknown and cannot authorize a live owner.
  const suppliedLimits = input.rateLimits ?? input.rate_limits;
  const observedLimits = suppliedLimits && typeof suppliedLimits === 'object'
    ? parseRateLimitsResponse(suppliedLimits as NativeRateLimitsResponse, number(input.now_ms))
    : null;
  const accountId = text(input.account_id) ?? observedLimits?.accountId ?? null;
  const lookup = findLiveOwner(threadId, accountId);
  if (lookup.status !== 'found' || lookup.owner === undefined || lookup.owner.methods === undefined) return;
  const capabilities = normalizeNativeCapabilities({ version: lookup.owner.protocolVersion, methods: lookup.owner.methods });
  const client = clientForExistingOwner(lookup.owner, capabilities, 750);
  if (client === null) return;
  await refreshFromOwner(client, { accountId: accountId ?? lookup.owner.accountId, threadId }, store, {
    tokenUsage: input.tokenUsage ?? input.token_usage,
    ...(typeof input.authenticated === 'boolean' ? { authenticated: input.authenticated } : {})
  });
}

async function main(): Promise<void> {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as RefreshInput;
    const store = new CodexStore();
    refreshObservations(input, store);
    // Native reads are bounded by the selected existing owner's transport. A
    // missing or untrusted owner leaves the cached hook observation intact and
    // never starts a second server or invents fresh values.
    await refreshThroughExistingOwner(input, store);
  } catch { /* hooks remain inert when input or state is unavailable */ }
  process.stdout.write('{}\n');
}

if (import.meta.main) main();
