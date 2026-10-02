#!/usr/bin/env bun
/** Bounded PostToolUse observer. It records facts, never raw prompts. */
import { parseRateLimitsResponse, parseThreadTokenUsage, type NativeRateLimitsResponse } from './native';
import { CodexStore, type StateIdentity } from './storage';
import { clientForExistingOwner } from './native-transport';
import { discoverNativeControlClient, findLiveOwner } from './live-sessions';
import { normalizeNativeCapabilities, type NativeClient } from './native';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  transcript_path?: unknown;
  /** Original timestamp of a validated rollout token-count observation. */
  token_usage_observed_at_ms?: unknown;
  /** Clear cached context after a validated compaction/model boundary. */
  token_usage_invalidated?: unknown;
  authenticated?: unknown;
  pending_work?: unknown;
  pendingWork?: unknown;
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value : null; }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : Date.now(); }

const MAX_ROLLOUT_READ_BYTES = 4 * 1024 * 1024;
const MAX_ROLLOUT_PREFIX_BYTES = 256 * 1024;

export interface RolloutTokenUsageObservation {
  tokenUsage: unknown | null;
  observedAtMs: number | null;
  invalidated: boolean;
}

function rolloutTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
    return milliseconds >= 0 ? milliseconds : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeRolloutTokenUsage(info: unknown): unknown | null {
  if (typeof info !== 'object' || info === null || Array.isArray(info)) return null;
  const row = info as Record<string, unknown>;
  const last = row['last_token_usage'];
  if (typeof last !== 'object' || last === null || Array.isArray(last)) return null;
  const lastRow = last as Record<string, unknown>;
  const totalTokens = nonNegativeInteger(lastRow['total_tokens']);
  const contextWindow = row['model_context_window'] === null
    ? null
    : nonNegativeInteger(row['model_context_window']);
  if (totalTokens === null) return null;
  if (row['model_context_window'] !== null && contextWindow === null) return null;
  const cachedInputTokens = lastRow['cached_input_tokens'];
  const cacheWriteInputTokens = lastRow['cache_write_input_tokens'];
  if (cachedInputTokens !== undefined && nonNegativeInteger(cachedInputTokens) === null) return null;
  if (cacheWriteInputTokens !== undefined && nonNegativeInteger(cacheWriteInputTokens) === null) return null;
  return {
    last: {
      totalTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens })
    },
    modelContextWindow: contextWindow
  };
}

