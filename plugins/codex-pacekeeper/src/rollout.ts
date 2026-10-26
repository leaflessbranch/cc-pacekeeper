/**
 * Bounded reader for the Codex rollout file a hook names in `transcript_path`.
 *
 * The rollout is the hook's cheapest source of truth: its first line is the
 * thread's `session_meta` (own id, parent thread, creating account), and every
 * model response appends a `token_count` event carrying both the current-turn
 * token usage and the account's rate-limit snapshot. Reading the head and a
 * bounded tail answers context, quota and parentage without a native socket,
 * the same way the Claude adapter reads its transcript on the hot path.
 *
 * Token usage stays valid across turns: only a compaction (or an explicitly
 * unknown token count) changes the context it describes, so those are the
 * only invalidating boundaries. A turn start is not one.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { NativeRateLimitsResponse } from './native';

const HEAD_BYTES = 64 * 1024;
const TAIL_STEPS = [256 * 1024, 4 * 1024 * 1024];

export interface RolloutMeta {
  threadId: string;
  /** Root thread of the agent tree; equals threadId on the root. */
  sessionId: string | null;
  parentThreadId: string | null;
  /** ChatGPT account selected when the thread was created. */
  creatorAccountId: string | null;
}

export interface RolloutReading {
  meta: RolloutMeta | null;
  /** Normalized `{ last, modelContextWindow }`, or null when unknown. */
  tokenUsage: unknown | null;
  tokenUsageObservedAtMs: number | null;
  /** Converted to the native v2 response shape `parseRateLimitsResponse` reads. */
  rateLimits: NativeRateLimitsResponse | null;
  rateLimitsObservedAtMs: number | null;
  /** A compaction is newer than the newest token count. */
  compactedSinceUsage: boolean;
}

const EMPTY: RolloutReading = {
  meta: null,
  tokenUsage: null,
  tokenUsageObservedAtMs: null,
  rateLimits: null,
  rateLimitsObservedAtMs: null,
  compactedSinceUsage: false
};

function codexHome(): string {
  return process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
}

/** Only rollouts under the Codex home are read; a hook payload is untrusted. */
function allowedRollout(file: string): string | null {
  if (!path.isAbsolute(file) || file.includes('\u0000')) return null;
  try {
    const home = realpathSync(codexHome());
    const real = realpathSync(file);
    const roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
    return roots.some((root) => real.startsWith(root + path.sep)) ? real : null;
  } catch {
    return null;
  }
}

function readRange(fd: number, start: number, length: number): string {
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, read).toString('utf8');
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** `TokenUsageInfo` → the `{ last, modelContextWindow }` shape facts.ts parses. */
export function normalizeRolloutTokenUsage(info: unknown): unknown | null {
  const row = record(info);
  const last = record(row?.['last_token_usage']);
  if (row === null || last === null) return null;
  const totalTokens = nonNegativeInteger(last['total_tokens']);
  if (totalTokens === null) return null;
  const window = row['model_context_window'];
  const contextWindow = window === null || window === undefined ? null : nonNegativeInteger(window);
  if (window !== null && window !== undefined && contextWindow === null) return null;
  const cached = nonNegativeInteger(last['cached_input_tokens']);
  const cacheWrite = nonNegativeInteger(last['cache_write_input_tokens']);
  return {
    last: {
      totalTokens,
      ...(cached === null ? {} : { cachedInputTokens: cached }),
      ...(cacheWrite === null ? {} : { cacheWriteInputTokens: cacheWrite })
    },
    modelContextWindow: contextWindow
  };
}

function convertWindow(value: unknown): Record<string, unknown> | null {
  const window = record(value);
  if (window === null) return null;
  const used = typeof window['used_percent'] === 'number' && Number.isFinite(window['used_percent'])
    ? Math.round(window['used_percent'])
    : null;
  return {
    usedPercent: used,
    windowDurationMins: window['window_minutes'] ?? null,
    resetsAt: window['resets_at'] ?? null
  };
}

/** Protocol `RateLimitSnapshot` (snake_case) → the v2 response shape. */
export function convertRolloutRateLimits(value: unknown): NativeRateLimitsResponse | null {
  const snapshot = record(value);
  if (snapshot === null) return null;
  const limitId = text(snapshot['limit_id']) ?? 'codex';
  // Model-scoped buckets arrive as their own snapshots; only the account's
  // default bucket describes the five-hour and weekly windows pacing reads.
  if (limitId !== 'codex') return null;
  const credits = record(snapshot['credits']);
  return {
    rateLimits: {
      limitId,
      limitName: snapshot['limit_name'] ?? null,
      primary: convertWindow(snapshot['primary']),
      secondary: convertWindow(snapshot['secondary']),
      credits: credits === null ? null : { hasCredits: credits['has_credits'], unlimited: credits['unlimited'], balance: credits['balance'] ?? null },
      spendControlReached: snapshot['spend_control_reached'] ?? null,
      planType: snapshot['plan_type'] ?? null,
      rateLimitReachedType: snapshot['rate_limit_reached_type'] ?? null
    }
  };
}

function parseMeta(payload: Record<string, unknown> | null): RolloutMeta | null {
  const threadId = text(payload?.['id']);
  if (payload === null || threadId === null) return null;
  return {
    threadId,
    sessionId: text(payload['session_id']),
    parentThreadId: text(payload['parent_thread_id']),
    creatorAccountId: text(payload['creator_account_id'])
  };
}

