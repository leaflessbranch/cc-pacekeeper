/**
 * The small, versioned boundary around Codex native facts and delivery.
 *
 * This module deliberately does not start Codex, resume a thread through a
 * second app server, or infer controls from hook names. A caller supplies an
 * existing-owner transport and receives an explicit result for every native
 * outcome, including unsupported and ambiguous outcomes.
 */

export const NATIVE_PROTOCOL_VERSION = '0.153.4';
export const QUEUE_ADD_METHOD = 'thread/queue/add';
export const RATE_LIMITS_READ_METHOD = 'account/rateLimits/read';

export type NativeCapability = 'supported' | 'unsupported' | 'unavailable';

export interface NativeCapabilities {
  protocolVersion: string;
  /** Whether the probed protocol equals the pinned acceptance target. */
  versionMatchesPin: boolean;
  queue: NativeCapability;
  accountRateLimits: NativeCapability;
  /**
   * The following three are permanently `unsupported`: the 0.153.4 protocol
   * exposes no method or `turn/start` parameter that disables tools, suppresses
   * an input before model work, or forces a persisted save before compaction.
   * They are named here so a caller must handle the gap explicitly rather than
   * assume a prompt instruction or a deny-all hook is enforcement.
   */
  toolDisable: NativeCapability;
  preModelSuppression: NativeCapability;
  saveBarrier: NativeCapability;
}

export interface QueueAddInput {
  threadId: string;
  message: string;
  clientUserMessageId: string;
}

export interface NativeTextInput {
  type: 'text';
  text: string;
}

export interface QueueAddRequest {
  method: typeof QUEUE_ADD_METHOD;
  params: {
    threadId: string;
    input: NativeTextInput[];
    clientUserMessageId: string;
  };
}

function requireOpaque(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  // IDs and messages cross a JSON-RPC boundary. Reject control characters so
  // logs and protocol framing cannot be confused by an untrusted value.
  if ([...value].some((char) => char.charCodeAt(0) < 0x20 && char !== '\n')) {
    throw new Error(`${name} contains a control character`);
  }
  return value;
}

export function buildQueueAddRequest(input: QueueAddInput): QueueAddRequest {
  return {
    method: QUEUE_ADD_METHOD,
    params: {
      threadId: requireOpaque(input.threadId, 'threadId'),
      input: [{ type: 'text', text: requireOpaque(input.message, 'message') }],
      clientUserMessageId: requireOpaque(input.clientUserMessageId, 'clientUserMessageId')
    }
  };
}

function methodSet(methods: readonly string[] | undefined): Set<string> {
  return new Set((methods ?? []).filter((method) => typeof method === 'string'));
}

export interface NativeSchemaProbe {
  version?: string;
  methods?: readonly string[];
}

/**
 * Report only controls established by the supplied native schema.
 *
 * A method list that was never obtained is `unavailable` (we did not look),
 * which is a different fact from `unsupported` (we looked and it is absent);
 * conflating them would let a failed probe read as a proved negative. A
 * protocol newer than the pin still reports its real methods, with the version
 * mismatch surfaced separately, because failing closed on any drift would
 * disable the queue on every future release.
 */
export function normalizeNativeCapabilities(probe: NativeSchemaProbe): NativeCapabilities {
  const version = typeof probe.version === 'string' && probe.version !== ''
    ? probe.version
    : 'unknown';
  const probed = probe.methods !== undefined;
  const methods = methodSet(probe.methods);
  const has = (method: string): NativeCapability => {
    if (!probed) return 'unavailable';
    return methods.has(method) ? 'supported' : 'unsupported';
  };
  return {
    protocolVersion: version,
    versionMatchesPin: version === NATIVE_PROTOCOL_VERSION,
    queue: has(QUEUE_ADD_METHOD),
    accountRateLimits: has(RATE_LIMITS_READ_METHOD),
    // Not probed: no such method exists in any published protocol version, so
    // probing for one would only invent a control surface.
    toolDisable: 'unsupported',
    preModelSuppression: 'unsupported',
    saveBarrier: 'unsupported'
  };
}

