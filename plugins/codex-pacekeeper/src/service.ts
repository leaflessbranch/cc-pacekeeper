#!/usr/bin/env bun
/** Durable Codex scheduling. Delivery is always through an existing owner. */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { loadCodexConfig, type CodexConfig } from './config';
import { cancelQueuedJob, deliverJob, reconcileJob, type JobPersistence } from './delivery';
import { createJob, cancelIf, KEEPALIVE_PING, advance, type EligibilityInput, type Job, type JobOwner } from './jobs';
import { discoverNativeControlClient, findLiveOwner, nativeControlSocketPath, pidIsAlive } from './live-sessions';
import { NativeClient, normalizeNativeCapabilities, parseCompletedTurn } from './native';
import { clientForExistingOwner } from './native-transport';
import { ACCOUNT_IDENTITY, CodexStore, type StateIdentity } from './storage';
import { buildFacts } from './facts';
import { CodexCheckpoints } from './checkpoint';
import { resolveProjectRoot } from './resolve-root';
import { refreshFromOwner } from './refresh';
import { latestParentUserActivity, samplePresence } from './presence';

export const RESET_WAKE_PREFIX = '[pacekeeper-resume]';

export interface ServiceEligibility extends EligibilityInput {
  /** True only when a pending lane or handoff exists. */
  pendingWork?: boolean;
}

export interface ServiceOptions {
  config?: CodexConfig;
  store?: CodexStore;
  now?: () => number;
  /** Must return a client connected to the selected existing owner. */
  resolveClient?: (owner: JobOwner) => Promise<NativeClient | null>;
  /** Facts are evaluated at schedule and execution time. */
  eligibility?: (job: Job, phase: 'schedule' | 'execute') => ServiceEligibility;
  /** Exact-ID reset consumption; returns true (or an idempotent already-consumed
   * result) only after archive acknowledgement. */
  consumeCheckpoint?: (job: Job, checkpointId: string) => Promise<boolean | 'already-consumed'>;
  /** Production scheduling verifies the exact active checkpoint before wake. */
  checkpointExists?: (owner: JobOwner, checkpointId: string, projectRoot?: string, resetGeneration?: number) => boolean;
  /** Project root recorded for checkpoint existence and reset-wake provenance. */
  projectRoot?: string;
}

export interface ScheduledWake {
  job: Job;
  checkpointId: string;
}

function jobIdentity(job: Job): StateIdentity {
  return { accountId: job.owner.accountId, threadId: job.owner.threadId, agentId: `job-${job.id}` };
}

function ownerKey(owner: JobOwner): string {
  return `${owner.accountId ?? ''}\u0000${owner.threadId}`;
}

function isJob(value: unknown): value is Job {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const owner = row.owner;
  const ownerRow = typeof owner === 'object' && owner !== null ? owner as Record<string, unknown> : null;
  const states = new Set(['scheduled', 'submitting', 'queued', 'running', 'completed', 'cancelled', 'rejected', 'ambiguous']);
  return typeof row.id === 'string' && row.id.trim() !== ''
    && (row.kind === 'keepalive' || row.kind === 'reset-wake')
    && ownerRow !== null
    && typeof ownerRow.threadId === 'string' && ownerRow.threadId.trim() !== ''
    && (ownerRow.accountId === null || typeof ownerRow.accountId === 'string')
    && typeof row.dueAtMs === 'number' && Number.isFinite(row.dueAtMs)
    && typeof row.state === 'string' && states.has(row.state)
    && typeof row.submissionId === 'string' && row.submissionId.trim() !== ''
    && typeof row.retryable === 'boolean'
    && typeof row.pongVerified === 'boolean'
    && (row.turnId === undefined || (typeof row.turnId === 'string' && row.turnId.trim() !== ''))
    && (row.resetGeneration === undefined || (typeof row.resetGeneration === 'number' && Number.isInteger(row.resetGeneration) && row.resetGeneration >= 0));
}

class StorePersistence implements JobPersistence {
  public constructor(private readonly store: CodexStore) {}
  public read(id: string): Job | null {
    const row = this.store.list('job').find((candidate) => isJob(candidate) && candidate.id === id);
    return isJob(row) ? row : null;
  }
  public write(job: Job): void { this.store.write(jobIdentity(job), 'job', job); }
}

function defaultResolver(): (owner: JobOwner) => Promise<NativeClient | null> {
  return async (owner) => {
    const lookup = findLiveOwner(owner.threadId, owner.accountId);
    // A registry proves liveness and endpoint ownership, but it does not prove
    // a method list. Without an observed schema/capability handshake, refusing
    // delivery is safer than constructing a client that guesses queue support.
    if (lookup.status === 'found' && lookup.owner !== undefined && lookup.owner.methods !== undefined) {
      const capabilities = normalizeNativeCapabilities({ version: lookup.owner.protocolVersion, methods: lookup.owner.methods });
      return clientForExistingOwner(lookup.owner, capabilities);
    }
    if (lookup.status === 'absent' || lookup.status === 'unknown') return discoverNativeControlClient(owner.threadId, owner.accountId);
    return null;
  };
}

