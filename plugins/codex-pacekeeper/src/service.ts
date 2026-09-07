#!/usr/bin/env bun
/** Durable Codex scheduling. Delivery is always through an existing owner. */
import { randomUUID } from 'crypto';
import { loadCodexConfig, type CodexConfig } from './config';
import { cancelQueuedJob, deliverJob, reconcileJob, type JobPersistence } from './delivery';
import { createJob, cancelIf, KEEPALIVE_PING, advance, type EligibilityInput, type Job, type JobOwner } from './jobs';
import { findLiveOwner } from './live-sessions';
import { NativeClient, normalizeNativeCapabilities } from './native';
import { clientForExistingOwner } from './native-transport';
import { CodexStore, type StateIdentity } from './storage';
import { buildFacts } from './facts';

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
}

export interface ScheduledWake {
  job: Job;
  checkpointId: string;
}

function jobIdentity(job: Job): StateIdentity {
  return { accountId: job.owner.accountId, threadId: job.owner.threadId, agentId: `job-${job.id}` };
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
    if (lookup.status !== 'found' || lookup.owner === undefined) return null;
    if (lookup.owner.methods === undefined) return null;
    const capabilities = normalizeNativeCapabilities({ version: lookup.owner.protocolVersion, methods: lookup.owner.methods });
    return clientForExistingOwner(lookup.owner, capabilities);
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

  public constructor(options: ServiceOptions = {}) {
    this.config = options.config ?? loadCodexConfig().config;
    this.store = options.store ?? new CodexStore();
    this.persistence = new StorePersistence(this.store);
    this.now = options.now ?? (() => Date.now());
    this.resolveClient = options.resolveClient ?? defaultResolver();
    this.eligibility = options.eligibility ?? ((job, phase) => this.observeEligibility(job, phase));
    this.consumeCheckpoint = options.consumeCheckpoint;
  }

  /**
   * Bootstrap execution gates from facts already observed by the Codex hooks
   * and the explicit owner registry. This is an evidence adapter, not an
   * owner provider: missing rows, account identity, quota clocks or pending
   * state remain unknown and therefore fail closed.
   */
  private observeEligibility(job: Job, _phase: 'schedule' | 'execute'): ServiceEligibility {
    const nowMs = this.now();
    const timeline = this.store.read({ accountId: job.owner.accountId, threadId: job.owner.threadId }, 'timeline');
    const row = typeof timeline === 'object' && timeline !== null ? timeline as Record<string, unknown> : {};
    const rateLimits = typeof row['rateLimits'] === 'object' && row['rateLimits'] !== null
      ? row['rateLimits'] as Parameters<typeof buildFacts>[0]['rateLimits']
      : null;
    const contextObservedAtMs = typeof row['contextObservedAtMs'] === 'number' ? row['contextObservedAtMs'] : Number.NaN;
    const contextFresh = Number.isFinite(contextObservedAtMs) && nowMs >= contextObservedAtMs && nowMs - contextObservedAtMs <= this.config.usage_freshness_seconds * 1000;
    const tokenUsage = contextFresh ? row['tokenUsage'] ?? null : null;
    const quotaObservedAtMs = typeof row['quotaObservedAtMs'] === 'number'
      ? row['quotaObservedAtMs']
      : Number.NaN;
    const authObservedAtMs = typeof row['authObservedAtMs'] === 'number' ? row['authObservedAtMs'] : Number.NaN;
    const authFresh = Number.isFinite(authObservedAtMs) && nowMs >= authObservedAtMs && nowMs - authObservedAtMs <= this.config.usage_freshness_seconds * 1000;
    const authenticated = authFresh && typeof row['authenticated'] === 'boolean' ? row['authenticated'] : null;
    const facts = buildFacts({ rateLimits, observedAtMs: quotaObservedAtMs, tokenUsage, authenticated }, this.config, nowMs);
    const ownerStatus = findLiveOwner(job.owner.threadId, job.owner.accountId).status;
    const lastUserActivityAtMs = typeof row['lastUserActivityAtMs'] === 'number' ? row['lastUserActivityAtMs'] : undefined;
    const pendingWork = typeof row['pendingWork'] === 'boolean' ? row['pendingWork'] : undefined;
    return {
      nowMs,
      enabled: job.kind === 'keepalive' ? this.config.keepalive.enabled : this.config.auto.enabled,
      capacity: facts.capacity,
      fresh: !facts.stale,
      ownerLive: ownerStatus === 'found',
      ...(pendingWork === undefined ? {} : { pendingWork }),
      ...(lastUserActivityAtMs === undefined ? {} : { idleForMs: Math.max(0, nowMs - lastUserActivityAtMs) }),
      strict: true,
      ...(job.kind === 'keepalive' ? { requirePending: this.config.keepalive.require_pending } : {})
    };
  }

  public jobs(): Job[] {
    return this.store.list('job').filter(isJob).sort((a, b) => a.dueAtMs - b.dueAtMs);
  }

  private existing(kind: Job['kind'], owner: JobOwner, resetGeneration?: number): Job | undefined {
    // An interrupted submit is still live until its stable client id has been
    // reconciled. Returning it here prevents a second deterministic schedule
    // call from sending a duplicate while the first attempt is unknown.
    return this.jobs().find((job) => job.kind === kind && job.owner.threadId === owner.threadId && job.owner.accountId === owner.accountId && job.resetGeneration === resetGeneration && !['completed', 'cancelled', 'rejected'].includes(job.state));
  }

  private schedule(job: Job): Job {
    const phase = this.eligibility?.(job, 'schedule');
    if (phase) {
      const checked = cancelIf(job, this.withServiceGates(job, phase, phase.nowMs ?? this.now()));
      if (checked.state === 'cancelled') { this.persistence.write(checked); return checked; }
    }
    this.persistence.write(job);
    return job;
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
    if (this.config.auto.enabled !== true || this.config.bridge.enabled !== true) throw new Error('reset wake is disabled');
    const existing = this.jobs().find((job) => job.kind === 'reset-wake' && job.owner.threadId === owner.threadId && job.owner.accountId === owner.accountId && job.resetGeneration === resetGeneration);
    if (existing) return { job: existing, checkpointId };
    const job = this.schedule(createJob({ kind: 'reset-wake', owner, dueAtMs: resetAtMs + this.config.auto.wake_delay_min * 60_000, submissionId: stableId(), resetGeneration }));
    this.store.write(jobIdentity(job), 'timeline', { checkpointId, resetGeneration, resetAtMs, kind: 'reset-wake' });
    return { job, checkpointId };
  }

  private checkpointId(job: Job): string | null {
    const value = this.store.read(jobIdentity(job), 'timeline');
    if (typeof value !== 'object' || value === null) return null;
    const id = (value as Record<string, unknown>)['checkpointId'];
    return typeof id === 'string' && id !== '' ? id : null;
  }

  private scheduleNextKeepalive(job: Job): void {
    if (job.kind !== 'keepalive' || !job.pongVerified || this.config.keepalive.enabled !== true) return;
    if (this.config.keepalive.require_pending && this.eligibility === undefined) return;
    const active = this.existing('keepalive', job.owner);
    if (active !== undefined) return;
    const next = createJob({
      kind: 'keepalive',
      owner: job.owner,
      dueAtMs: this.now() + this.config.keepalive.interval_min * 60_000,
      submissionId: stableId()
    });
    this.schedule(next);
  }

  /** Execute due scheduled jobs and acknowledge queued cancellations. */
  public async runDueJobs(): Promise<Job[]> {
    const nowMs = this.now();
    const results: Job[] = [];
    for (const original of this.jobs()) {
      let job = original;
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
        const client = await this.resolveClient(job.owner);
        if (client) job = (await cancelQueuedJob(client, job, job.cancelReason ?? 'eligibility changed', this.persistence)).job;
        results.push(job);
        continue;
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
      const client = await this.resolveClient(job.owner);
      if (!client) {
        const unavailable = advance(job, { type: 'ambiguous', reason: 'existing owner or native transport was not available' });
        this.persistence.write(unavailable);
        results.push(unavailable);
        continue;
      }
      const checkpointId = job.kind === 'reset-wake' ? this.checkpointId(job) : null;
      if (job.kind === 'reset-wake' && checkpointId === null) {
        const invalid = advance(job, { type: 'ambiguous', reason: 'reset wake has no exact checkpoint identity' });
        this.persistence.write(invalid);
        results.push(invalid);
        continue;
      }
      const message = job.kind === 'keepalive'
        ? KEEPALIVE_PING
        : `${RESET_WAKE_PREFIX} ${checkpointId}`;
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
  public recordCompletion(jobId: string, result: string, nativeCompleted?: boolean, toolCalls?: number): Job | null {
    const job = this.persistence.read(jobId);
    if (!job) return null;
    if (job.kind === 'reset-wake') {
      const blocked = advance(job, { type: 'ambiguous', reason: 'reset wake completion requires an exact checkpoint archive acknowledgement' });
      this.persistence.write(blocked);
      return blocked;
    }
    const next = advance(job, { type: 'completed', result, nativeCompleted, toolCalls });
    this.persistence.write(next);
    this.scheduleNextKeepalive(next);
    return next;
  }

  /** Complete a reset wake only after the exact checkpoint consumer confirms archival. */
  public async recordResetWakeCompletion(jobId: string, result: string, nativeCompleted?: boolean, toolCalls?: number): Promise<Job | null> {
    const job = this.persistence.read(jobId);
    if (!job || job.kind !== 'reset-wake') return null;
    const checkpointId = this.checkpointId(job);
    if (!checkpointId || !this.consumeCheckpoint) {
      const blocked = advance(job, { type: 'ambiguous', reason: 'reset wake has no verified checkpoint consumer' });
      this.persistence.write(blocked);
      return blocked;
    }
    if (nativeCompleted !== true || toolCalls !== 0) {
      // The native turn did not provide the independent evidence needed to
      // consume the checkpoint. Keep the checkpoint recoverable and make this
      // attempt terminal rather than claiming the wake completed.
      const incomplete = advance(job, { type: 'ambiguous', reason: 'reset wake completion lacked native completion or zero-tool evidence' });
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
    const completed = advance(job, { type: 'completed', result, nativeCompleted, toolCalls });
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

async function main(): Promise<void> {
  const service = new CodexService();
  const action = process.argv[2] ?? 'run';
  if (action === 'run' || action === 'tick') {
    process.stdout.write(JSON.stringify(await service.runDueJobs()) + '\n');
    return;
  }
  if (action === 'watch') {
    // The service owns the 30-minute cadence. Every pass re-reads the
    // observed owner/fact gates, so a restart or stale cache cannot silently
    // inherit a prior eligibility decision.
    const intervalMs = service.config.keepalive.interval_min * 60_000;
    while (true) {
      process.stdout.write(JSON.stringify(await service.runDueJobs()) + '\n');
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (action === 'list') { process.stdout.write(JSON.stringify(service.jobs()) + '\n'); return; }
  process.stderr.write('usage: pacekeeper-service run|watch|list\n');
  process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`codex-pacekeeper service error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