export interface NativeRateLimitWindow {
  usedPercent: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

export interface NativeRateLimitSnapshot {
  planType?: unknown;
  limitId?: unknown;
  limitName?: unknown;
  rateLimitReachedType?: unknown;
  primary?: NativeRateLimitWindow | null;
  secondary?: NativeRateLimitWindow | null;
  credits?: {
    hasCredits?: unknown;
    unlimited?: unknown;
    balance?: unknown;
  } | null;
  spendControlReached?: unknown;
  individualLimit?: {
    remainingPercent?: unknown;
    resetsAt?: unknown;
  } | null;
}

export type QuotaKind = 'five_hour' | 'weekly' | 'unknown';

export interface NormalizedQuotaBucket {
  id: string;
  kind: QuotaKind;
  label: string;
  /** `null` when the native reading was missing or malformed. Never 0. */
  usedPercent: number | null;
  durationMinutes: number | null;
  resetsAtMs: number | null;
  observedAtMs: number;
  valid: boolean;
}

export interface ParsedRateLimitSnapshot {
  planType: string | null;
  limitId: string | null;
  limitName: string | null;
  rateLimitReachedType: string | null;
  buckets: NormalizedQuotaBucket[];
  credits: {
    hasCredits: boolean | null;
    unlimited: boolean | null;
    balance: string | null;
  };
  spendControlReached: boolean | null;
  diagnostics: string[];
}

/**
 * The whole `account/rateLimits/read` reply: a backward-compatible
 * single-bucket view plus the multi-bucket map keyed by metered limit id.
 */
export interface ParsedRateLimitsResponse extends ParsedRateLimitSnapshot {
  accountId: string | null;
  byLimitId: Record<string, ParsedRateLimitSnapshot>;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Convert native seconds to milliseconds while leaving millisecond values intact. */
export function normalizeTimestampMs(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  return number < 1_000_000_000_000 ? Math.round(number * 1000) : Math.round(number);
}

function durationMinutes(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number <= 0 || !Number.isInteger(number)) return null;
  return number;
}

function percent(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0 || number > 100 || !Number.isInteger(number)) return null;
  return number;
}

function kindForDuration(duration: number | null): QuotaKind {
  if (duration === 300) return 'five_hour';
  if (duration === 10_080) return 'weekly';
  return 'unknown';
}

function bucketRank(bucket: NormalizedQuotaBucket): number {
  if (bucket.kind === 'five_hour') return 0;
  if (bucket.kind === 'weekly') return 1;
  return 2;
}

/**
 * Normalize the native primary/secondary windows by duration. Unknown windows
 * remain visible, and malformed windows remain visible as invalid diagnostics
 * rather than becoming a fabricated zero.
 */
export function parseRateLimitSnapshot(
  snapshot: NativeRateLimitSnapshot,
  observedAtMs: number
): ParsedRateLimitSnapshot {
  const diagnostics: string[] = [];
  const windows: Array<[string, NativeRateLimitWindow | null | undefined]> = [
    ['primary', snapshot.primary],
    ['secondary', snapshot.secondary]
  ];
  const buckets: NormalizedQuotaBucket[] = [];
  for (const [id, window] of windows) {
    if (window === null || window === undefined) continue;
    const used = percent(window.usedPercent);
    const duration = durationMinutes(window.windowDurationMins);
    const resetsAtMs = normalizeTimestampMs(window.resetsAt);
    const valid = used !== null;
    if (used === null) diagnostics.push(`${id}.usedPercent is missing or outside 0..100`);
    if (window.windowDurationMins !== undefined && window.windowDurationMins !== null && duration === null) {
      diagnostics.push(`${id}.windowDurationMins is invalid`);
    }
    if (window.resetsAt !== undefined && window.resetsAt !== null && resetsAtMs === null) {
      diagnostics.push(`${id}.resetsAt is invalid`);
    }
    buckets.push({
      id,
      kind: kindForDuration(duration),
      label: duration === 300 ? '5h' : duration === 10_080 ? 'weekly' : `${duration ?? 'unknown'}m`,
      // An unreadable percentage stays null. Substituting 0 would read as
      // "no usage" and authorize spending against a limit we cannot see.
      usedPercent: used,
      durationMinutes: duration,
      resetsAtMs,
      observedAtMs,
      valid
    });
  }
  buckets.sort((left, right) => bucketRank(left) - bucketRank(right) || left.id.localeCompare(right.id));

  const credits = snapshot.credits;
  const hasCredits = typeof credits?.hasCredits === 'boolean' ? credits.hasCredits : null;
  const unlimited = typeof credits?.unlimited === 'boolean' ? credits.unlimited : null;
  const balance = typeof credits?.balance === 'string' ? credits.balance : null;
  const spendControlReached = typeof snapshot.spendControlReached === 'boolean'
    ? snapshot.spendControlReached
    : null;
  const planType = typeof snapshot.planType === 'string' ? snapshot.planType : null;
  return {
    planType,
    limitId: typeof snapshot.limitId === 'string' ? snapshot.limitId : null,
    limitName: typeof snapshot.limitName === 'string' ? snapshot.limitName : null,
    rateLimitReachedType:
      typeof snapshot.rateLimitReachedType === 'string' ? snapshot.rateLimitReachedType : null,
    buckets,
    credits: { hasCredits, unlimited, balance },
    spendControlReached,
    diagnostics
  };
}