export class CodexService {
  public readonly config: CodexConfig;
  private readonly store: CodexStore;
  private readonly persistence: StorePersistence;
  private readonly now: () => number;
  private readonly resolveClient: (owner: JobOwner) => Promise<NativeClient | null>;
  private readonly eligibility?: (job: Job, phase: 'schedule' | 'execute') => ServiceEligibility;
  private readonly consumeCheckpoint?: (job: Job, checkpointId: string) => Promise<boolean | 'already-consumed'>;
  private readonly checkpointExists: (owner: JobOwner, checkpointId: string, projectRoot?: string, resetGeneration?: number) => boolean;
  private readonly projectRoot?: string;
  private readonly defaultEligibility: boolean;
  private readonly freshlyObservedOwners = new Set<string>();
  /** When the watcher last tried to bootstrap a keepalive for a thread. */
  private readonly keepaliveAttemptAtMs = new Map<string, number>();
  private readonly refreshFailedOwners = new Set<string>();

  private hasCheckpoint(owner: JobOwner, checkpointId: string, job?: Job, resetGeneration = job?.resetGeneration): boolean {
    try {
      const timeline = job === undefined ? null : this.store.read(jobIdentity(job), 'timeline');
      const root = typeof timeline === 'object' && timeline !== null && typeof (timeline as Record<string, unknown>)['projectRoot'] === 'string'
        ? (timeline as Record<string, unknown>)['projectRoot'] as string
        : this.projectRoot;
      return this.checkpointExists(owner, checkpointId, root, resetGeneration);
    } catch { return false; }
  }

  public constructor(options: ServiceOptions = {}) {
    this.config = options.config ?? loadCodexConfig().config;
    this.store = options.store ?? new CodexStore();
    this.persistence = new StorePersistence(this.store);
    this.now = options.now ?? (() => Date.now());
    this.projectRoot = options.projectRoot;
    this.resolveClient = options.resolveClient ?? defaultResolver();
    this.defaultEligibility = options.eligibility === undefined;
    this.eligibility = options.eligibility ?? ((job, phase) => this.observeEligibility(job, phase));
    this.consumeCheckpoint = options.consumeCheckpoint ?? (async (_job, checkpointId) => {
      try {
        const timeline = this.store.read(jobIdentity(_job), 'timeline');
        const recordedRoot = typeof timeline === 'object' && timeline !== null && typeof (timeline as Record<string, unknown>)['projectRoot'] === 'string'
          ? (timeline as Record<string, unknown>)['projectRoot'] as string
          : undefined;
        const root = recordedRoot ?? this.projectRoot ?? resolveProjectRoot({ processCwd: process.cwd() });
        const checkpoints = new CodexCheckpoints(root, this.config);
        // Any session may resume a lane (Claude semantics), so consumption is
        // proven by the exact id reaching the archive as consumed.
        const archived = checkpoints.listArchived().find((entry) => entry.id === checkpointId && entry.disposition === 'consumed');
        return archived === undefined ? false : 'already-consumed';
      } catch { return false; }
    });
    this.checkpointExists = options.checkpointExists ?? ((owner, checkpointId, projectRoot, resetGeneration) => {
      try {
        const root = projectRoot ?? this.projectRoot ?? resolveProjectRoot({ processCwd: process.cwd() });
        const checkpoints = new CodexCheckpoints(root, this.config);
        return checkpoints.list().some((entry) => entry.id === checkpointId && entry.owner.threadId === owner.threadId && entry.owner.accountId === owner.accountId && entry.resetGeneration === resetGeneration);
      } catch { return false; }
    });
  }

  /**
   * Bootstrap execution gates from facts already observed by the Codex hooks
   * and the explicit owner registry. This is an evidence adapter, not an
   * owner provider: missing rows, account identity, quota clocks or pending
   * state remain unknown and therefore fail closed.
   */
  private observeEligibility(job: Job, _phase: 'schedule' | 'execute'): ServiceEligibility {
    const nowMs = this.now();
    const row = this.threadTimeline(job.owner.threadId);
    const account = this.accountRecord();
    const rateLimits = typeof account['rateLimits'] === 'object' && account['rateLimits'] !== null
      ? account['rateLimits'] as Parameters<typeof buildFacts>[0]['rateLimits']
      : null;
    const tokenUsage = null;
    const quotaObservedAtMs = typeof account['quotaObservedAtMs'] === 'number'
      ? account['quotaObservedAtMs']
      : Number.NaN;
    const ordinaryUsageObservedAtMs = typeof account['ordinaryUsageObservedAtMs'] === 'number'
      ? account['ordinaryUsageObservedAtMs']
      : undefined;
    const authObservedAtMs = typeof account['authObservedAtMs'] === 'number' ? account['authObservedAtMs'] : Number.NaN;
    const authFresh = Number.isFinite(authObservedAtMs) && nowMs >= authObservedAtMs && nowMs - authObservedAtMs <= this.config.usage_freshness_seconds * 1000;
    const authenticated = authFresh && typeof account['authenticated'] === 'boolean' ? account['authenticated'] : null;
    const facts = buildFacts({ rateLimits, observedAtMs: quotaObservedAtMs, ordinaryUsageObservedAtMs, tokenUsage, authenticated }, this.config, nowMs);
    const ownerStatus = findLiveOwner(job.owner.threadId, job.owner.accountId).status;
    const refreshFailed = this.refreshFailedOwners.has(ownerKey(job.owner));
    // Idle is measured from the last real hook event: the ping's own turn is
    // transparent to the tick, so it never resets this clock.
    const lastEventAtMs = typeof row['lastEventAtMs'] === 'number' ? row['lastEventAtMs'] : undefined;
    const pendingWork = typeof row['pendingWork'] === 'boolean' ? row['pendingWork'] : undefined;
    return {
      nowMs,
      enabled: job.kind === 'keepalive' ? this.config.keepalive.enabled : this.config.auto.enabled,
      capacity: facts.capacity,
      fresh: !facts.stale && !refreshFailed,
      // The current CLI publishes a real control socket instead of the
      // optional package registry. Execution still verifies the loaded thread
      // through that endpoint before sending anything.
      ownerLive: !refreshFailed && (this.freshlyObservedOwners.has(ownerKey(job.owner))
        || ownerStatus === 'found'
        || ((ownerStatus === 'absent' || ownerStatus === 'unknown') && nativeControlSocketPath() !== null)),
      ...(pendingWork === undefined ? {} : { pendingWork }),
      ...(lastEventAtMs === undefined ? {} : { idleForMs: Math.max(0, nowMs - lastEventAtMs) }),
      strict: true,
      ...(job.kind === 'keepalive' ? { requirePending: this.config.keepalive.require_pending } : {})
    };
  }

