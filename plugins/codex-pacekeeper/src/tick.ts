#!/usr/bin/env bun
/**
 * Codex hook adapter, mirroring the Claude package's tick.ts event by event.
 *
 * Identity: Codex sends the ROOT thread's id as `session_id` on every hook in
 * an agent tree, and the child's own thread id as `agent_id` on a child's
 * hooks. So a hook's thread is `agent_id ?? session_id`, and `agent_id` being
 * absent is how main-thread-only behavior tells itself apart, as in Claude.
 *
 * Facts come from the rollout (`transcript_path`): context and the default
 * rate-limit bucket ride on every `token_count` event. The detached refresh
 * adds the native account read (account id, included-usage permission) when
 * the control socket is reachable; whichever quota reading is newer wins.
 *
 * Output encoding is per event: SessionStart, UserPromptSubmit, PreToolUse
 * and SubagentStart carry `additionalContext`; Stop can only re-open the turn
 * with `decision: block`, so it speaks only for the directives Claude also
 * continues a turn for; compaction hooks cannot reach the model at all.
 */
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';
import { buildContract, checkpointCliPath, effectivePause, formatPauseDirective, listHandoffs, PAUSE_MARKER, RESUME_MARKER, shouldPause, type Handoff } from './agent-budget';
import { CodexCheckpoints, firstGoalLine, type CheckpointEntry } from './checkpoint';
import { loadCodexConfig, type CodexConfig } from './config';
import { buildFacts, type CodexFacts, type Level } from './facts';
import {
  detectAfkReturn, driver, formatAutoLoopDirective, formatBridgeDirective, formatCtxAutoSaveDirective, formatDirective,
  formatDispatchAdvisory, formatDuration, formatMeterSegment, formatStatusLine, formatSubagentTickLine, formatTimeSegment,
  levelGt, readings, type MeterReading
} from './format';
import { KEEPALIVE_MARKER } from './jobs';
import type { NativeRateLimitsResponse } from './native';
import { decide, type PolicyEvent, type PolicyState } from './policy';
import { resolveProjectRoot } from './resolve-root';
import { readRollout, type RolloutReading } from './rollout';
import { CodexService } from './service';
import { ACCOUNT_IDENTITY, CodexStore, type StateIdentity } from './storage';

export interface TickInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  turn_id?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
  agent_transcript_path?: unknown;
  prompt?: unknown;
  source?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  stop_hook_active?: unknown;
  model?: unknown;
  /** Test seam: the hook's wall clock. */
  now_ms?: unknown;
}

export interface TickOptions {
  config?: CodexConfig;
  store?: CodexStore;
  nowMs?: number;
  /** Test seam: replaces the rollout read. */
  rollout?: RolloutReading;
  /** Test seam: replaces project-root resolution for a cwd. */
  projectRoot?: (cwd: string) => string | null;
}

export interface TickResult {
  output: string;
  facts: CodexFacts;
  identity: StateIdentity;
  /** True when the main thread has an active checkpoint or pending handoff. */
  pendingWork?: boolean;
  /** The entrypoint should make sure the background service is running. */
  launchService?: boolean;
}

/** Per-thread session entry, the Codex counterpart of Claude's SessionEntry. */
export interface SessionEntry {
  sessionStartedAtMs: number;
  lastEventAtMs: number;
  lastUserActivityAtMs?: number;
  lastTimestampInjectedAtMs?: number;
  afkSurfacedFrom?: number;
  ctxAutoSaveArmed?: boolean;
  lastAutoFireResetKey?: string;
  reminderCoverage?: Partial<Record<string, { level: Level; resetKey: string }>>;
  /** The keepalive ping turn currently running, so its Stop stays silent. */
  syntheticTurnId?: string;
  /** Start of the current idle stretch, carried across ping turns. */
  keepaliveIdleSince?: number;
  pendingWork?: boolean;
  projectRoot?: string;
  cwd?: string;
  accountId?: string;
  sessionEndedAtMs?: number;
  usageNoteSurfaced?: boolean;
  surfacedHandoffs?: string[];
  /** Subagent fields. */
  agentId?: string;
  agentType?: string;
  parentThreadId?: string;
  spawnFiveHourPercent?: number;
  spawnResetKey?: string;
  /** Main thread: cumulative child burn for the current block. */
  agentBurnPct?: number;
  agentBurnResetKey?: string;
}

const EVENTS: readonly PolicyEvent[] = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];
const SPAWN_TOOLS = new Set(['spawn_agent', 'spawnAgent', 'multi_agent_v1spawn_agent', 'Agent', 'Task']);

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() !== '' ? value : undefined; }
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A marker-triggered prompt only if it STARTS with the marker: text that
 * merely quotes a marker (a pasted report) must pass through untouched. */
export function promptStartsWithMarker(prompt: unknown, marker: string): boolean {
  return typeof prompt === 'string' && prompt.trimStart().startsWith(marker);
}

/** Idempotency key for "once per block": resets jitter below a minute. */
export function blockResetKey(resetsAtMs: number | null | undefined): string | undefined {
  return typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs) ? String(Math.floor(resetsAtMs / 60_000)) : undefined;
}