function rolloutContents(file: string): string | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return null;
    const home = process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
    if (!pathIsAbsolute(home)) return null;
    const homeReal = realpathSync(home);
    const fileReal = realpathSync(file);
    const allowedRoots = [path.join(homeReal, 'sessions'), path.join(homeReal, 'archived_sessions')];
    if (!allowedRoots.some((root) => fileReal === root || fileReal.startsWith(root + path.sep))) return null;
    if (stat.size <= MAX_ROLLOUT_READ_BYTES) return readFileSync(file, 'utf8');
    const fd = openSync(file, 'r');
    try {
      const prefixLength = Math.min(MAX_ROLLOUT_PREFIX_BYTES, stat.size);
      const prefix = Buffer.alloc(prefixLength);
      const prefixRead = readSync(fd, prefix, 0, prefix.length, 0);
      const tailLength = Math.min(MAX_ROLLOUT_READ_BYTES - prefixRead, stat.size - prefixRead);
      const tailStart = stat.size - tailLength;
      const tail = Buffer.alloc(tailLength);
      const tailRead = tailLength === 0 ? 0 : readSync(fd, tail, 0, tail.length, tailStart);
      return `${prefix.subarray(0, prefixRead).toString('utf8')}\n${tail.subarray(0, tailRead).toString('utf8')}`;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Read only the bounded, structured token-count portion of a Codex rollout.
 * The timestamp belongs to the native event; using the read time would turn
 * an old transcript scan into a fresh context observation. A compaction or
 * turn boundary without a later valid token count invalidates the cache.
 */
export function readRolloutTokenUsage(file: string, nowMs: number, expectedThreadId?: string): RolloutTokenUsageObservation {
  const empty: RolloutTokenUsageObservation = { tokenUsage: null, observedAtMs: null, invalidated: false };
  if (!pathIsAbsolute(file)) return empty;
  const contents = rolloutContents(file);
  if (contents === null) return empty;
  let boundaryAtMs: number | null = null;
  let sawBoundary = false;
  let firstSessionMetaId: string | null = null;
  let sawSessionMeta = false;
  let latest: { tokenUsage: unknown; observedAtMs: number } | null = null;
  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try { record = JSON.parse(line) as unknown; } catch { continue; }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
    const row = record as Record<string, unknown>;
    const timestamp = rolloutTimestamp(row['timestamp']);
    if (timestamp === null || timestamp > nowMs) continue;
    const rowPayload = typeof row['payload'] === 'object' && row['payload'] !== null && !Array.isArray(row['payload'])
      ? row['payload'] as Record<string, unknown>
      : null;
    if (row['type'] === 'session_meta' && !sawSessionMeta) {
      sawSessionMeta = true;
      const candidate = rowPayload?.['id'] ?? rowPayload?.['session_id'] ?? row['id'] ?? row['session_id'];
      firstSessionMetaId = typeof candidate === 'string' && candidate.trim() !== '' ? candidate : null;
      continue;
    }
    if (row['type'] === 'compacted' || row['type'] === 'turn_context') {
      sawBoundary = true;
      boundaryAtMs = boundaryAtMs === null ? timestamp : Math.max(boundaryAtMs, timestamp);
      if (latest !== null && latest.observedAtMs <= timestamp) latest = null;
      continue;
    }
    const payload = rowPayload;
    if (row['type'] !== 'event_msg' || payload === null || typeof payload['type'] !== 'string') continue;
    const eventType = payload['type'];
    if (eventType === 'context_compacted' || eventType === 'turn_started' || eventType === 'task_started' || eventType === 'model_reroute' || eventType === 'session_configured') {
      sawBoundary = true;
      boundaryAtMs = boundaryAtMs === null ? timestamp : Math.max(boundaryAtMs, timestamp);
      if (latest !== null && latest.observedAtMs <= timestamp) latest = null;
      continue;
    }
    if (eventType !== 'token_count') continue;
    const tokenUsage = normalizeRolloutTokenUsage(payload['info']);
    if (tokenUsage === null) {
      // TokenCount info is optional in the native protocol. Once an unknown
      // count is newer than the cached one, retaining the old value would
      // manufacture a current context observation.
      if (latest === null || timestamp >= latest.observedAtMs) {
        sawBoundary = true;
        boundaryAtMs = boundaryAtMs === null ? timestamp : Math.max(boundaryAtMs, timestamp);
        if (latest !== null && latest.observedAtMs <= timestamp) latest = null;
      }
      continue;
    }
    if (boundaryAtMs !== null && timestamp <= boundaryAtMs) continue;
    if (latest === null || timestamp >= latest.observedAtMs) latest = { tokenUsage, observedAtMs: timestamp };
  }
  if (!sawSessionMeta || firstSessionMetaId === null || (expectedThreadId !== undefined && firstSessionMetaId !== expectedThreadId)) {
    return empty;
  }
  if (latest !== null) return { tokenUsage: latest.tokenUsage, observedAtMs: latest.observedAtMs, invalidated: false };
  return { tokenUsage: null, observedAtMs: null, invalidated: sawBoundary };
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith('/') && !value.includes('\u0000');
}

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
  const explicitOrdinaryPermission = parsedLimits !== null
    && typeof rawLimits === 'object'
    && rawLimits !== null
    && Object.prototype.hasOwnProperty.call(rawLimits, 'ordinaryUsageAllowed');
  // A fulfilled native call with an empty or malformed payload is not a fresh
  // quota/context observation. Keep the old clocks so a failed refresh cannot
  // turn stale values into an eligibility signal.
  const quotaObserved = parsedLimits !== null && (
    parsedLimits.buckets.length > 0
    || parsedLimits.rateLimitReachedType !== null
    || parsedLimits.spendControlReached !== null
    || Object.keys(parsedLimits.byLimitId).length > 0
  );
  // The 0.160 permission is independently authoritative. Persist both true
  // and false/null transitions even when the same response has no readable
  // quota buckets; do not advance quota freshness from that field alone.
  const rateLimitsObserved = quotaObserved || explicitOrdinaryPermission;
  const contextObserved = parsedUsage !== null && (
    parsedUsage.currentTokens !== null
    || parsedUsage.contextWindow !== null
    || parsedUsage.cache.cachedInputTokens !== null
    || parsedUsage.cache.cacheWriteInputTokens !== null
  );
  const suppliedUsageAt = typeof input.token_usage_observed_at_ms === 'number' && Number.isFinite(input.token_usage_observed_at_ms)
    ? input.token_usage_observed_at_ms
    : undefined;
  const contextObservedAtMs = suppliedUsageAt !== undefined && suppliedUsageAt <= nowMs && suppliedUsageAt >= 0
    ? suppliedUsageAt
    : nowMs;
  const invalidateContext = input.token_usage_invalidated === true && !contextObserved;
  const authObserved = typeof input.authenticated === 'boolean';
  const priorQuotaAt = typeof prior['quotaObservedAtMs'] === 'number' ? prior['quotaObservedAtMs'] : undefined;
  const priorOrdinaryPermissionAt = typeof prior['ordinaryUsageObservedAtMs'] === 'number' ? prior['ordinaryUsageObservedAtMs'] : undefined;
  const priorContextAt = typeof prior['contextObservedAtMs'] === 'number' ? prior['contextObservedAtMs'] : undefined;
  const priorAuthAt = typeof prior['authObservedAtMs'] === 'number' ? prior['authObservedAtMs'] : undefined;
  const observedTimes = [
    quotaObserved ? nowMs : priorQuotaAt,
    explicitOrdinaryPermission ? nowMs : priorOrdinaryPermissionAt,
    contextObserved ? contextObservedAtMs : priorContextAt,
    authObserved ? nowMs : priorAuthAt
  ].filter((value): value is number => value !== undefined);
  const lastObservedAtMs = observedTimes.length === 0 ? undefined : Math.max(...observedTimes);
  const next = {
    ...prior,
    accountId: identity.accountId,
    threadId: identity.threadId,
    ...(lastObservedAtMs === undefined ? {} : { lastObservedAtMs }),
    ...(quotaObserved ? { quotaObservedAtMs: nowMs } : {}),
    ...(explicitOrdinaryPermission ? { ordinaryUsageObservedAtMs: nowMs } : {}),
    ...(contextObserved ? { contextObservedAtMs: contextObservedAtMs } : {}),
    ...(authObserved ? { authObservedAtMs: nowMs } : {}),
    ...(event === 'PostToolUse' ? { lastActivityAtMs: nowMs, lastWorkAtMs: nowMs, lastToolActivityAtMs: nowMs } : {}),
    ...(typeof input.pending_work === 'boolean' ? { pendingWork: input.pending_work } : typeof input.pendingWork === 'boolean' ? { pendingWork: input.pendingWork } : {}),
    ...(rateLimitsObserved && parsedLimits ? { rateLimits: parsedLimits } : {}),
    ...(contextObserved && parsedUsage ? { tokenUsage: parsedUsage } : {}),
    // A fresh native account read that says "unknown" must clear the old
    // boolean, but it must not advance auth freshness until a boolean is read.
    ...(input.authenticated === null || typeof input.authenticated === 'boolean' ? { authenticated: input.authenticated } : {})
  } as Record<string, unknown>;
  if (invalidateContext) {
    delete next['contextObservedAtMs'];
    delete next['tokenUsage'];
  }
  store.write(identity, 'timeline', next);
  return identity;
}

