#!/usr/bin/env bun
/**
 * Background native refresh. The shim runs this detached, so a hook returns
 * at once; the process self-gates on the age of the account record, so a
 * burst of tool calls costs one native round trip, not one per tool.
 *
 * Only the account-wide facts the rollout cannot carry are read here: the
 * account id, authentication, the included-usage permission and the full
 * multi-bucket rate-limit view. Context and the default bucket come from the
 * rollout in the hook itself.
 */
import { readFileSync } from 'fs';
import { loadCodexConfig } from './config';
import { discoverNativeControlClient } from './live-sessions';
import { parseRateLimitsResponse, type NativeClient } from './native';
import { ACCOUNT_IDENTITY, CodexStore } from './storage';

/** Refresh no more often than this, whatever fires the hook. */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

export interface RefreshInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  agent_id?: unknown;
  now_ms?: unknown;
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value : null; }

/**
 * Persist one native observation into the account record. A failed or empty
 * read advances no clock, so stale values can never look fresh.
 */
export async function refreshFromOwner(
  client: Pick<NativeClient, 'readRateLimits'> & Partial<Pick<NativeClient, 'readAccount'>>,
  identity: { accountId: string | null; threadId: string },
  store = new CodexStore(),
  options: { nowMs?: number } = {}
): Promise<{ accountId: string | null } | null> {
  const nowMs = options.nowMs ?? Date.now();
  try {
    const [limitsResult, accountResult] = await Promise.allSettled([client.readRateLimits(), client.readAccount?.()]);
    const accountValue = accountResult.status === 'fulfilled' ? accountResult.value : undefined;
    const authenticated = accountValue === undefined ? undefined : accountValue.authenticated ?? null;
    if (limitsResult.status !== 'fulfilled') {
      // Authentication is independent: a logout observed while quota fails
      // must still clear a stale authenticated=true.
      if (authenticated === undefined) return null;
      store.update(ACCOUNT_IDENTITY, 'account', (prior) => ({ ...prior, authenticated, ...(typeof authenticated === 'boolean' ? { authObservedAtMs: nowMs } : {}) }));
      return { accountId: null };
    }
    const limits = parseRateLimitsResponse(limitsResult.value, nowMs);
    if (identity.accountId !== null && limits.accountId !== identity.accountId) return null;
    const quotaObserved = limits.buckets.length > 0 || Object.keys(limits.byLimitId).length > 0 || limits.rateLimitReachedType !== null;
    store.update(ACCOUNT_IDENTITY, 'account', (prior) => ({
      ...prior,
      accountId: limits.accountId ?? prior['accountId'] ?? null,
      ...(quotaObserved ? { rateLimits: limits, quotaObservedAtMs: nowMs } : {}),
      ...(limits.ordinaryUsageAllowed !== null ? { ordinaryUsageObservedAtMs: nowMs, ...(quotaObserved ? {} : { rateLimits: { ...(prior['rateLimits'] as object ?? {}), ordinaryUsageAllowed: limits.ordinaryUsageAllowed } }) } : {}),
      ...(authenticated !== undefined ? { authenticated, ...(typeof authenticated === 'boolean' ? { authObservedAtMs: nowMs } : {}) } : {})
    }));
    return { accountId: limits.accountId };
  } catch {
    return null;
  }
}

/** True when the account record is old enough to be worth a native read. */
export function refreshDue(store: CodexStore, nowMs: number, event: string | null): boolean {
  if (event === 'SessionStart') return true;
  const row = store.read(ACCOUNT_IDENTITY, 'account') as Record<string, unknown> | null;
  const times = [row?.['quotaObservedAtMs'], row?.['refreshAttemptAtMs']].filter((value): value is number => typeof value === 'number');
  if (times.length === 0) return true;
  const at = Math.max(...times);
  return nowMs - at >= REFRESH_MIN_INTERVAL_MS || nowMs < at;
}

export async function runRefresh(input: RefreshInput, store = new CodexStore()): Promise<void> {
  const nowMs = typeof input.now_ms === 'number' ? input.now_ms : Date.now();
  if (!refreshDue(store, nowMs, text(input.hook_event_name))) return;
  // Stamp the attempt first so concurrent hooks in the same burst back off.
  store.update(ACCOUNT_IDENTITY, 'account', (prior) => ({ ...prior, refreshAttemptAtMs: nowMs }));
  const threadId = text(input.agent_id) ?? text(input.session_id);
  if (threadId === null) return;
  // The control socket must already host this thread: never start a server.
  const client = await discoverNativeControlClient(threadId, null);
  if (client === null) return;
  await refreshFromOwner(client, { accountId: null, threadId }, store, { nowMs });
}

if (import.meta.main) {
  (async () => {
    let input: RefreshInput = {};
    try { input = JSON.parse(readFileSync(0, 'utf8')) as RefreshInput; } catch { return; }
    loadCodexConfig();
    await runRefresh(input);
  })().catch(() => { /* a background refresh has nobody to report to */ });
}
