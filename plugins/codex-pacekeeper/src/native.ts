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
  queue: NativeCapability;
  accountRateLimits: NativeCapability;
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
 * Report only controls established by the supplied native schema. In
 * particular, `turn/start` does not imply a no-tools switch, and a hook does
 * not imply pre-model suppression or a persisted save barrier.
 */
export function normalizeNativeCapabilities(probe: NativeSchemaProbe): NativeCapabilities {
  const methods = methodSet(probe.methods);
  const version = typeof probe.version === 'string' && probe.version !== ''
    ? probe.version
    : 'unknown';
  const exactVersion = version === NATIVE_PROTOCOL_VERSION;
  return {
    protocolVersion: version,
    queue: exactVersion && methods.has(QUEUE_ADD_METHOD) ? 'supported' : 'unsupported',
    accountRateLimits: exactVersion && methods.has(RATE_LIMITS_READ_METHOD) ? 'supported' : 'unsupported',
    toolDisable: methods.has('turn/start/tools-disabled') ? 'supported' : 'unsupported',
    preModelSuppression: methods.has('turn/input/suppress') ? 'supported' : 'unsupported',
    saveBarrier: methods.has('turn/compact/save-barrier') ? 'supported' : 'unsupported'
  };
}

export interface NativeRateLimitWindow {
  usedPercent: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

export interface NativeRateLimitSnapshot {
  planType?: unknown;
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
  usedPercent: number;
  durationMinutes: number | null;
  resetsAtMs: number | null;
  observedAtMs: number;
  valid: boolean;
}

export interface ParsedRateLimitSnapshot {
  planType: string | null;
  buckets: NormalizedQuotaBucket[];
  credits: {
    hasCredits: boolean | null;
    unlimited: boolean | null;
    balance: string | null;
  };
  spendControlReached: boolean | null;
  diagnostics: string[];
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
    if (window.windowDurationMins !== undefined && duration === null) {
      diagnostics.push(`${id}.windowDurationMins is invalid`);
    }
    if (window.resetsAt !== undefined && resetsAtMs === null) {
      diagnostics.push(`${id}.resetsAt is invalid`);
    }
    buckets.push({
      id,
      kind: kindForDuration(duration),
      label: duration === 300 ? '5h' : duration === 10_080 ? 'weekly' : `${duration ?? 'unknown'}m`,
      usedPercent: used ?? 0,
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
    buckets,
    credits: { hasCredits, unlimited, balance },
    spendControlReached,
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
  isAlive?: (pid: number) => boolean;
}

/** Find exactly one live, known-account owner for an existing thread. */
export function findExistingOwner(input: OwnerLookupInput): OwnerLookup {
  const isAlive = input.isAlive ?? (() => true);
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
  if (matching.length !== 1) return matching.length === 0 ? { status: 'absent' } : { status: 'ambiguous' };
  return { status: 'found', owner: matching[0] };
}

export interface NativeTransport {
  request(method: string, params: unknown): Promise<unknown>;
}

export type QueueDeliveryResult =
  | { status: 'accepted'; threadId: string; queuedSubmissionId: string | null; clientUserMessageId: string }
  | { status: 'unsupported' | 'unavailable' | 'ambiguous' | 'rejected'; reason: string; clientUserMessageId: string };

function responseString(response: unknown, keys: string[]): string | null {
  if (typeof response !== 'object' || response === null) return null;
  const object = response as Record<string, unknown>;
  for (const key of keys) {
    if (typeof object[key] === 'string' && object[key] !== '') return object[key];
  }
  return null;
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
      const reason = error instanceof Error ? error.message : 'native owner request failed';
      const ambiguous = /timeout|timed out|disconnect|closed|unknown|reset/i.test(reason);
      return {
        status: ambiguous ? 'ambiguous' : 'unavailable',
        reason,
        clientUserMessageId: input.clientUserMessageId
      };
    }
    const queuedSubmissionId = responseString(response, ['queuedSubmissionId', 'id', 'submissionId']);
    if (response === null || response === undefined) {
      return { status: 'ambiguous', reason: 'owner accepted no inspectable response', clientUserMessageId: input.clientUserMessageId };
    }
    return {
      status: 'accepted',
      threadId: input.threadId,
      queuedSubmissionId,
      clientUserMessageId: input.clientUserMessageId
    };
  }

  public async request(method: string, params: unknown): Promise<unknown> {
    return this.transport.request(method, params);
  }
}