export interface NativeRateLimitsResponse {
  accountId?: unknown;
  rateLimits?: unknown;
  rateLimitsByLimitId?: unknown;
}

function isSnapshotObject(value: unknown): value is NativeRateLimitSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the full `account/rateLimits/read` reply. `rateLimits` is the
 * historical single-bucket view and is required by the schema; its absence is
 * a diagnostic rather than an empty success, because an empty bucket list is
 * indistinguishable from "no limits reached" to a naive caller.
 */
export function parseRateLimitsResponse(
  response: NativeRateLimitsResponse,
  observedAtMs: number
): ParsedRateLimitsResponse {
  const accountId = typeof response.accountId === 'string' ? response.accountId : null;
  const byLimitId: Record<string, ParsedRateLimitSnapshot> = {};
  const rawByLimitId = response.rateLimitsByLimitId;
  if (typeof rawByLimitId === 'object' && rawByLimitId !== null && !Array.isArray(rawByLimitId)) {
    for (const [limitId, snapshot] of Object.entries(rawByLimitId as Record<string, unknown>)) {
      if (!isSnapshotObject(snapshot)) continue;
      byLimitId[limitId] = parseRateLimitSnapshot(snapshot, observedAtMs);
    }
  }
  if (!isSnapshotObject(response.rateLimits)) {
    return {
      accountId,
      planType: null,
      limitId: null,
      limitName: null,
      rateLimitReachedType: null,
      buckets: [],
      credits: { hasCredits: null, unlimited: null, balance: null },
      spendControlReached: null,
      diagnostics: ['rateLimits is missing from the native response'],
      byLimitId
    };
  }
  return {
    accountId,
    ...parseRateLimitSnapshot(response.rateLimits, observedAtMs),
    byLimitId
  };
}

/**
 * `ThreadTokenUsage` separates `last` (the most recent turn, which is the
 * current context) from `total` (lifetime accumulation across the thread).
 * Using `total` as a context meter overstates usage without bound, so only
 * `last` is read here. `modelContextWindow` is nullable and there is no
 * Codex-side default to fall back on: Claude's 200,000-token assumption is not
 * a Codex truth, so a missing window leaves the percentage unknown.
 */
export interface ParsedThreadContext {
  currentTokens: number | null;
  contextWindow: number | null;
  usedPercent: number | null;
  cache: {
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
  };
  diagnostics: string[];
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0 || !Number.isInteger(number)) return null;
  return number;
}

export function parseThreadTokenUsage(usage: unknown): ParsedThreadContext {
  const diagnostics: string[] = [];
  const empty: ParsedThreadContext = {
    currentTokens: null,
    contextWindow: null,
    usedPercent: null,
    cache: { cachedInputTokens: null, cacheWriteInputTokens: null },
    diagnostics
  };
  if (typeof usage !== 'object' || usage === null) {
    diagnostics.push('thread token usage is missing');
    return empty;
  }
  const record = usage as Record<string, unknown>;
  const last = record['last'];
  if (typeof last !== 'object' || last === null) {
    diagnostics.push('thread token usage has no readable `last` turn breakdown');
    return empty;
  }
  const lastRecord = last as Record<string, unknown>;
  const currentTokens = nonNegativeInteger(lastRecord['totalTokens']);
  if (currentTokens === null) diagnostics.push('last.totalTokens is missing or invalid');
  const contextWindow = nonNegativeInteger(record['modelContextWindow']);
  if (contextWindow === null) diagnostics.push('modelContextWindow is unavailable');
  const usedPercent = currentTokens !== null && contextWindow !== null && contextWindow > 0
    ? Math.round((currentTokens / contextWindow) * 100)
    : null;
  return {
    currentTokens,
    contextWindow,
    usedPercent,
    cache: {
      // `cacheWriteInputTokens` is optional in the schema. Absent must read as
      // "not reported", never as a measured zero.
      cachedInputTokens: nonNegativeInteger(lastRecord['cachedInputTokens']),
      cacheWriteInputTokens: nonNegativeInteger(lastRecord['cacheWriteInputTokens'])
    },
    diagnostics
  };
}