/** Refresh through the already selected owner. A failed request writes no fake zeros. */
export async function refreshFromOwner(
  client: Pick<NativeClient, 'readRateLimits'> & Partial<Pick<NativeClient, 'readAccount'>>,
  identity: { accountId: string | null; threadId: string },
  store = new CodexStore(),
  options: { tokenUsage?: unknown; tokenUsageObservedAtMs?: number; tokenUsageInvalidated?: boolean; authenticated?: boolean; nowMs?: number } = {}
): Promise<StateIdentity | null> {
  try {
    const [rateLimitsResult, accountResult] = await Promise.allSettled([
      client.readRateLimits(),
      client.readAccount?.()
    ]);
    const accountValue = accountResult.status === 'fulfilled' ? accountResult.value : undefined;
    const accountObserved = typeof client.readAccount === 'function' && accountValue !== undefined;
    if (rateLimitsResult.status !== 'fulfilled') {
      // Authentication is an independent native fact. If quota acquisition
      // fails during logout/account switching, persist the fulfilled
      // account/read result so a stale authenticated=true cannot authorize a
      // later service pass. No quota clock is advanced in this branch.
      if (!accountObserved || accountValue === undefined) return null;
      const authenticated = options.authenticated ?? accountValue.authenticated;
      return refreshObservations({
        hook_event_name: 'native-auth-refresh',
        thread_id: identity.threadId,
        account_id: identity.accountId ?? undefined,
        now_ms: options.nowMs ?? Date.now(),
        authenticated,
        ...(options.tokenUsageObservedAtMs === undefined ? {} : { token_usage_observed_at_ms: options.tokenUsageObservedAtMs }),
        ...(options.tokenUsageInvalidated === true ? { token_usage_invalidated: true } : {})
      }, store);
    }
    const rateLimits = rateLimitsResult.value;
    if (identity.accountId !== null && rateLimits.accountId !== identity.accountId) return null;
    const accountAuthenticated = accountObserved && accountValue !== undefined
      ? accountValue.authenticated ?? null
      : null;
    const authenticated = options.authenticated ?? accountAuthenticated;
    return refreshObservations({
      hook_event_name: 'native-refresh',
      thread_id: identity.threadId,
      account_id: identity.accountId ?? undefined,
      now_ms: options.nowMs ?? Date.now(),
      rateLimits,
      ...(options.tokenUsage === undefined ? {} : { tokenUsage: options.tokenUsage }),
      ...(options.tokenUsageObservedAtMs === undefined ? {} : { token_usage_observed_at_ms: options.tokenUsageObservedAtMs }),
      ...(options.tokenUsageInvalidated === true ? { token_usage_invalidated: true } : {}),
      authenticated
    }, store);
  } catch { return null; }
}