export function threadIdOf(input: TickInput): string {
  return text(input.agent_id) ?? text(input.session_id) ?? 'unknown-thread';
}

function emptyOutput(): string { return '{}'; }

function contextOutput(event: PolicyEvent, additionalContext: string): string {
  if (additionalContext.trim() === '') return emptyOutput();
  if (event === 'Stop' || event === 'SubagentStop') return JSON.stringify({ decision: 'block', reason: additionalContext });
  if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PreToolUse' || event === 'PostToolUse' || event === 'SubagentStart') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  }
  return emptyOutput();
}

/** Account-wide native observation written by the refresh. */
interface AccountRecord {
  accountId?: string | null;
  rateLimits?: NativeRateLimitsResponse;
  quotaObservedAtMs?: number;
  ordinaryUsageObservedAtMs?: number;
  authenticated?: boolean | null;
  authObservedAtMs?: number;
}

export function readAccountRecord(store: CodexStore): AccountRecord {
  return (record(store.read(ACCOUNT_IDENTITY, 'account')) ?? {}) as AccountRecord;
}

/**
 * Assemble facts from the rollout and the account record. The newer quota
 * reading wins; the account record's identity and included-usage permission
 * still apply to a newer rollout snapshot of the same account.
 */
export function assembleFacts(rollout: RolloutReading, account: AccountRecord, config: CodexConfig, nowMs: number, compactStart = false): CodexFacts {
  const accountAt = finite(account.quotaObservedAtMs) ?? -1;
  const rolloutAt = rollout.rateLimitsObservedAtMs ?? -1;
  let rateLimits: NativeRateLimitsResponse | null = null;
  let observedAtMs = nowMs;
  if (rollout.rateLimits !== null && rolloutAt > accountAt) {
    rateLimits = {
      ...rollout.rateLimits,
      ...(typeof account.accountId === 'string' ? { accountId: account.accountId } : {}),
      ...(typeof record(account.rateLimits)?.['ordinaryUsageAllowed'] === 'boolean' ? { ordinaryUsageAllowed: record(account.rateLimits)?.['ordinaryUsageAllowed'] } : {})
    };
    observedAtMs = rolloutAt;
  } else if (account.rateLimits !== undefined && accountAt >= 0) {
    rateLimits = account.rateLimits;
    observedAtMs = accountAt;
  }
  const authFresh = finite(account.authObservedAtMs) !== undefined && nowMs - (account.authObservedAtMs as number) <= config.usage_freshness_seconds * 1000;
  return buildFacts({
    rateLimits,
    observedAtMs,
    ...(finite(account.ordinaryUsageObservedAtMs) !== undefined ? { ordinaryUsageObservedAtMs: account.ordinaryUsageObservedAtMs } : {}),
    // Compaction replaces the conversation; until a post-compaction count is
    // flushed, the newest count describes the discarded one.
    tokenUsage: compactStart ? null : rollout.tokenUsage,
    authenticated: authFresh && typeof account.authenticated === 'boolean' ? account.authenticated : null
  }, config, nowMs);
}

function readSession(store: CodexStore, identity: StateIdentity): SessionEntry | null {
  const row = record(store.read(identity, 'timeline'));
  return row !== null && typeof row['sessionStartedAtMs'] === 'number' && typeof row['lastEventAtMs'] === 'number'
    ? row as unknown as SessionEntry
    : null;
}

function updateSession(store: CodexStore, identity: StateIdentity, patch: Partial<SessionEntry>): SessionEntry {
  return store.update(identity, 'timeline', (prior) => ({ ...prior, threadId: identity.threadId, ...patch })) as unknown as SessionEntry;
}

function readDebounce(store: CodexStore, identity: StateIdentity): PolicyState {
  const row = record(store.read(identity, 'debounce'));
  return {
    levels: { ...(record(row?.['levels']) ?? {}) } as PolicyState['levels'],
    lastInjectedAtMs: { ...(record(row?.['lastInjectedAtMs']) ?? {}) } as PolicyState['lastInjectedAtMs'],
    blockResetAtMs: typeof row?.['blockResetAtMs'] === 'number' ? row['blockResetAtMs'] : null,
    savedThisCycle: row?.['savedThisCycle'] === true,
    saveRequestedThisCycle: row?.['saveRequestedThisCycle'] === true
  };
}

/** Debounced directive gate shared with the parity suite: fires on an
 * escalation, or on an unchanged level once the debounce window passed. */
function debounceFires(store: CodexStore, identity: StateIdentity, event: PolicyEvent, facts: CodexFacts, nowMs: number, config: CodexConfig): boolean {
  const decision = decide({ event, facts, state: readDebounce(store, identity), nowMs }, config);
  store.write(identity, 'debounce', decision.nextState);
  return decision.inject;
}

function projectRootFor(cwd: string | undefined, session: SessionEntry | null, options: TickOptions): string | null {
  if (cwd === undefined) return null;
  if (session?.cwd === cwd && session.projectRoot !== undefined) return session.projectRoot;
  if (options.projectRoot) return options.projectRoot(cwd);
  try { return resolveProjectRoot({ cwdFlag: cwd, processCwd: cwd }); } catch { return null; }
}