export type CapacityClassification = 'included' | 'paid' | 'unknown' | 'unsupported';

/**
 * Credits being available says nothing about whether the next turn will spend
 * them. Only an authoritative spend-control transition can classify paid use.
 */
export function classifySubscriptionCapacity(
  parsed: Pick<ParsedRateLimitSnapshot, 'planType' | 'spendControlReached'> & {
    fresh: boolean;
    authenticated?: boolean;
    /** Recorded for diagnostics only; it never moves the classification. */
    creditsAvailable?: boolean | null;
  }
): CapacityClassification {
  if (parsed.authenticated === false) return 'unsupported';
  if (!parsed.fresh || parsed.planType === null) return 'unknown';
  if (parsed.spendControlReached === true) return 'paid';
  if (parsed.spendControlReached === false) return 'included';
  return 'unknown';
}

export interface ExistingOwnerRecord {
  ownerId: string;
  pid: number;
  accountId: string | null;
  threadIds: string[];
  activeThreadIds?: string[];
  socketPath?: string;
  protocolVersion: string;
}

export interface OwnerProbeRecord {
  ownerId?: unknown;
  pid?: unknown;
  accountId?: unknown;
  threadIds?: unknown;
  activeThreadIds?: unknown;
  socketPath?: unknown;
  protocolVersion?: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

export function parseOwnerRecord(record: OwnerProbeRecord): ExistingOwnerRecord | null {
  const ownerId = typeof record.ownerId === 'string' ? record.ownerId : null;
  const pid = finiteNumber(record.pid);
  if (ownerId === null || pid === null || !Number.isInteger(pid) || pid <= 0) return null;
  const protocolVersion = typeof record.protocolVersion === 'string' ? record.protocolVersion : 'unknown';
  return {
    ownerId,
    pid,
    accountId: typeof record.accountId === 'string' ? record.accountId : null,
    threadIds: stringList(record.threadIds),
    activeThreadIds: stringList(record.activeThreadIds),
    socketPath: typeof record.socketPath === 'string' ? record.socketPath : undefined,
    protocolVersion
  };
}

export type OwnerLookup =
  | { status: 'found'; owner: ExistingOwnerRecord }
  | { status: 'absent' | 'ambiguous' | 'unknown' };

export interface OwnerLookupInput {
  records: readonly OwnerProbeRecord[];
  threadId: string;
  accountId: string | null;
  /**
   * Required. There is no safe default: assuming liveness would treat a stale
   * record left behind by a dead process as a live delivery target, and a
   * caller that cannot check liveness genuinely does not know.
   */
  isAlive?: (pid: number) => boolean;
}

/** Find exactly one live, known-account owner for an existing thread. */
export function findExistingOwner(input: OwnerLookupInput): OwnerLookup {
  if (input.isAlive === undefined) return { status: 'unknown' };
  const isAlive = input.isAlive;
  const owners = input.records
    .map(parseOwnerRecord)
    .filter((owner): owner is ExistingOwnerRecord => owner !== null)
    .filter((owner) => owner.threadIds.includes(input.threadId))
    .filter((owner) => isAlive(owner.pid));
  if (owners.length === 0) return { status: 'absent' };
  if (input.accountId === null || owners.some((owner) => owner.accountId === null)) {
    return { status: 'unknown' };
  }
  const matching = owners.filter((owner) => owner.accountId === input.accountId);
  const only = matching[0];
  if (matching.length === 0 || only === undefined) return { status: 'absent' };
  if (matching.length > 1) return { status: 'ambiguous' };
  return { status: 'found', owner: only };
}

export interface NativeTransport {
  request(method: string, params: unknown): Promise<unknown>;
}

export type QueueDeliveryResult =
  | { status: 'accepted'; threadId: string; queuedSubmissionId: string; clientUserMessageId: string }
  | { status: 'unsupported' | 'unavailable' | 'ambiguous' | 'rejected'; reason: string; clientUserMessageId: string };

export interface ParsedQueuedSubmission {
  id: string;
  clientUserMessageId: string;
}

/**
 * `ThreadQueueAddResponse` requires a nested `queuedSubmission` object holding
 * `id`, `clientUserMessageId` and `input`. There is no flat submission id at
 * the top level, so a parser looking for one silently loses the identity that
 * later reconciliation depends on.
 */
export function parseQueuedSubmission(response: unknown): ParsedQueuedSubmission | null {
  if (typeof response !== 'object' || response === null) return null;
  const submission = (response as Record<string, unknown>)['queuedSubmission'];
  if (typeof submission !== 'object' || submission === null) return null;
  const record = submission as Record<string, unknown>;
  const id = record['id'];
  const clientUserMessageId = record['clientUserMessageId'];
  if (typeof id !== 'string' || id === '') return null;
  if (typeof clientUserMessageId !== 'string' || clientUserMessageId === '') return null;
  return { id, clientUserMessageId };
}

/**
 * The pinned CLI treats JSON-RPC -32601, and -32600 with the
 * experimental-required message, as "this server has no queue" rather than as
 * a failed delivery. That distinction matters: unsupported is a stable fact
 * about the owner, while a failed delivery may have been partially applied.
 */
function isUnsupportedQueueError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  // Method-not-found is unambiguous on its own.
  if (record.code === -32601) return true;
  // Invalid-request is only about the queue when the message names the method:
  // upstream matches the experimental-required text and the unknown-variant
  // text. Message matching stays gated on this code, never used on its own —
  // an error carrying no structured code is ambiguous, and treating it as a
  // stable "no queue here" fact would mask a real delivery failure.
  if (record.code === -32600) {
    return typeof record.message === 'string' && record.message.includes(QUEUE_ADD_METHOD);
  }
  return false;
}