async function refreshThroughExistingOwner(input: RefreshInput, store: CodexStore): Promise<void> {
  const threadId = text(input.thread_id) ?? text(input.session_id);
  if (threadId === null) return;
  const rollout = text(input.transcript_path) === null
    ? null
    : readRolloutTokenUsage(text(input.transcript_path) as string, number(input.now_ms), threadId);
  const suppliedTokenUsage = input.tokenUsage ?? input.token_usage;
  const observedTokenUsage = suppliedTokenUsage ?? rollout?.tokenUsage ?? undefined;
  const observedTokenUsageAtMs = rollout?.observedAtMs ?? undefined;
  // An account id returned by the rate-limit read is an evidenced identity
  // source. It is safe to use for owner selection; an absent id remains
  // unknown and cannot authorize a live owner.
  const suppliedLimits = input.rateLimits ?? input.rate_limits;
  const observedLimits = suppliedLimits && typeof suppliedLimits === 'object'
    ? parseRateLimitsResponse(suppliedLimits as NativeRateLimitsResponse, number(input.now_ms))
    : null;
  const accountId = text(input.account_id) ?? observedLimits?.accountId ?? null;
  const lookup = findLiveOwner(threadId, accountId);
  let client: NativeClient | null = null;
  if (lookup.status === 'found' && lookup.owner !== undefined && lookup.owner.methods !== undefined) {
    const capabilities = normalizeNativeCapabilities({ version: lookup.owner.protocolVersion, methods: lookup.owner.methods });
    client = clientForExistingOwner(lookup.owner, capabilities, 750);
  } else if (lookup.status === 'absent' || lookup.status === 'unknown') {
    // Current Codex publishes an app-server control socket rather than the
    // package-owned registry. Probe that actual endpoint and verify that the
    // requested thread is loaded before using it.
    client = await discoverNativeControlClient(threadId, accountId);
  }
  if (client === null) return;
  const ownerAccountId = lookup.status === 'found' ? lookup.owner?.accountId ?? null : null;
  await refreshFromOwner(client, { accountId: accountId ?? ownerAccountId, threadId }, store, {
    ...(observedTokenUsage === undefined ? {} : { tokenUsage: observedTokenUsage }),
    ...(observedTokenUsageAtMs === undefined ? {} : { tokenUsageObservedAtMs: observedTokenUsageAtMs }),
    ...(rollout?.invalidated === true && observedTokenUsage === undefined ? { tokenUsageInvalidated: true } : {}),
    ...(typeof input.authenticated === 'boolean' ? { authenticated: input.authenticated } : {})
  });
}

async function main(): Promise<void> {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as RefreshInput;
    const store = new CodexStore();
    const transcriptPath = text(input.transcript_path);
    const threadId = text(input.thread_id) ?? text(input.session_id) ?? undefined;
    const rollout = transcriptPath === null ? null : readRolloutTokenUsage(transcriptPath, number(input.now_ms), threadId);
    const suppliedTokenUsage = input.tokenUsage ?? input.token_usage;
    const observedTokenUsage = suppliedTokenUsage ?? rollout?.tokenUsage ?? undefined;
    refreshObservations({
      ...input,
      ...(observedTokenUsage === undefined ? {} : { tokenUsage: observedTokenUsage }),
      ...(rollout?.observedAtMs === null || rollout?.observedAtMs === undefined ? {} : { token_usage_observed_at_ms: rollout.observedAtMs }),
      ...(rollout?.invalidated === true && observedTokenUsage === undefined ? { token_usage_invalidated: true } : {})
    }, store);
    // Native reads are bounded by the selected existing owner's transport. A
    // missing or untrusted owner leaves the cached hook observation intact and
    // never starts a second server or invents fresh values.
    await refreshThroughExistingOwner(input, store);
  } catch { /* hooks remain inert when input or state is unavailable */ }
  process.stdout.write('{}\n');
}

if (import.meta.main) main();