function activeCheckpoints(root: string | null, config: CodexConfig): CheckpointEntry[] {
  if (root === null) return [];
  try { return new CodexCheckpoints(root, config).listNewestFirst(); } catch { return []; }
}

/**
 * A save run by the model inside Codex's workspace-write sandbox cannot write
 * the state directory, so its checkpoint records the reset but no wake job.
 * The hook runs outside the sandbox and registers it; the service makes this
 * idempotent per reset.
 */
function registerDeferredResetWake(active: CheckpointEntry[], root: string | null, threadId: string, config: CodexConfig, store: CodexStore, nowMs: number): void {
  if (root === null || !config.auto.enabled) return;
  const entry = active.find((candidate) => candidate.owner.threadId === threadId && candidate.owner.accountId !== null
    && candidate.resetGeneration !== undefined && candidate.resetGeneration > nowMs);
  if (entry === undefined || entry.owner.accountId === null || entry.resetGeneration === undefined) return;
  try {
    new CodexService({ config, store, projectRoot: root, now: () => nowMs })
      .scheduleResetWake({ accountId: entry.owner.accountId, threadId }, entry.id, entry.resetGeneration, entry.resetGeneration);
  } catch { /* withheld, exactly as it would have been at save */ }
}

function pendingHandoffs(root: string | null, config: CodexConfig, parentThreadId?: string): Handoff[] {
  if (root === null) return [];
  try { return listHandoffs(root, config.checkpoint_dir_name, config.checkpoint_subdir, parentThreadId); } catch { return []; }
}

function ageLabel(savedAtMs: number, nowMs: number): string {
  return `${((nowMs - savedAtMs) / 86_400_000).toFixed(1)}d`;
}

function formatHandoffLines(handoffs: Handoff[], nowMs: number): string[] {
  if (handoffs.length === 0) return [];
  return [
    `📎 ${handoffs.length} paused subagent handoff(s) waiting:`,
    ...handoffs.map((h) => `   ${h.frontmatter.agent_id} · ${h.frontmatter.agent_type ?? '?'} · ${h.frontmatter.trigger} · ${ageLabel(Date.parse(h.frontmatter.created_at), nowMs)}`),
    '',
    `Read each with \`${checkpointCliPath()} handoffs list\`, re-dispatch the paused work, then archive each via \`${checkpointCliPath()} handoffs archive <agent_id>\` once absorbed.`
  ];
}

export function buildSessionStartContext(root: string | null, config: CodexConfig, threadId: string, nowMs: number): string {
  const active = activeCheckpoints(root, config);
  const handoffs = pendingHandoffs(root, config);
  if (active.length === 0 && handoffs.length === 0) return '';
  const lines: string[] = [];
  const cli = checkpointCliPath();
  if (active.length === 1) {
    const newest = active[0] as CheckpointEntry;
    lines.push(`📌 Active checkpoint found (lane ${newest.lane}, saved ${new Date(newest.savedAtMs).toISOString()}):`);
    const goal = firstGoalLine(newest.body);
    if (goal) lines.push(`   Goal: ${goal}`);
    lines.push('', `Run \`${cli} resume --thread-id ${threadId}\` to orient from it, or carry on.`);
  } else if (active.length > 1) {
    lines.push(`📌 ${active.length} active checkpoint lanes found:`);
    for (const entry of active) {
      lines.push(`   ${entry.lane} · ${entry.branch ?? '?'} · ${ageLabel(entry.savedAtMs, nowMs)} · ${firstGoalLine(entry.body) ?? '(no goal)'}`);
    }
    lines.push('', `Run \`${cli} resume <lane> --thread-id ${threadId}\` to orient from a specific lane.`);
  }
  const handoffLines = formatHandoffLines(handoffs, nowMs);
  if (handoffLines.length > 0) lines.push(...(lines.length > 0 ? [''] : []), ...handoffLines);
  return lines.join('\n');
}

/** Codex caps additionalContext like Claude does; leave room for framing. */
export const POST_COMPACT_BODY_CAP = 8000;

/**
 * SessionStart(source: compact) re-orientation: the summary is lossy, the
 * checkpoint this thread saved (active or already resumed) is the record.
 */