export class NativeClient {
  public constructor(
    private readonly transport: NativeTransport,
    public readonly capabilities: NativeCapabilities,
    public readonly owner: ExistingOwnerRecord
  ) {}

  public async queueExistingThread(input: QueueAddInput): Promise<QueueDeliveryResult> {
    if (this.capabilities.queue !== 'supported') {
      return { status: 'unsupported', reason: 'thread/queue/add is not supported by the pinned owner', clientUserMessageId: input.clientUserMessageId };
    }
    let response: unknown;
    try {
      response = await this.transport.request(
        QUEUE_ADD_METHOD,
        buildQueueAddRequest(input).params
      );
    } catch (error) {
      if (isUnsupportedQueueError(error)) {
        return {
          status: 'unsupported',
          reason: 'the existing owner does not support thread/queue/add',
          clientUserMessageId: input.clientUserMessageId
        };
      }
      const reason = error instanceof Error ? error.message : 'native owner request failed';
      // A transport that timed out or dropped may still have delivered. That
      // is ambiguous, not failed, and must never authorize a fresh retry.
      const ambiguous = /timeout|timed out|disconnect|closed|reset|abort|EPIPE|ECONNRESET/i.test(reason);
      return {
        status: ambiguous ? 'ambiguous' : 'unavailable',
        reason,
        clientUserMessageId: input.clientUserMessageId
      };
    }
    const submission = parseQueuedSubmission(response);
    if (submission === null) {
      return {
        status: 'ambiguous',
        reason: 'owner returned no readable queuedSubmission',
        clientUserMessageId: input.clientUserMessageId
      };
    }
    if (submission.clientUserMessageId !== input.clientUserMessageId) {
      // The owner acknowledged a different message than the one we sent, so we
      // cannot correlate this submission with our own intent.
      return {
        status: 'ambiguous',
        reason: 'owner echoed a different clientUserMessageId',
        clientUserMessageId: input.clientUserMessageId
      };
    }
    return {
      status: 'accepted',
      threadId: input.threadId,
      queuedSubmissionId: submission.id,
      clientUserMessageId: input.clientUserMessageId
    };
  }

  public async request(method: string, params: unknown): Promise<unknown> {
    return this.transport.request(method, params);
  }
}