interface ScanState {
  usage: { value: unknown; at: number } | null;
  limits: { value: NativeRateLimitsResponse; at: number } | null;
  compactedAt: number | null;
  unknownUsageAt: number | null;
}

function scanLines(contents: string, nowMs: number, state: ScanState): void {
  for (const line of contents.split('\n')) {
    if (line.trim() === '' || !line.includes('"type"')) continue;
    let row: Record<string, unknown> | null;
    try { row = record(JSON.parse(line)); } catch { continue; }
    if (row === null) continue;
    const at = timestampMs(row['timestamp']);
    if (at === null || at > nowMs) continue;
    if (row['type'] === 'compacted') {
      state.compactedAt = Math.max(state.compactedAt ?? at, at);
      continue;
    }
    const payload = record(row['payload']);
    if (row['type'] !== 'event_msg' || payload === null) continue;
    if (payload['type'] === 'context_compacted') {
      state.compactedAt = Math.max(state.compactedAt ?? at, at);
      continue;
    }
    if (payload['type'] !== 'token_count') continue;
    const usage = normalizeRolloutTokenUsage(payload['info']);
    if (usage === null) {
      // TokenCount.info is optional: an explicit unknown newer than the last
      // known reading means the old number no longer describes the context.
      if (payload['info'] === null) state.unknownUsageAt = Math.max(state.unknownUsageAt ?? at, at);
    } else if (state.usage === null || at >= state.usage.at) {
      state.usage = { value: usage, at };
    }
    const limits = convertRolloutRateLimits(payload['rate_limits']);
    if (limits !== null && (state.limits === null || at >= state.limits.at)) state.limits = { value: limits, at };
  }
}

/**
 * Read the rollout's identity head and newest token/rate-limit observations.
 * `expectedThreadId`, when given, must match the first `session_meta`: a
 * forked rollout carries the parent's metadata later in the file, and a hook
 * naming someone else's file must not describe this thread.
 */
export function readRollout(file: string | null | undefined, nowMs: number, expectedThreadId?: string): RolloutReading {
  if (typeof file !== 'string') return EMPTY;
  const real = allowedRollout(file);
  if (real === null) return EMPTY;
  let fd: number;
  try { fd = openSync(real, 'r'); } catch { return EMPTY; }
  try {
    const size = fstatSync(fd).size;
    const head = readRange(fd, 0, Math.min(HEAD_BYTES, size));
    const firstLine = head.split('\n', 1)[0] ?? '';
    let meta: RolloutMeta | null = null;
    try {
      const row = record(JSON.parse(firstLine));
      if (row?.['type'] === 'session_meta') meta = parseMeta(record(row['payload']));
    } catch { /* an unreadable head leaves the identity unknown */ }
    if (meta === null || (expectedThreadId !== undefined && meta.threadId !== expectedThreadId)) {
      return { ...EMPTY, meta: expectedThreadId === undefined ? meta : null };
    }
    let state: ScanState = { usage: null, limits: null, compactedAt: null, unknownUsageAt: null };
    for (const step of TAIL_STEPS) {
      const length = Math.min(step, size);
      const start = size - length;
      const chunk = readRange(fd, start, length);
      // A partial first line is expected when the read starts mid-file.
      state = { usage: null, limits: null, compactedAt: null, unknownUsageAt: null };
      scanLines(start === 0 ? chunk : chunk.slice(chunk.indexOf('\n') + 1), nowMs, state);
      // Widen the window only when the short tail missed a reading.
      if ((state.usage !== null && state.limits !== null) || start === 0) break;
    }
    const usageAt = state.usage?.at ?? null;
    const invalidatedAt = Math.max(state.compactedAt ?? -1, state.unknownUsageAt ?? -1);
    const usageValid = usageAt !== null && usageAt > invalidatedAt;
    return {
      meta,
      tokenUsage: usageValid ? state.usage?.value ?? null : null,
      tokenUsageObservedAtMs: usageValid ? usageAt : null,
      rateLimits: state.limits?.value ?? null,
      rateLimitsObservedAtMs: state.limits?.at ?? null,
      compactedSinceUsage: state.compactedAt !== null && (usageAt === null || state.compactedAt >= usageAt)
    };
  } catch {
    return EMPTY;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Locate a thread's rollout under `<CODEX_HOME>/sessions/YYYY/MM/DD/` by its
 * `-<threadId>.jsonl` suffix, newest days first. Used by the CLIs, which know
 * the thread id (CODEX_THREAD_ID) but not the hook's transcript path.
 */
export function findRolloutForThread(threadId: string, maxDays = 400): string | null {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(threadId)) return null;
  const root = path.join(codexHome(), 'sessions');
  const sortedDirs = (dir: string): string[] => {
    try { return readdirSync(dir).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a)); } catch { return []; }
  };
  let visited = 0;
  for (const year of sortedDirs(root)) {
    for (const month of sortedDirs(path.join(root, year))) {
      for (const day of sortedDirs(path.join(root, year, month))) {
        if (visited++ >= maxDays) return null;
        const dir = path.join(root, year, month, day);
        let names: string[];
        try { names = readdirSync(dir); } catch { continue; }
        const match = names.find((name) => name.endsWith(`-${threadId}.jsonl`));
        if (match !== undefined) return path.join(dir, match);
      }
    }
  }
  return null;
}