export function buildPostCompactContext(root: string | null, config: CodexConfig, threadId: string, sessionStartedAtMs: number, nowMs: number): string {
  let checkpoint: CheckpointEntry | null = null;
  if (root !== null) {
    try {
      const store = new CodexCheckpoints(root, config);
      const candidates = [...store.list(), ...store.listArchived().filter((entry) => entry.disposition === 'consumed')]
        .filter((entry) => entry.savedAtMs >= sessionStartedAtMs)
        .sort((a, b) => b.savedAtMs - a.savedAtMs);
      checkpoint = candidates.find((entry) => entry.owner.threadId === threadId) ?? candidates[0] ?? null;
    } catch { checkpoint = null; }
  }
  const handoffLines = formatHandoffLines(pendingHandoffs(root, config, threadId), nowMs);
  const cap = Math.max(1000, POST_COMPACT_BODY_CAP - handoffLines.join('\n').length);
  const lines: string[] = [];
  if (checkpoint !== null) {
    const body = checkpoint.body.length > cap ? `${checkpoint.body.slice(0, cap)}\n\n[… truncated; full text in ${checkpoint.file}]` : checkpoint.body;
    lines.push(
      `🔁 Context was just compacted. The summary above is lossy; this is the checkpoint saved this session (lane ${checkpoint.lane}, ${formatDuration(nowMs - checkpoint.savedAtMs)} ago):`,
      '',
      body.trim(),
      '',
      'Where the summary and this checkpoint disagree on the goal, constraints or rules, the checkpoint is the record; for steps taken after it was saved, the summary is. Continue from its "Next".'
    );
  } else {
    lines.push(`🔁 Context was just compacted and no checkpoint was saved this session, so the summary above is the only record of the goal. Before continuing, restate the goal, its constraints and the next step in three lines, then save a checkpoint via \`${checkpointCliPath()} save --thread-id ${threadId}\` at the next natural break.`);
  }
  if (handoffLines.length > 0) lines.push('', ...handoffLines);
  return lines.join('\n');
}

export function buildResumeOrientation(root: string | null, config: CodexConfig, facts: CodexFacts, nowMs: number, threadId: string): string {
  const active = activeCheckpoints(root, config);
  const handoffs = pendingHandoffs(root, config);
  const status = formatStatusLine(facts, nowMs);
  if (active.length === 0 && handoffs.length === 0) {
    return [status, '', `${RESUME_MARKER} Auto-wake fired, but nothing is pending: no active checkpoint lane and no paused handoffs (the work was already resumed). Reply with a single word.`].join('\n');
  }
  const lines = [
    status,
    '',
    `${RESUME_MARKER} Auto-wake fired. Run \`${checkpointCliPath()} resume <id or lane> --thread-id ${threadId}\` now (even in-session — this archives the consumed checkpoint so it isn't re-surfaced), then re-dispatch any paused handoffs, archiving each via \`${checkpointCliPath()} handoffs archive <agent_id>\` once absorbed.`
  ];
  if (active.length > 0) lines.push('', `Active lane(s): ${active.map((entry) => `${entry.lane} (${entry.id})`).join(', ')}`);
  if (handoffs.length > 0) lines.push('', `Pending handoffs: ${handoffs.map((h) => h.frontmatter.agent_id).join(', ')}`);
  return lines.join('\n');
}

function keepaliveGuidance(idleMs: number, config: CodexConfig): string {
  return `${KEEPALIVE_MARKER} Cache keepalive (user idle ${Math.floor(idleMs / 60_000)}m). Reply with exactly the single word pong. Do not call any tools, read files, plan, or do any other work; pacekeeper re-sends this every ~${config.keepalive.interval_min}m while work is pending.`;
}

const PING_SUPPRESSED = '[pacekeeper] Cache keepalive skipped — you were active moments ago, so the cache is already warm. Nothing is wrong.';

/** min(idle_threshold, 0.8 × interval): a ping that lands mid-activity is noise. */
export function pingGate(gapMs: number, config: CodexConfig): 'block' | 'passthrough' {
  const thresholdMin = Math.min(config.time.idle_threshold_min, config.keepalive.interval_min * 0.8);
  return gapMs < thresholdMin * 60_000 ? 'block' : 'passthrough';
}

/**
 * The level a meter is already covered at this block: the highest level a
 * prior reminder fired at, or warn when a checkpoint was saved during the
 * current five-hour block (the user already acted on the warning).
 */
function coveredLevel(session: SessionEntry | null, reading: MeterReading, resetKey: string, newest: CheckpointEntry | undefined, facts: CodexFacts): Level {
  let covered: Level = 'none';
  const marked = session?.reminderCoverage?.[reading.meter];
  if (marked && marked.resetKey === resetKey && levelGt(marked.level, covered)) covered = marked.level;
  const fiveReset = facts.fiveHour?.resetsAtMs;
  if (newest !== undefined && reading.meter === 'five_hour' && typeof fiveReset === 'number'
    && newest.savedAtMs >= fiveReset - 5 * 3_600_000 && levelGt('warn', covered)) covered = 'warn';
  return covered;
}

function reminderMetersToFire(session: SessionEntry | null, facts: CodexFacts, newest: CheckpointEntry | undefined): MeterReading[] {
  return readings(facts).filter((reading) => {
    if (reading.level !== 'warn' && reading.level !== 'critical') return false;
    const key = blockResetKey(reading.resetsAtMs);
    if (key === undefined) return false;
    return levelGt(reading.level, coveredLevel(session, reading, key, newest, facts));
  });
}

function coverageWith(session: SessionEntry | null, fired: MeterReading[]): SessionEntry['reminderCoverage'] {
  const coverage = { ...(session?.reminderCoverage ?? {}) };
  for (const reading of fired) {
    const key = blockResetKey(reading.resetsAtMs);
    if (key !== undefined) coverage[reading.meter] = { level: reading.level, resetKey: key };
  }
  return coverage;
}