  private threadTimeline(threadId: string): Record<string, unknown> {
    const value = this.store.read({ accountId: null, threadId }, 'timeline');
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  }

  private accountRecord(): Record<string, unknown> {
    const value = this.store.read(ACCOUNT_IDENTITY, 'account');
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  }

  /** A keepalive is due one full interval after the thread's last real event. */
  private keepaliveDueAt(threadId: string, notBefore: number): number {
    const last = this.threadTimeline(threadId)['lastEventAtMs'];
    const fromActivity = typeof last === 'number' ? last + this.config.keepalive.interval_min * 60_000 : notBefore;
    return Math.max(notBefore, fromActivity);
  }

  /** Whether a watcher pass could still have something to deliver. */
  public hasWork(nowMs = this.now()): boolean {
    if (this.jobs().some((job) => job.state === 'scheduled' || job.state === 'queued' || job.state === 'submitting' || job.state === 'running')) return true;
    if (!this.config.keepalive.enabled) return false;
    return this.store.list('timeline').some((value) => {
      if (typeof value !== 'object' || value === null) return false;
      const row = value as Record<string, unknown>;
      if (row['agentId'] !== undefined || typeof row['sessionEndedAtMs'] === 'number') return false;
      if (row['pendingWork'] !== true && this.config.keepalive.require_pending) return false;
      const last = row['lastEventAtMs'];
      return typeof last === 'number' && nowMs - last < this.config.keepalive.max_idle_hours * 3_600_000;
    });
  }

  public jobs(): Job[] {
    return this.store.list('job').filter(isJob).sort((a, b) => a.dueAtMs - b.dueAtMs);
  }

  public parentUserActivityAtMs(nowMs = this.now()): number | null {
    return latestParentUserActivity(this.store, nowMs);
  }

  /** Durably stop owner jobs before a lifecycle boundary can schedule again. */
  public cancelOwnerJobs(owner: JobOwner, reason: string): Job[] {
    const changed: Job[] = [];
    for (const job of this.jobs()) {
      if (job.owner.accountId !== owner.accountId || job.owner.threadId !== owner.threadId) continue;
      if (job.state !== 'scheduled' && job.state !== 'queued') continue;
      const next = job.state === 'queued'
        ? { ...job, cancelRequested: true, cancelReason: reason, retryable: false }
        : { ...job, state: 'cancelled' as const, cancelReason: reason, retryable: false };
      this.persistence.write(next);
      changed.push(next);
    }
    return changed;
  }

  private existing(kind: Job['kind'], owner: JobOwner, resetGeneration?: number): Job | undefined {
    // An interrupted submit is still live until its stable client id has been
    // reconciled. Returning it here prevents a second deterministic schedule
    // call from sending a duplicate while the first attempt is unknown.
    return this.jobs().find((job) => job.kind === kind && job.owner.threadId === owner.threadId && job.owner.accountId === owner.accountId && job.resetGeneration === resetGeneration && !['completed', 'cancelled', 'rejected'].includes(job.state));
  }

  private schedule(job: Job): Job {
    // A reset wake is intentionally scheduled before the reset has happened.
    // Its native window check belongs to the due-time execution gate below;
    // evaluating the cached pre-reset facts here would cancel every future
    // wake before its checkpoint timeline is written.
    const phase = job.kind === 'reset-wake' ? undefined : this.eligibility?.(job, 'schedule');
    if (phase) {
      const checked = cancelIf(job, this.withServiceGates(job, phase, phase.nowMs ?? this.now()));
      if (checked.state === 'cancelled') { this.persistence.write(checked); return checked; }
    }
    this.persistence.write(job);
    return job;
  }

  /** Refresh quota/auth through the selected existing owner before a gate. */
  private async refreshOwnerFacts(owner: JobOwner, client: NativeClient): Promise<boolean> {
    const key = ownerKey(owner);
    if (client.capabilities.accountRateLimits !== 'supported') {
      this.refreshFailedOwners.add(key);
      return false;
    }
    const refreshed = await refreshFromOwner(client, {
      accountId: owner.accountId,
      threadId: owner.threadId
    }, this.store, { nowMs: this.now() });
    if (refreshed === null) {
      // An account mismatch or failed native read invalidates the cached
      // account/quota facts for this service pass. A live socket alone cannot
      // authorize delivery to the job's recorded owner.
      this.refreshFailedOwners.add(key);
      return false;
    }
    this.refreshFailedOwners.delete(key);
    this.freshlyObservedOwners.add(key);
    return true;
  }

