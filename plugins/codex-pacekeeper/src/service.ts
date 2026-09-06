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
  return typeof row.id === 'string' && (row.kind === 'keepalive' || row.kind === 'reset-wake')
    && typeof row.owner === 'object' && row.owner !== null && typeof (row.owner as Record<string, unknown>).threadId === 'string'
    && typeof row.state === 'string' && typeof row.submissionId === 'string';
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
    this.eligibility = options.eligibility;
    this.consumeCheckpoint = options.consumeCheckpoint;
  }

  public jobs(): Job[] {
    return this.store.list('job').filter(isJob).sort((a, b) => a.dueAtMs - b.dueAtMs);
  }

  private existing(kind: Job['kind'], owner: JobOwner, resetGeneration?: number): Job | undefined {
    return this.jobs().find((job) => job.kind === kind && job.owner.threadId === owner.threadId && job.owner.accountId === owner.accountId && job.resetGeneration === resetGeneration && !['completed', 'cancelled', 'rejected', 'ambiguous'].includes(job.state));
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

  /** Execute due scheduled jobs and acknowledge queued cancellations. */
  public async runDueJobs(): Promise<Job[]> {
    const nowMs = this.now();
    const results: Job[] = [];
    for (const original of this.jobs()) {
      let job = original;
      if (job.state === 'queued' && !job.cancelRequested) {
        const phase = this.eligibility?.(job, 'execute');
        if (phase) {
          const checked = cancelIf(job, this.withServiceGates(job, phase, nowMs));
          if (checked.cancelRequested) {
            this.persistence.write(checked);
            job = checked;
          }
        }
      }
      if (job.state === 'queued' && job.cancelRequested) {
        const client = await this.resolveClient(job.owner);
        if (client) job = (await cancelQueuedJob(client, job, job.cancelReason ?? 'eligibility changed', this.persistence)).job;
        results.push(job);
        continue;
      }
      if (job.state !== 'scheduled' || job.dueAtMs > nowMs) continue;
      const phase = this.eligibility?.(job, 'execute');
      const checked = phase
        ? cancelIf(job, this.withServiceGates(job, phase, nowMs))
        : cancelIf(job, { nowMs, strict: true, ...(job.kind === 'keepalive' ? { maxIdleMs: this.config.keepalive.max_idle_hours * 60 * 60_000 } : {}) });
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
  if (action === 'list') { process.stdout.write(JSON.stringify(service.jobs()) + '\n'); return; }
  process.stderr.write('usage: pacekeeper-service run|list\n');
  process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`codex-pacekeeper service error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