function autoFiredThisBlock(session: SessionEntry | null, facts: CodexFacts): boolean {
  const key = blockResetKey(facts.fiveHour?.resetsAtMs);
  return key !== undefined && facts.fiveHour?.rolledOver !== true && session?.lastAutoFireResetKey === key;
}

function plannedAgentCount(input: TickInput): number | undefined {
  const tool = text(input.tool_name);
  if (tool === undefined || !SPAWN_TOOLS.has(tool)) return undefined;
  const args = record(input.tool_input);
  if (args === null) return 1;
  for (const key of ['agents', 'tasks', 'agent_ids']) {
    const value = args[key];
    if (Array.isArray(value)) return value.length;
  }
  return 1;
}

/**
 * Launch the background service when there is something for it to do. The
 * service is a singleton guarded by its own lock, so a redundant launch exits
 * at once; the check here only avoids spawning a process on every Stop.
 */
export function ensureService(store: CodexStore, nowMs: number): void {
  if (process.env['CODEX_PACEKEEPER_NO_SERVICE'] === '1') return;
  const heartbeat = record(store.read({ accountId: null, threadId: 'service' }, 'service'));
  const beatAt = finite(heartbeat?.['heartbeatAtMs']);
  if (beatAt !== undefined && nowMs - beatAt < 90_000) return;
  try {
    const script = path.join(import.meta.dir, 'service.ts');
    const child = spawn(process.execPath, ['run', script, 'watch'], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  } catch { /* keepalive degrades to absent; doctor reports it */ }
}

export function runTick(input: TickInput, options: TickOptions = {}): TickResult {
  const config = options.config ?? loadCodexConfig().config;
  const store = options.store ?? new CodexStore();
  const nowMs = options.nowMs ?? finite(input.now_ms) ?? Date.now();
  const rawEvent = text(input.hook_event_name) ?? '';
  const event: PolicyEvent = (EVENTS as readonly string[]).includes(rawEvent) ? rawEvent as PolicyEvent : 'SessionStart';
  const agentId = text(input.agent_id);
  const isMainThread = agentId === undefined;
  const threadId = threadIdOf(input);
  const identity: StateIdentity = { accountId: null, threadId, ...(agentId ? { agentId } : {}) };
  const cwd = text(input.cwd);
  const compactStart = event === 'SessionStart' && input.source === 'compact';
  const transcript = event === 'SubagentStop' ? text(input.agent_transcript_path) : text(input.transcript_path);
  const rollout = options.rollout ?? readRollout(transcript, nowMs, threadId);
  const account = readAccountRecord(store);
  const facts = assembleFacts(rollout, account, config, nowMs, compactStart);
  const accountId = typeof account.accountId === 'string' ? account.accountId : rollout.meta?.creatorAccountId ?? undefined;
  const done = (output: string, pendingWork?: boolean, launchService = false): TickResult => ({ output, facts, identity, ...(pendingWork === undefined ? {} : { pendingWork }), ...(launchService ? { launchService } : {}) });

  // A Stop re-opened by our own block already carried its directive; speaking
  // again is the loop that ends in the harness's continuation cap.
  const stopHookActive = input.stop_hook_active === true;
  if (stopHookActive && (event === 'Stop' || event === 'SubagentStop')) return done(emptyOutput());

  const prior = readSession(store, identity);

  // ── Keepalive ping: a system event, not user activity. Never mutate the
  //    idle clock; suppress when the user was active moments ago. ──
  if (isMainThread && event === 'UserPromptSubmit' && promptStartsWithMarker(input.prompt, KEEPALIVE_MARKER)) {
    const lastEventAtMs = prior?.lastEventAtMs ?? nowMs;
    if (pingGate(nowMs - lastEventAtMs, config) === 'block') {
      return done(JSON.stringify({ decision: 'block', reason: PING_SUPPRESSED }));
    }
    const idleSince = prior?.keepaliveIdleSince ?? lastEventAtMs;
    updateSession(store, identity, { keepaliveIdleSince: idleSince, ...(text(input.turn_id) ? { syntheticTurnId: text(input.turn_id) } : {}) });
    return done(contextOutput(event, keepaliveGuidance(nowMs - idleSince, config)));
  }
  const turnId = text(input.turn_id);
  if (isMainThread && turnId !== undefined && prior?.syntheticTurnId === turnId && (event === 'Stop' || event === 'PreToolUse' || event === 'PostToolUse')) {
    // The ping's own turn: transparent to idle and pacing state.
    return done(emptyOutput());
  }

  // ── Timeline: every real event advances it. ──
  const previousEventAtMs = prior?.lastEventAtMs ?? null;
  const userActivity = event === 'UserPromptSubmit' || event === 'Interrupt';
  let session = updateSession(store, identity, {
    sessionStartedAtMs: prior?.sessionStartedAtMs ?? nowMs,
    lastEventAtMs: nowMs,
    ...(userActivity ? { lastUserActivityAtMs: nowMs } : {}),
    ...(event === 'UserPromptSubmit' ? { syntheticTurnId: undefined, keepaliveIdleSince: undefined } : {}),
    ...(cwd ? { cwd } : {}),
    ...(accountId ? { accountId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(event === 'SessionEnd' ? { sessionEndedAtMs: nowMs, pendingWork: false } : {}),
    ...(event === 'SessionStart' ? { sessionEndedAtMs: undefined } : {})
  });

  if (event === 'SessionEnd') {
    cancelThreadJobs(store, threadId, 'session ended', nowMs);
    return done(emptyOutput(), false);
  }
  if (event === 'PreCompact' || event === 'Interrupt' || event === 'PostToolUse') return done(emptyOutput());
  if (event === 'PostCompact') {
    updateSession(store, identity, { ctxAutoSaveArmed: false });
    return done(emptyOutput());
  }

  const root = projectRootFor(cwd, prior, options);
  if (root !== null && session.projectRoot !== root) session = updateSession(store, identity, { projectRoot: root });

  // ── Subagent lifecycle. ──
  if (event === 'SubagentStart') {
    if (agentId === undefined) return done(emptyOutput());
    const five = facts.fiveHour;
    const spawnPercent = five !== null && five.usedPercent !== null && !five.rolledOver ? five.usedPercent : 0;
    // The child's rollout names its parent; Codex wrote it, so no socket
    // round trip (and no race with the refresh hook) is needed.
    const parentThreadId = rollout.meta?.threadId === agentId ? rollout.meta.parentThreadId ?? undefined : undefined;
    updateSession(store, identity, {
      spawnFiveHourPercent: spawnPercent,
      ...(blockResetKey(five?.resetsAtMs) ? { spawnResetKey: blockResetKey(five?.resetsAtMs) } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(text(input.agent_type) ? { agentType: text(input.agent_type) } : {})
    });
    let contract = '';
    try {
      contract = buildContract({ agentId, agentType: text(input.agent_type) ?? 'default', cliPath: checkpointCliPath(), fiveHourPercentAtSpawn: spawnPercent, ...(parentThreadId ? { parentThreadId } : {}) }, config).text;
    } catch { contract = ''; }
    return done(contextOutput(event, [formatStatusLine(facts, nowMs), contract].filter((part) => part !== '').join('\n\n')));
  }
  if (event === 'SubagentStop') {
    // Codex re-opens the CHILD on a SubagentStop block, so nothing here can
    // reach the parent. Record the child's burn for the parent's status line;
    // the parent surfaces the child's handoff on its own next tick.
    const five = facts.fiveHour;
    const parentThreadId = session.parentThreadId ?? text(input.session_id);
    if (five !== null && five.usedPercent !== null && !five.rolledOver && session.spawnFiveHourPercent !== undefined && parentThreadId !== undefined) {
      const key = blockResetKey(five.resetsAtMs);
      const delta = session.spawnResetKey === key ? Math.max(0, five.usedPercent - session.spawnFiveHourPercent) : five.usedPercent;
      store.update({ accountId: null, threadId: parentThreadId }, 'timeline', (parent) => {
        const same = parent['agentBurnResetKey'] === key;
        return { ...parent, agentBurnPct: (same && typeof parent['agentBurnPct'] === 'number' ? parent['agentBurnPct'] : 0) + delta, agentBurnResetKey: key };
      });
    }
    return done(emptyOutput());
  }

  // ── ctx auto-save: arm once per climb into critical; disarm after the
  //    meter falls below warn (compaction ran). Main thread and children. ──
  // Only events that deliver the directive may consume it: SessionStart's
  // context carries orientation, so arming there would spend the once-per-
  // climb directive where the model never acts on it.
  const canDeliverDirective = event === 'UserPromptSubmit' || event === 'PreToolUse' || event === 'Stop';
  let ctxAutoSave: string | null = null;
  const ctxLevel = facts.context?.level ?? null;
  if (compactStart && session.ctxAutoSaveArmed === true) session = updateSession(store, identity, { ctxAutoSaveArmed: false });
  else if (canDeliverDirective && ctxLevel === 'critical' && session.ctxAutoSaveArmed !== true) {
    ctxAutoSave = formatCtxAutoSaveDirective(facts, nowMs, threadId, isMainThread);
    session = updateSession(store, identity, { ctxAutoSaveArmed: true });
  } else if (ctxLevel !== null && ctxLevel !== 'warn' && ctxLevel !== 'critical' && session.ctxAutoSaveArmed === true) {
    session = updateSession(store, identity, { ctxAutoSaveArmed: false });
  }

  // ── Auto-renewal (main thread): once per block at auto.five_hour_pct. ──
  let autoDirective: string | null = null;
  if (isMainThread && config.auto.enabled && canDeliverDirective) {
    const five = facts.fiveHour;
    const key = blockResetKey(five?.resetsAtMs);
    if (five !== null && !five.rolledOver && five.usedPercent !== null && five.usedPercent >= config.auto.five_hour_pct
      && key !== undefined && session.lastAutoFireResetKey !== key) {
      autoDirective = formatAutoLoopDirective(facts, config, nowMs, threadId);
      ctxAutoSave = null;
      session = updateSession(store, identity, { lastAutoFireResetKey: key, ...(compactStart ? {} : { ctxAutoSaveArmed: true }) });
    }
  }

  /** The warn/critical reminder, once per level per block, bridged near a reset. */
  const directiveIfEscalated = (): string | null => {
    const fires = debounceFires(store, identity, event, facts, nowMs, config);
    if (!fires) return null;
    const top = driver(facts);
    if (top === null || (top.level !== 'warn' && top.level !== 'critical')) return null;
    if (top.meter === 'five_hour' && autoFiredThisBlock(session, facts)) return null;
    const toFire = reminderMetersToFire(session, facts, activeCheckpoints(root, config)[0]);
    if (toFire.length === 0) return null;
    if (config.bridge.enabled) {
      const bridge = formatBridgeDirective(facts, config.bridge.max_wait_min, nowMs);
      if (bridge !== null) return bridge;
    }
    session = updateSession(store, identity, { reminderCoverage: coverageWith(session, toFire) });
    return formatDirective(facts, nowMs);
  };

  const composeLine = (afk: string | null, directive: string | null, extras: string[] = []): string => {
    // As in Claude, the line is composed after this event advanced the
    // timeline, so it never shows an idle segment; the away line does that.
    const time = formatTimeSegment(nowMs, session.sessionStartedAtMs, session.lastEventAtMs, config);
    const meters = formatMeterSegment(facts, nowMs);
    const fiveKey = blockResetKey(facts.fiveHour?.resetsAtMs);
    const burn = session.agentBurnResetKey !== undefined && session.agentBurnResetKey === fiveKey && (session.agentBurnPct ?? 0) > 0
      ? ` · agents ~${Math.round(session.agentBurnPct ?? 0)}%` : '';
    const head = meters ? `[pacekeeper] ${time} · ${meters}${burn}` : `[pacekeeper] ${time}${burn}`;
    const lines: string[] = [];
    if (afk) lines.push(afk);
    lines.push(head);
    if (directive) lines.push('', directive);
    for (const extra of extras) lines.push('', extra);
    return lines.join('\n');
  };

  /** Each handoff a child of this thread wrote is surfaced once. */
  const newHandoffNotes = (): string | null => {
    if (!isMainThread) return null;
    const handoffs = pendingHandoffs(root, config, threadId).filter((h) => !(session.surfacedHandoffs ?? []).includes(h.frontmatter.agent_id));
    if (handoffs.length === 0) return null;
    session = updateSession(store, identity, { surfacedHandoffs: [...(session.surfacedHandoffs ?? []), ...handoffs.map((h) => h.frontmatter.agent_id)].slice(-50) });
    return handoffs.map((h) => `[pacekeeper] Subagent ${h.frontmatter.agent_id} paused on budget (${PAUSE_MARKER}) and left a handoff:\n${h.body}\n\nRe-dispatch the remaining work when the budget allows, then run \`${checkpointCliPath()} handoffs archive ${h.frontmatter.agent_id}\`.`).join('\n\n');
  };

  let injection = '';

  if (event === 'SessionStart') {
    const banner = compactStart
      ? buildPostCompactContext(root, config, threadId, session.sessionStartedAtMs, nowMs)
      : buildSessionStartContext(root, config, threadId, nowMs);
    const parts = [banner];
    if (driver(facts) !== null) {
      parts.push(formatStatusLine(facts, nowMs));
      debounceFires(store, identity, event, facts, nowMs, config);
    }
    if (facts.capacity === 'unsupported' && session.usageNoteSurfaced !== true) {
      parts.push('[pacekeeper] This Codex session is not on included ChatGPT subscription capacity (API key or unsupported account), so subscription pacing, keepalive and auto-renewal are off. The context meter still works.');
      session = updateSession(store, identity, { usageNoteSurfaced: true });
    }
    injection = parts.filter((part) => part.trim() !== '').join('\n\n');
  } else if (event === 'UserPromptSubmit') {
    if (isMainThread && promptStartsWithMarker(input.prompt, RESUME_MARKER)) {
      injection = buildResumeOrientation(root, config, facts, nowMs, threadId);
    } else {
      let afk: string | null = null;
      if (previousEventAtMs !== null) {
        const line = detectAfkReturn(nowMs - previousEventAtMs, config);
        if (line !== null && prior?.afkSurfacedFrom !== previousEventAtMs) {
          afk = line;
          session = updateSession(store, identity, { afkSurfacedFrom: previousEventAtMs });
        }
      }
      const directive = autoDirective ?? ctxAutoSave ?? directiveIfEscalated();
      const extras = [newHandoffNotes()].filter((note): note is string => note !== null);
      injection = composeLine(afk, directive, extras);
      session = updateSession(store, identity, { lastTimestampInjectedAtMs: nowMs });
    }
  } else if (event === 'PreToolUse') {
    if (isMainThread) {
      const dispatch = (plannedAgentCount(input) ?? 0) >= 1 ? formatDispatchAdvisory(facts) : null;
      const tickDue = nowMs - (session.lastTimestampInjectedAtMs ?? 0) >= config.time.tool_tick_min * 60_000;
      const directive = autoDirective ?? ctxAutoSave ?? directiveIfEscalated();
      if (tickDue) {
        injection = composeLine(null, directive);
        session = updateSession(store, identity, { lastTimestampInjectedAtMs: nowMs });
      } else if (directive) {
        injection = directive;
      }
      const notes = [newHandoffNotes(), dispatch].filter((note): note is string => note !== null);
      if (notes.length > 0) injection = [injection, ...notes].filter((part) => part.trim() !== '').join('\n\n');
    } else {
      const spawnPct = session.spawnFiveHourPercent;
      const pausePct = spawnPct !== undefined ? effectivePause(config, spawnPct) : config.auto.subagent_pause_pct;
      const five = facts.fiveHour;
      const sameBlock = session.spawnResetKey === undefined || session.spawnResetKey === blockResetKey(five?.resetsAtMs);
      const pause = shouldPause({
        fiveHourPercent: five !== null && !five.rolledOver ? five.usedPercent : null,
        fiveHourPercentAtSpawn: spawnPct ?? 0,
        contextLevel: facts.context?.level ?? null,
        rolledOver: five?.rolledOver === true || !sameBlock
      }, config);
      const anyCritical = readings(facts).some((reading) => reading.level === 'critical');
      if (pause.pause || anyCritical) {
        injection = formatPauseDirective({ agentId: agentId as string, pausePercent: pausePct, ...(session.parentThreadId ? { parentThreadId: session.parentThreadId } : {}) });
      } else if (nowMs - (session.lastTimestampInjectedAtMs ?? 0) >= config.time.tool_tick_min * 60_000) {
        injection = formatSubagentTickLine(facts, pausePct, nowMs);
        session = updateSession(store, identity, { lastTimestampInjectedAtMs: nowMs });
      }
      if (ctxAutoSave) injection = [ctxAutoSave, injection].filter((part) => part !== '').join('\n\n');
    }
  } else if (event === 'Stop') {
    const lines: string[] = [];
    const directive = autoDirective ?? ctxAutoSave;
    if (directive) lines.push(directive);
    else {
      const escalated = readings(facts).some((reading) => reading.level === 'warn' || reading.level === 'critical');
      if (escalated) {
        const fired = directiveIfEscalated();
        if (fired !== null) {
          lines.push(formatStatusLine(facts, nowMs), '', `End-of-turn reminder: limits remain elevated. Consider saving a checkpoint via \`${checkpointCliPath()} save --thread-id ${threadId}\` before starting the next big step.`);
        }
      }
    }
    // Need-based keepalive: something must be pending for the idle thread.
    let pendingWork: boolean | undefined;
    let launch = false;
    if (isMainThread) {
      const active = activeCheckpoints(root, config);
      registerDeferredResetWake(active, root, threadId, config, store, nowMs);
      pendingWork = active.length > 0 || pendingHandoffs(root, config, threadId).length > 0;
      session = updateSession(store, identity, { pendingWork });
      launch = config.keepalive.enabled && (pendingWork || !config.keepalive.require_pending);
    }
    return done(lines.length > 0 ? contextOutput(event, lines.join('\n')) : emptyOutput(), pendingWork, launch);
  }

  return done(contextOutput(event, injection));
}

/** Stop a thread's pending jobs at a lifecycle boundary (any account). */
export function cancelThreadJobs(store: CodexStore, threadId: string, reason: string, _nowMs: number): void {
  for (const value of store.list('job')) {
    const row = record(value);
    const owner = record(row?.['owner']);
    if (row === null || owner?.['threadId'] !== threadId || typeof row['id'] !== 'string') continue;
    if (row['state'] !== 'scheduled' && row['state'] !== 'queued') continue;
    const next = row['state'] === 'queued'
      ? { ...row, cancelRequested: true, cancelReason: reason, retryable: false }
      : { ...row, state: 'cancelled', cancelReason: reason, retryable: false };
    store.write({ accountId: typeof owner['accountId'] === 'string' ? owner['accountId'] : null, threadId, agentId: `job-${row['id']}` }, 'job', next);
  }
}

function readInput(): TickInput {
  const raw = readFileSync(0, 'utf8');
  if (raw.trim() === '') return {};
  try { return JSON.parse(raw) as TickInput; } catch { return {}; }
}

if (import.meta.main) {
  let input: TickInput = {};
  try {
    input = readInput();
    const store = new CodexStore();
    const result = runTick(input, { store });
    process.stdout.write(result.output + '\n');
    if (result.launchService === true) ensureService(store, Date.now());
  } catch (error) {
    try {
      new CodexStore().write({ accountId: null, threadId: threadIdOf(input) }, 'crash', { atMs: Date.now(), component: 'tick', message: error instanceof Error ? error.message : 'tick failed' });
    } catch { /* breadcrumb is best effort */ }
    process.stdout.write('{}\n');
  }
}