  /** Materialize jobs from observed pending-work timelines for the service loop. */
  private async schedulePendingKeepalives(): Promise<void> {
    if (this.config.keepalive.enabled !== true) return;
    for (const candidate of this.store.list('timeline')) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const row = candidate as Record<string, unknown>;
      if (row['kind'] === 'reset-wake' || row['agentId'] !== undefined || typeof row['sessionEndedAtMs'] === 'number') continue;
      if (row['pendingWork'] !== true && this.config.keepalive.require_pending) continue;
      const accountId = typeof row['accountId'] === 'string' && row['accountId'].trim() !== '' ? row['accountId'] : null;
      const threadId = typeof row['threadId'] === 'string' && row['threadId'].trim() !== '' ? row['threadId'] : null;
      if (accountId === null || threadId === null || this.existing('keepalive', { accountId, threadId }) !== undefined) continue;
      // Past the idle ceiling the chain has given up; the next real event
      // (which advances lastEventAtMs) re-arms it, as in the Claude package.
      const lastEventAtMs = typeof row['lastEventAtMs'] === 'number' ? row['lastEventAtMs'] : null;
      if (lastEventAtMs === null || this.now() - lastEventAtMs >= this.config.keepalive.max_idle_hours * 3_600_000) continue;
      if (this.defaultEligibility) {
        // A thread whose owner is gone stays pending until it ages out; probe
        // it every few minutes, not on every 20-second pass.
        const attemptedAt = this.keepaliveAttemptAtMs.get(threadId);
        if (attemptedAt !== undefined && this.now() - attemptedAt < 5 * 60_000) continue;
        this.keepaliveAttemptAtMs.set(threadId, this.now());
        const client = await this.resolveClient({ accountId, threadId });
        if (client === null || !(await this.refreshOwnerFacts({ accountId, threadId }, client))) continue;
      }
      const job = createJob({ kind: 'keepalive', owner: { accountId, threadId }, dueAtMs: this.keepaliveDueAt(threadId, this.now()), submissionId: stableId() });
      const scheduled = this.schedule(job);
      if (scheduled.state === 'cancelled') this.store.remove(jobIdentity(scheduled), 'job');
    }
  }

  /** Add package-owned gates that an eligibility producer must measure. */
  private withServiceGates(job: Job, phase: ServiceEligibility, nowMs: number): ServiceEligibility {
    return {
      ...phase,
      nowMs,
      ...(job.kind === 'keepalive' && phase.maxIdleMs === undefined
        ? { maxIdleMs: this.config.keepalive.max_idle_hours * 60 * 60_000 }
        : {}),
      ...(job.kind === 'keepalive' ? { requirePending: this.config.keepalive.require_pending } : {}),
      strict: true
    };
  }

  /** Schedule one recurring identity; duplicate calls return the live record. */
  public scheduleKeepalive(owner: JobOwner, dueAtMs = this.now() + this.config.keepalive.interval_min * 60_000): Job {
    if (this.config.keepalive.enabled !== true) throw new Error('keepalive is disabled');
    if (this.config.keepalive.require_pending && !this.eligibility) throw new Error('keepalive requires an observed pending-work eligibility callback');
    if (owner.accountId === null || owner.threadId.trim() === '') throw new Error('keepalive requires a known account and thread');
    const existing = this.existing('keepalive', owner);
    if (existing) return existing;
    return this.schedule(createJob({ kind: 'keepalive', owner, dueAtMs, submissionId: stableId() }));
  }

  /** Schedule a one-shot wake only after the caller has a saved checkpoint. */
  public scheduleResetWake(owner: JobOwner, checkpointId: string, resetAtMs: number, resetGeneration: number): ScheduledWake {
    if (!Number.isFinite(resetAtMs) || !Number.isInteger(resetGeneration) || resetGeneration < 0) throw new Error('reset wake requires a valid reset generation and timestamp');
    if (checkpointId.trim() === '') throw new Error('reset wake requires an exact checkpoint id');
    if (owner.accountId === null || owner.threadId.trim() === '') throw new Error('reset wake requires a known account and thread');
    if (this.config.auto.enabled !== true) throw new Error('reset wake is disabled (auto.enabled is false)');
    // A five-hour reset is at most five hours out; the Claude package's wake
    // one-shot is scheduled for any reset in the block, and so is this one.
    if (resetAtMs - this.now() > 5 * 3_600_000 + 60_000) throw new Error('reset wake time is more than one five-hour block away');
    if (!this.hasCheckpoint(owner, checkpointId, undefined, resetGeneration)) throw new Error('reset wake checkpoint was not found for this owner');
    const existing = this.jobs().find((job) => job.kind === 'reset-wake' && job.owner.threadId === owner.threadId && job.owner.accountId === owner.accountId && job.resetGeneration === resetGeneration);
    let projectRoot: string | undefined = this.projectRoot;
    try { projectRoot ??= resolveProjectRoot({ processCwd: process.cwd() }); } catch { /* checkpointExists may be injected for a caller-owned root */ }
    if (existing) {
      const metadata = this.store.read(jobIdentity(existing), 'timeline');
      const row = typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : null;
      if (row?.['resetAtMs'] !== resetAtMs || row['resetGeneration'] !== resetGeneration) {
        throw new Error('registered reset wake has a conflicting reset identity');
      }
      if (row['checkpointId'] === checkpointId && row['projectRoot'] === projectRoot) return { job: existing, checkpointId };
      if (existing.state !== 'scheduled') throw new Error('registered reset wake has already started; its checkpoint cannot be replaced');
      this.store.write(jobIdentity(existing), 'timeline', { ...row, checkpointId, ...(projectRoot ? { projectRoot } : {}) });
      return { job: existing, checkpointId };
    }
    const job = createJob({ kind: 'reset-wake', owner, dueAtMs: resetAtMs + this.config.auto.wake_delay_min * 60_000, submissionId: stableId(), resetGeneration });
    this.store.write(jobIdentity(job), 'timeline', { checkpointId, resetGeneration, resetAtMs, kind: 'reset-wake', ...(projectRoot ? { projectRoot } : {}) });
    return { job: this.schedule(job), checkpointId };
  }

  /**
   * A reset timestamp on a saved checkpoint is an expected boundary, not
   * proof that the native five-hour window rolled over. Delivery waits for a
   * fresh, post-boundary native bucket with a new reset identity.
   */
  private resetWindowReadiness(job: Job, nowMs: number): { ready: boolean; reason: string } {
    const timeline = this.store.read(jobIdentity(job), 'timeline');
    if (typeof timeline !== 'object' || timeline === null) return { ready: false, reason: 'reset wake timeline is unavailable' };
    const row = timeline as Record<string, unknown>;
    const resetAtMs = typeof row['resetAtMs'] === 'number' && Number.isFinite(row['resetAtMs']) ? row['resetAtMs'] : null;
    const generation = typeof row['resetGeneration'] === 'number' && Number.isInteger(row['resetGeneration']) ? row['resetGeneration'] : null;
    if (resetAtMs === null || generation === null || job.resetGeneration === undefined || generation !== job.resetGeneration) {
      return { ready: false, reason: 'reset wake identity does not match its saved timeline' };
    }
    const factsRow = this.accountRecord();
    const observedAtMs = typeof factsRow['quotaObservedAtMs'] === 'number' ? factsRow['quotaObservedAtMs'] : null;
    if (observedAtMs === null || observedAtMs <= resetAtMs || observedAtMs > nowMs) {
      return { ready: false, reason: 'the five-hour reading was not freshly observed after the intended reset' };
    }
    const rateLimits = typeof factsRow['rateLimits'] === 'object' && factsRow['rateLimits'] !== null
      ? factsRow['rateLimits'] as Parameters<typeof buildFacts>[0]['rateLimits']
      : null;
    const authenticated = typeof factsRow['authenticated'] === 'boolean' ? factsRow['authenticated'] : null;
    const ordinaryUsageObservedAtMs = typeof factsRow['ordinaryUsageObservedAtMs'] === 'number' ? factsRow['ordinaryUsageObservedAtMs'] : undefined;
    const facts = buildFacts({
      rateLimits,
      observedAtMs: observedAtMs ?? Number.NaN,
      ordinaryUsageObservedAtMs,
      tokenUsage: null,
      authenticated
    }, this.config, nowMs);
    if (facts.stale) return { ready: false, reason: 'the post-reset five-hour reading is stale' };
    if (facts.capacity !== 'included') return { ready: false, reason: `reset capacity is ${facts.capacity}, not confirmed included` };
    const window = facts.fiveHour;
    if (window === null || window.resetsAtMs === null) return { ready: false, reason: 'the refreshed five-hour window is unavailable' };
    if (window.rolledOver || window.resetsAtMs <= nowMs) return { ready: false, reason: 'the refreshed five-hour window is still ended' };
    if (window.resetsAtMs <= resetAtMs) return { ready: false, reason: 'the refreshed five-hour window has the unchanged reset identity' };
    return { ready: true, reason: 'the refreshed five-hour window is active after the intended reset' };
  }

  private checkpointId(job: Job): string | null {
    const value = this.store.read(jobIdentity(job), 'timeline');
    if (typeof value !== 'object' || value === null) return null;
    const id = (value as Record<string, unknown>)['checkpointId'];
    return typeof id === 'string' && id !== '' ? id : null;
  }

  private sessionEnded(job: Job): boolean {
    const row = this.threadTimeline(job.owner.threadId);
    const ended = typeof row['sessionEndedAtMs'] === 'number' ? row['sessionEndedAtMs'] : undefined;
    if (ended === undefined) return false;
    const started = typeof row['sessionStartedAtMs'] === 'number' ? row['sessionStartedAtMs'] : undefined;
    return started === undefined || ended >= started;
  }

  private async observeNativeCompletion(job: Job, client: NativeClient): Promise<Job> {
    if (client.capabilities.threadRead !== 'supported') return job;
    try {
      const observed = parseCompletedTurn(await client.readThread(job.owner.threadId), job.submissionId);
      if (observed === null) return job;
      if (job.kind === 'reset-wake') {
        return await this.recordResetWakeCompletion(job.id, observed.result, true, observed.toolCalls, job.submissionId, observed.turnId) ?? job;
      }
      return this.recordCompletion(job.id, observed.result, true, observed.toolCalls, job.submissionId, observed.turnId) ?? job;
    } catch {
      return job;
    }
  }

  private scheduleNextKeepalive(job: Job): void {
    // Prompt-level parity with the Claude keepalive: a completed ping turn kept
    // the cache warm whatever the model replied. A non-exact reply or a tool
    // call is recorded on the job (pongVerified=false) for doctor, not fatal.
    if (job.kind !== 'keepalive' || job.state !== 'completed' || this.config.keepalive.enabled !== true) return;
    if (this.config.keepalive.require_pending && this.eligibility === undefined) return;
    const active = this.existing('keepalive', job.owner);
    if (active !== undefined) return;
    const next = createJob({
      kind: 'keepalive',
      owner: job.owner,
      dueAtMs: this.keepaliveDueAt(job.owner.threadId, this.now() + this.config.keepalive.interval_min * 60_000),
      submissionId: stableId()
    });
    this.schedule({ ...next, ...(job.pongVerified ? {} : { failureReason: `previous ping replied ${JSON.stringify(job.result ?? '')} with ${job.toolCalls ?? '?'} tool call(s)` }) });
  }

  /** Execute due scheduled jobs and acknowledge queued cancellations. */
  public async runDueJobs(): Promise<Job[]> {
    this.freshlyObservedOwners.clear();
    this.refreshFailedOwners.clear();
    await this.schedulePendingKeepalives();
    const nowMs = this.now();
    const results: Job[] = [];
    for (const original of this.jobs()) {
      let job = original;
      let client: NativeClient | null = null;
      if (job.state === 'scheduled' && job.kind === 'keepalive') {
        // Activity since scheduling pushes the ping out: it fires only after
        // a full idle interval, never into a session that is being used.
        const dueAtMs = this.keepaliveDueAt(job.owner.threadId, job.dueAtMs);
        if (dueAtMs !== job.dueAtMs) {
          job = { ...job, dueAtMs };
          this.persistence.write(job);
        }
      }
      // Nothing to do for a scheduled job before its time: skip the native
      // round trips (and the owner refresh) until it is due.
      if (job.state === 'scheduled' && job.dueAtMs > nowMs && !this.sessionEnded(job)) continue;
      if (job.state === 'scheduled' || job.state === 'queued') {
        // A watcher may run long after the last hook event. Refresh through
        // the already selected owner before evaluating any execution gate;
        // failed reads leave the cached clocks stale and therefore closed.
        client = await this.resolveClient(job.owner);
        if (client !== null && this.defaultEligibility) await this.refreshOwnerFacts(job.owner, client);
      }
      if ((job.state === 'scheduled' || job.state === 'queued') && this.sessionEnded(job)) {
        const requested = cancelIf(job, { nowMs, enabled: false, strict: false });
        this.persistence.write(requested);
        if (requested.state === 'queued' && requested.cancelRequested && client !== null) {
          job = (await cancelQueuedJob(client, requested, 'session ended', this.persistence)).job;
        } else {
          job = requested;
        }
        results.push(job);
        continue;
      }
      if ((job.state === 'scheduled' || job.state === 'queued') && this.refreshFailedOwners.has(ownerKey(job.owner))) {
        // Keep the job withheld when the selected endpoint cannot prove the
        // recorded account. A live socket or old cached timeline must not
        // turn an account switch into an authorized delivery.
        const withheld = job.state === 'queued'
          ? { ...job, cancelRequested: true, cancelReason: 'native owner refresh did not match the recorded account', retryable: false }
          : { ...job, failureReason: 'native owner refresh did not match the recorded account' };
        this.persistence.write(withheld);
        results.push(withheld);
        continue;
      }
      if (job.state === 'queued' && !job.cancelRequested) {
        const phase = this.eligibility?.(job, 'execute') ?? {
          nowMs,
          strict: true,
          ...(job.kind === 'keepalive' ? { maxIdleMs: this.config.keepalive.max_idle_hours * 60 * 60_000, requirePending: this.config.keepalive.require_pending } : {})
        };
        const checked = cancelIf(job, this.withServiceGates(job, phase, nowMs));
        if (checked.cancelRequested) {
          this.persistence.write(checked);
          job = checked;
        }
      }
      if (job.state === 'queued' && job.cancelRequested) {
        if (client) job = (await cancelQueuedJob(client, job, job.cancelReason ?? 'eligibility changed', this.persistence)).job;
        results.push(job);
        continue;
      }
      if (job.state === 'queued' && !job.cancelRequested) {
        if (client !== null) {
          const observed = await this.observeNativeCompletion(job, client);
          if (observed.state !== job.state || observed.pongVerified) {
            results.push(observed);
            continue;
          }
        }
      }
      // Recover an interrupted submission before considering any new send.
      // A queue miss transitions submitting to ambiguous and remains
      // non-retryable; it never falls through to deliverJob.
      if (job.state === 'submitting' || job.state === 'ambiguous') {
        const client = await this.resolveClient(job.owner);
        if (client) job = (await reconcileJob(client, job, this.persistence)).job;
        results.push(job);
        continue;
      }
      if (job.state !== 'scheduled' || job.dueAtMs > nowMs) continue;
      const phase = this.eligibility?.(job, 'execute');
      const checked = phase
        ? cancelIf(job, this.withServiceGates(job, phase, nowMs))
        : cancelIf(job, { nowMs, strict: true, ...(job.kind === 'keepalive' ? { maxIdleMs: this.config.keepalive.max_idle_hours * 60 * 60_000, requirePending: this.config.keepalive.require_pending } : {}) });
      if (checked.state === 'cancelled') { this.persistence.write(checked); results.push(checked); continue; }
      const checkpointId = job.kind === 'reset-wake' ? this.checkpointId(job) : null;
      if (job.kind === 'reset-wake' && checkpointId === null) {
        const invalid = advance(job, { type: 'ambiguous', reason: 'reset wake has no exact checkpoint identity' });
        this.persistence.write(invalid);
        results.push(invalid);
        continue;
      }
      if (job.kind === 'reset-wake' && checkpointId !== null && !this.hasCheckpoint(job.owner, checkpointId, job)) {
        const cancelled = { ...job, state: 'cancelled' as const, retryable: false, cancelReason: 'reset checkpoint is no longer active for this owner' };
        this.persistence.write(cancelled);
        results.push(cancelled);
        continue;
      }
      if (job.kind === 'reset-wake') {
        const reset = this.resetWindowReadiness(job, nowMs);
        if (!reset.ready) {
          const withheld = { ...checked, failureReason: `reset wake withheld: ${reset.reason}` };
          this.persistence.write(withheld);
          results.push(withheld);
          continue;
        }
      }
      if (client === null) client = await this.resolveClient(job.owner);
      if (!client) {
        const unavailable = advance(job, { type: 'ambiguous', reason: 'existing owner or native transport was not available' });
        this.persistence.write(unavailable);
        results.push(unavailable);
        continue;
      }
      if (client.capabilities.queue !== 'supported') {
        const blocked = advance(job, { type: 'rejected', reason: 'the native owner does not offer thread/queue/add' });
        this.persistence.write(blocked);
        results.push(blocked);
        continue;
      }
      // Delivery parity with the Claude package: the ping and the wake are
      // ordinary prompts whose hook-injected guidance tells the model what to
      // do (pong without tools; resume the checkpoint). Codex starts a queued
      // message only once the thread is idle, as Claude's cron fires.
      const message = job.kind === 'keepalive'
        ? KEEPALIVE_PING
        : `${RESET_WAKE_PREFIX} ${checkpointId} — the five-hour block has renewed; resume this checkpoint and continue.`;
      const delivered = await deliverJob(client, job, message, this.persistence);
      results.push(delivered.job);
    }
    return results;
  }

  public async reconcile(jobId: string): Promise<Job | null> {
    const job = this.persistence.read(jobId);
    if (!job) return null;
    const client = await this.resolveClient(job.owner);
    if (!client) return job;
    return (await reconcileJob(client, job, this.persistence)).job;
  }

  /** Native completion is recorded separately from queue acceptance. */
  public recordCompletion(jobId: string, result: string, nativeCompleted?: boolean, toolCalls?: number, submissionId?: string, turnId?: string, scheduleSuccessor = true): Job | null {
    const job = this.persistence.read(jobId);
    if (!job) return null;
    // A recurring job id is intentionally reused for its next interval. The
    // native submission id is therefore mandatory for a completion receipt;
    // an old receipt must become a no-op when the successor occupies that id.
    if (submissionId === undefined || submissionId !== job.submissionId) return job;
    if (turnId !== undefined && job.turnId !== undefined && turnId !== job.turnId) return job;
    if (job.kind === 'reset-wake') {
      const blocked = advance(job, { type: 'ambiguous', reason: 'reset wake completion requires an exact checkpoint archive acknowledgement' });
      this.persistence.write(blocked);
      return blocked;
    }
    const next = advance(job, { type: 'completed', result, nativeCompleted, toolCalls, submissionId, ...(turnId ? { turnId } : {}) });
    this.persistence.write(next);
    if (scheduleSuccessor) this.scheduleNextKeepalive(next);
    return next;
  }

  /** Complete a reset wake only after the exact checkpoint consumer confirms archival. */
  public async recordResetWakeCompletion(jobId: string, result: string, nativeCompleted?: boolean, toolCalls?: number, submissionId?: string, turnId?: string): Promise<Job | null> {
    const job = this.persistence.read(jobId);
    if (!job || job.kind !== 'reset-wake') return null;
    if (submissionId === undefined || submissionId !== job.submissionId) return job;
    // A reset wake may run the checkpoint CLI and therefore legitimately use
    // tools. Its completion receipt still needs the exact native turn that
    // consumed this stable submission id; a result without that correlation
    // is not evidence that the resumed body was absorbed.
    if (turnId === undefined || turnId.trim() === '') return job;
    if (job.turnId !== undefined && turnId !== job.turnId) return job;
    const checkpointId = this.checkpointId(job);
    if (!checkpointId || !this.consumeCheckpoint) {
      const blocked = advance(job, { type: 'ambiguous', reason: 'reset wake has no verified checkpoint consumer' });
      this.persistence.write(blocked);
      return blocked;
    }
    if (nativeCompleted !== true || toolCalls === undefined || !Number.isInteger(toolCalls) || toolCalls < 0) {
      // The native turn did not provide a complete, independently observed
      // receipt. Keep the checkpoint recoverable and make this attempt
      // terminal rather than claiming the wake completed.
      const incomplete = advance(job, { type: 'ambiguous', reason: 'reset wake completion lacked native completion or tool-use evidence' });
      this.persistence.write(incomplete);
      return incomplete;
    }
    let acknowledged = false;
    try {
      const consumed = await this.consumeCheckpoint(job, checkpointId);
      // If the service crashed after the archive rename but before its own
      // completion write, replaying the same exact id is safe and idempotent.
      acknowledged = consumed === true || consumed === 'already-consumed';
    } catch { acknowledged = false; }
    if (!acknowledged) {
      const blocked = advance(job, { type: 'ambiguous', reason: 'checkpoint archive acknowledgement was not verified' });
      this.persistence.write(blocked);
      return blocked;
    }
    const completed = advance(job, { type: 'completed', result, nativeCompleted, toolCalls, submissionId, ...(turnId ? { turnId } : {}) });
    this.persistence.write(completed);
    return completed;
  }

  public async cancel(jobId: string, reason: string): Promise<Job | null> {
    const job = this.persistence.read(jobId);
    if (!job) return null;
    if (job.state === 'queued' && job.queuedSubmissionId) {
      // Persist the cancellation intent before resolving the owner. If the
      // owner is currently unavailable, a later service pass must still know
      // that this queued message must be deleted rather than delivered.
      const requested = { ...job, cancelRequested: true, cancelReason: reason, retryable: false };
      this.persistence.write(requested);
      const client = await this.resolveClient(job.owner);
      if (!client) return requested;
      return (await cancelQueuedJob(client, requested, reason, this.persistence)).job;
    }
    const next = cancelIf(job, { nowMs: this.now(), enabled: false, strict: false });
    const cancelled = { ...next, cancelReason: reason };
    this.persistence.write(cancelled);
    return cancelled;
  }
}

