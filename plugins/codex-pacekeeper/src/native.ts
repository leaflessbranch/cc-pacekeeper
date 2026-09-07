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
export const QUEUE_DELETE_METHOD = 'thread/queue/delete';
export const QUEUE_LIST_METHOD = 'thread/queue/list';
export const ACCOUNT_READ_METHOD = 'account/read';
export const RATE_LIMITS_READ_METHOD = 'account/rateLimits/read';

export type NativeCapability = 'supported' | 'unsupported' | 'unavailable';

export interface NativeCapabilities {
  protocolVersion: string;
  /** Whether the probed protocol equals the pinned acceptance target. */
  versionMatchesPin: boolean;
  queue: NativeCapability;
  /** Queue deletion is a separate native fact; it does not imply atomic
   * suppression before a model starts. Kept optional for compatibility with
   * older serialized capability records. */
  queueDelete?: NativeCapability;
  /** Queue listing is needed for crash reconciliation; acceptance alone does
   * not prove that a submission completed or never ran. */
  queueList?: NativeCapability;
  /** Account identity/auth mode is an observed native fact, not an env hint. */
  accountRead?: NativeCapability;
  accountRateLimits: NativeCapability;
  /**
   * The following three are `unsupported` for the pinned 0.153.4 protocol:
   * it exposes no method or `turn/start` parameter that disables tools,
   * suppresses an input before model work, or forces a persisted save before
   * compaction. They are named here so a caller must handle the gap explicitly
   * rather than assume a prompt instruction or a deny-all hook is enforcement.
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
  const result: NativeCapabilities = {
    protocolVersion: version,
    versionMatchesPin: version === NATIVE_PROTOCOL_VERSION,
    queue: has(QUEUE_ADD_METHOD),
    accountRateLimits: has(RATE_LIMITS_READ_METHOD),
    // Not probed: no such method exists in the pinned protocol, so probing for
    // one would only invent a control surface for this acceptance target.
    toolDisable: 'unsupported',
    preModelSuppression: 'unsupported',
    saveBarrier: 'unsupported'
  };
  // Keep this optional property non-enumerable so existing consumers that
  // compare the original capability record byte-for-byte remain compatible,
  // while native-aware callers can still distinguish queue deletion from the
  // unsupported pre-model suppression guarantee.
  Object.defineProperty(result, 'queueDelete', {
    value: has(QUEUE_DELETE_METHOD),
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(result, 'queueList', {
    value: has(QUEUE_LIST_METHOD),
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(result, 'accountRead', {
    value: has(ACCOUNT_READ_METHOD),
    enumerable: false,
    writable: false,
    configurable: false
  });
  return result;
}

export type NativeAccountKind = 'chatgpt' | 'apiKey' | 'amazonBedrock' | 'unknown';

/** Sanitized account/read facts used to gate subscription-only automation. */
export interface ParsedAccount {
  kind: NativeAccountKind;
  /** `null` means account/read did not establish an authentication mode. */
  authenticated: boolean | null;
  planType: string | null;
  requiresOpenaiAuth: boolean | null;
  diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the pinned GetAccountResponse without retaining email or credentials.
 * API-key and Bedrock accounts are real account modes, but they are not
 * subscription accounts and therefore deliberately report `authenticated:
 * false` to the subscription gate. A malformed or missing account remains
 * unknown, rather than becoming an unauthenticated assertion by accident.
 */
export function parseAccountResponse(response: unknown): ParsedAccount {
  const diagnostics: string[] = [];
  const empty: ParsedAccount = {
    kind: 'unknown',
    authenticated: null,
    planType: null,
    requiresOpenaiAuth: null,
    diagnostics
  };
  if (!isRecord(response)) {
    diagnostics.push('native account response is not an object');
    return empty;
  }
  const requiresOpenaiAuth = typeof response['requiresOpenaiAuth'] === 'boolean'
    ? response['requiresOpenaiAuth']
    : null;
  if (requiresOpenaiAuth === null) diagnostics.push('requiresOpenaiAuth is missing or invalid');
  const accountValue = response['account'];
  if (accountValue === null) {
    diagnostics.push('native account is unauthenticated');
    return { ...empty, authenticated: false, requiresOpenaiAuth };
  }
  if (accountValue === undefined) {
    diagnostics.push('native account was not observed');
    return { ...empty, requiresOpenaiAuth };
  }
  if (!isRecord(accountValue)) {
    diagnostics.push('native account has an invalid shape');
    return { ...empty, requiresOpenaiAuth };
  }
  const type = accountValue['type'];
  if (type === 'chatgpt') {
    const planType = typeof accountValue['planType'] === 'string' ? accountValue['planType'] : null;
    if (planType === null) diagnostics.push('ChatGPT account planType is missing or invalid');
    return { kind: 'chatgpt', authenticated: true, planType, requiresOpenaiAuth, diagnostics };
  }
  if (type === 'apiKey' || type === 'amazonBedrock') {
    return { kind: type, authenticated: false, planType: null, requiresOpenaiAuth, diagnostics: [
      `native account type ${type} is outside subscription automation`
    ] };
  }
  diagnostics.push('native account type is unknown');
  return { ...empty, requiresOpenaiAuth };
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

function isParsedRateLimitsResponse(value: unknown): value is ParsedRateLimitsResponse {
  if (!isRecord(value)) return false;
  return Array.isArray(value['buckets'])
    && Array.isArray(value['diagnostics'])
    && isRecord(value['credits'])
    && isRecord(value['byLimitId']);
}

/**
 * Parse the full `account/rateLimits/read` reply. `rateLimits` is the
 * historical single-bucket view and is required by the schema; its absence is
 * a diagnostic rather than an empty success, because an empty bucket list is
 * indistinguishable from "no limits reached" to a naive caller.
 */
export function parseRateLimitsResponse(
  response: NativeRateLimitsResponse | unknown,
  observedAtMs: number
): ParsedRateLimitsResponse {
  if (!isSnapshotObject(response)) {
    return {
      accountId: null,
      planType: null,
      limitId: null,
      limitName: null,
      rateLimitReachedType: null,
      buckets: [],
      credits: { hasCredits: null, unlimited: null, balance: null },
      spendControlReached: null,
      diagnostics: ['native rate-limit response is not an object'],
      byLimitId: {}
    };
  }
  // NativeClient returns this normalized shape so downstream fact assembly and
  // refresh can share one parser. Preserve it instead of treating it as a raw
  // wire response and reporting a missing `rateLimits` field.
  if (isParsedRateLimitsResponse(response)) return response;
  const responseRecord = response as NativeRateLimitsResponse;
  const accountId = typeof responseRecord.accountId === 'string' && responseRecord.accountId.trim() !== ''
    ? responseRecord.accountId
    : null;
  const byLimitId: Record<string, ParsedRateLimitSnapshot> = {};
  const rawByLimitId = responseRecord.rateLimitsByLimitId;
  if (typeof rawByLimitId === 'object' && rawByLimitId !== null && !Array.isArray(rawByLimitId)) {
    for (const [limitId, snapshot] of Object.entries(rawByLimitId as Record<string, unknown>)) {
      if (!isSnapshotObject(snapshot)) continue;
      byLimitId[limitId] = parseRateLimitSnapshot(snapshot, observedAtMs);
    }
  }
  if (!isSnapshotObject(responseRecord.rateLimits)) {
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
    ...parseRateLimitSnapshot(responseRecord.rateLimits, observedAtMs),
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

// This is the plan enum observed in the pinned protocol. `free`, `go`, and
// `unknown` are deliberately excluded from the subscription-only automation
// path. Keeping the allow-list here prevents a future backend label from being
// treated as included merely because a boolean happened to be false.
const SUBSCRIPTION_PLANS: ReadonlySet<string> = new Set([
  'plus',
  'pro',
  'prolite',
  'team',
  'self_serve_business_prolite',
  'business',
  'ent26',
  'enterprise_cbp_automation',
  'enterprise',
  'edu',
  'edu_plus',
  'edu_pro'
]);

const PAID_REACHED_REASONS: ReadonlySet<string> = new Set([
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached'
]);

/**
 * Credits being available says nothing about whether the next turn will spend
 * them. An authoritative spend-control transition can classify paid use, but
 * the inverse (`false`) is not an included-capacity promise; that requires a
 * separate authoritative observation.
 */
export function classifySubscriptionCapacity(
  parsed: Pick<ParsedRateLimitSnapshot, 'planType' | 'spendControlReached'> & {
    rateLimitReachedType?: string | null;
    fresh: boolean;
    /**
     * A separate, authoritative included-capacity observation. The pinned
     * rate-limit schema does not provide one; `spendControlReached: false`
     * only says that this backend control is not currently reached and must
     * not be promoted into a spending promise.
     */
    includedCapacity?: boolean | null;
    authenticated?: boolean;
    /** Recorded for diagnostics only; it never moves the classification. */
    creditsAvailable?: boolean | null;
  }
): CapacityClassification {
  // A rate-limit payload can be present while the local authentication state
  // is unavailable.  That is not proof that this process is using a supported
  // subscription session, so unknown authentication must stay fail-closed just
  // like an explicitly unsupported login.
  if (parsed.authenticated !== true) return parsed.authenticated === false ? 'unsupported' : 'unknown';
  if (!parsed.fresh || parsed.planType === null) return 'unknown';
  if (!SUBSCRIPTION_PLANS.has(parsed.planType)) return 'unknown';
  if (parsed.rateLimitReachedType !== undefined && parsed.rateLimitReachedType !== null) {
    if (PAID_REACHED_REASONS.has(parsed.rateLimitReachedType)) return 'paid';
    // A reached limit or a future backend reason is not evidence that the
    // next turn is included. Keep both the known rate-limit state and drift
    // fail-closed until a fresh, authoritative snapshot clears it.
    return 'unknown';
  }
  if (parsed.spendControlReached === true) return 'paid';
  if (parsed.includedCapacity === true) return 'included';
  return 'unknown';
}

export interface ExistingOwnerRecord {
  ownerId: string;
  pid: number;
  accountId: string | null;
  threadIds: string[];
  activeThreadIds?: string[];
  /** Native owner registries may call this field `endpoint`; normalize it to
   * socketPath at the boundary so the transport never guesses a target. */
  socketPath?: string;
  endpoint?: string;
  /** Optional working-directory provenance published by the owner registry. */
  cwd?: string;
  methods?: string[];
  protocolVersion: string;
}

export interface OwnerProbeRecord {
  ownerId?: unknown;
  pid?: unknown;
  accountId?: unknown;
  threadIds?: unknown;
  activeThreadIds?: unknown;
  socketPath?: unknown;
  endpoint?: unknown;
  cwd?: unknown;
  methods?: unknown;
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
  const activeThreadIds = record.activeThreadIds === undefined ? undefined : stringList(record.activeThreadIds);
  const threadIds = stringList(record.threadIds);
  if (threadIds.length === 0) return null;
  return {
    ownerId,
    pid,
    accountId: typeof record.accountId === 'string' && record.accountId.trim() !== '' ? record.accountId : null,
    threadIds,
    ...(activeThreadIds === undefined ? {} : { activeThreadIds }),
    socketPath: typeof record.socketPath === 'string'
      ? record.socketPath
      : typeof record.endpoint === 'string' ? record.endpoint : undefined,
    ...(typeof record.cwd === 'string' && record.cwd !== '' ? { cwd: record.cwd } : {}),
    ...(Array.isArray(record.methods) ? { methods: record.methods.filter((method): method is string => typeof method === 'string') } : {}),
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
    .filter((owner) => owner.activeThreadIds === undefined || owner.activeThreadIds.length === 0 || owner.activeThreadIds.includes(input.threadId))
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

/** Parse the pinned `ThreadQueueListResponse.data` array. */
export function parseQueueListResponse(response: unknown): ParsedQueuedSubmission[] {
  if (typeof response !== 'object' || response === null) return [];
  const data = (response as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => parseQueuedSubmission(item) ?? parseQueuedSubmission({ queuedSubmission: item }))
    .filter((item): item is ParsedQueuedSubmission => item !== null);
}

export type QueueDeleteResult =
  | { status: 'deleted'; threadId: string; queuedSubmissionId: string }
  | { status: 'unsupported' | 'unavailable' | 'ambiguous' | 'rejected'; reason: string; threadId: string; queuedSubmissionId: string };

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
    if (!this.owner.threadIds.includes(input.threadId)) {
      return { status: 'rejected', reason: 'the selected owner does not hold this thread', clientUserMessageId: input.clientUserMessageId };
    }
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

  /**
   * List queue entries by exact thread. This is useful for reconciliation and
   * cancellation, but an empty list never proves that a prior ambiguous input
   * did not execute.
   */
  public async listQueuedSubmissions(threadId: string): Promise<unknown> {
    if (!this.owner.threadIds.includes(threadId)) {
      throw new Error('the selected owner does not hold this thread');
    }
    // Older serialized capability records may omit the optional field. An
    // omitted probe is unavailable, never permission to guess that listing
    // works and issue a request anyway.
    const capability = this.capabilities.queueList ?? 'unavailable';
    if (capability !== 'supported') {
      throw new Error(`thread/queue/list is ${capability}`);
    }
    return this.transport.request(QUEUE_LIST_METHOD, { threadId });
  }

  /**
   * Request native deletion of a queued submission. The method is a best-effort
   * cancellation acknowledgement only; it does not establish that execution
   * could not already have begun, which is why preModelSuppression remains
   * explicitly unsupported.
   */
  public async deleteQueuedSubmission(threadId: string, queuedSubmissionId: string): Promise<QueueDeleteResult> {
    const capability = this.capabilities.queueDelete;
    if (capability !== 'supported') {
      return {
        status: capability === 'unsupported' ? 'unsupported' : 'unavailable',
        reason: 'thread/queue/delete is not established on the existing owner',
        threadId,
        queuedSubmissionId
      };
    }
    if (!this.owner.threadIds.includes(threadId)) {
      return { status: 'rejected', reason: 'the selected owner does not hold this thread', threadId, queuedSubmissionId };
    }
    if (queuedSubmissionId.trim() === '') {
      return { status: 'rejected', reason: 'queuedSubmissionId must be non-empty', threadId, queuedSubmissionId };
    }
    let response: unknown;
    try {
      response = await this.transport.request(QUEUE_DELETE_METHOD, { threadId, queuedSubmissionId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'native queue deletion failed';
      const ambiguous = /timeout|timed out|disconnect|closed|reset|abort|EPIPE|ECONNRESET/i.test(reason);
      return { status: ambiguous ? 'ambiguous' : 'unavailable', reason, threadId, queuedSubmissionId };
    }
    if (typeof response !== 'object' || response === null || (response as Record<string, unknown>)['deleted'] !== true) {
      return { status: 'rejected', reason: 'owner did not acknowledge queued deletion', threadId, queuedSubmissionId };
    }
    return { status: 'deleted', threadId, queuedSubmissionId };
  }

  /** Read account/auth mode without copying email, tokens or other credentials. */
  public async readAccount(): Promise<ParsedAccount> {
    const capability = this.capabilities.accountRead;
    if (capability !== 'supported') {
      throw new Error(`account/read is ${capability ?? 'unavailable'}`);
    }
    const response = await this.transport.request(ACCOUNT_READ_METHOD, {});
    return parseAccountResponse(response);
  }

  /** Read quota facts from the selected owner without copying credentials. */
  public async readRateLimits(): Promise<ParsedRateLimitsResponse> {
    if (this.capabilities.accountRateLimits !== 'supported') {
      throw new Error(`account/rateLimits/read is ${this.capabilities.accountRateLimits}`);
    }
    const response = await this.transport.request(RATE_LIMITS_READ_METHOD, {});
    return parseRateLimitsResponse(response as NativeRateLimitsResponse, Date.now());
  }
}