function stableId(): string { return randomUUID(); }

const SERVICE_IDENTITY: StateIdentity = { accountId: null, threadId: 'service' };

function watchLockFile(store: CodexStore): string {
  return path.join(path.dirname(store.pathFor(SERVICE_IDENTITY, 'service')), 'watch.lock');
}

/** One watcher per machine: an exclusive lock file holding the owner's pid. */
export function acquireWatchLock(store: CodexStore): boolean {
  const file = watchLockFile(store);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      let pid = Number.NaN;
      try { pid = Number(fs.readFileSync(file, 'utf8').trim()); } catch { /* unreadable lock is stale */ }
      if (pidIsAlive(pid)) return false;
      try { fs.unlinkSync(file); } catch { /* another launcher won the race */ }
    }
  }
  return false;
}

export function releaseWatchLock(store: CodexStore): void {
  const file = watchLockFile(store);
  try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* already gone */ }
}

const DAY_MS = 86_400_000;

/** Bound the state directories: hooks never list them, but nothing else
 * deletes a finished thread's records. */
export function pruneState(store: CodexStore, nowMs: number): void {
  const live = (value: unknown): boolean => {
    const state = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['state'] : undefined;
    return state === 'scheduled' || state === 'queued' || state === 'submitting' || state === 'running';
  };
  store.prune('job', 7 * DAY_MS, nowMs, live);
  store.prune('timeline', 14 * DAY_MS, nowMs);
  store.prune('debounce', 14 * DAY_MS, nowMs);
  store.prune('owner', 30 * DAY_MS, nowMs);
  store.prune('crash', 30 * DAY_MS, nowMs);
}

export interface ServiceCommand {
  action: string;
  flags: Record<string, string | boolean>;
}

export function parseServiceArgs(args: readonly string[]): ServiceCommand {
  const flags: Record<string, string | boolean> = {};
  let action = 'run';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      if (action === 'run') action = arg;
      continue;
    }
    const equal = arg.indexOf('=');
    if (equal > 2) {
      flags[arg.slice(2, equal)] = arg.slice(equal + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { action, flags };
}

function serviceStringFlag(command: ServiceCommand, name: string): string | undefined {
  const value = command.flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function requiredServiceString(command: ServiceCommand, name: string): string {
  const value = serviceStringFlag(command, name);
  if (value === undefined) throw new Error(`schedule-reset requires --${name}`);
  return value;
}

function requiredServiceNumber(command: ServiceCommand, name: string, integer = false): number {
  const raw = requiredServiceString(command, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new Error(`schedule-reset requires a valid numeric --${name}`);
  return value;
}

async function main(): Promise<void> {
  const command = parseServiceArgs(process.argv.slice(2));
  const action = command.action;
  if (action === 'schedule-reset') {
    const cwd = serviceStringFlag(command, 'cwd');
    const projectRoot = resolveProjectRoot({ cwdFlag: cwd, processCwd: process.cwd() });
    const service = new CodexService({ projectRoot });
    const accountId = requiredServiceString(command, 'account-id');
    const threadId = requiredServiceString(command, 'thread-id');
    const checkpointId = requiredServiceString(command, 'checkpoint-id');
    const resetAtMs = requiredServiceNumber(command, 'reset-at-ms');
    const resetGeneration = requiredServiceNumber(command, 'reset-generation', true);
    const wake = service.scheduleResetWake({ accountId, threadId }, checkpointId, resetAtMs, resetGeneration);
    process.stdout.write(JSON.stringify(wake) + '\n');
    return;
  }
  const service = new CodexService();
  if (action === 'run' || action === 'tick') {
    process.stdout.write(JSON.stringify(await service.runDueJobs()) + '\n');
    return;
  }
  if (action === 'watch') {
    const store = new CodexStore();
    if (!acquireWatchLock(store)) return;
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.on(signal, () => { releaseWatchLock(store); process.exit(0); });
    }
    const intervalMs = 20_000;
    let idlePasses = 0;
    let lastPruneAtMs = 0;
    try {
      while (true) {
        const nowMs = Date.now();
        store.write(SERVICE_IDENTITY, 'service', { pid: process.pid, heartbeatAtMs: nowMs });
        try {
          const lastUserActivityAtMs = service.parentUserActivityAtMs(nowMs);
          const hookGapMs = lastUserActivityAtMs === null ? null : Math.max(0, nowMs - lastUserActivityAtMs);
          samplePresence(service.config, nowMs, hookGapMs);
        } catch { /* presence diagnostics remain in its state file */ }
        await service.runDueJobs();
        if (nowMs - lastPruneAtMs > 3_600_000) { pruneState(store, nowMs); lastPruneAtMs = nowMs; }
        // Exit once nothing could need a delivery; the next Stop hook or
        // checkpoint save relaunches the watcher when work appears again.
        idlePasses = service.hasWork(nowMs) ? 0 : idlePasses + 1;
        if (idlePasses >= 3) break;
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    } finally {
      releaseWatchLock(store);
    }
    return;
  }
  if (action === 'list') { process.stdout.write(JSON.stringify(service.jobs()) + '\n'); return; }
  process.stderr.write('usage: pacekeeper-service run|watch|list|schedule-reset [flags]\n');
  process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`codex-pacekeeper service error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
