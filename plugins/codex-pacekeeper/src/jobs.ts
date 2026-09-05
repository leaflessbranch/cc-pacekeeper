/**
 * Durable job lifecycle for scheduled delivery.
 *
 * Two facts shape this module. First, a queue acknowledgement is not a
 * completed turn: acceptance, execution and the result are separate outcomes,
 * and only the last of them can verify a pong. Second, a lost acknowledgement
 * cannot be retried. The message may already have been delivered, so a retry
 * would duplicate it; plugin-owned locking does not change that, because the
 * loss happens after the lock is released.
 *
 * Every transition is pure. Persistence and native calls live elsewhere, so a
 * crash at any point can be replayed against these functions in a test.
 */
import { createHash } from 'crypto';

export type JobKind = 'keepalive' | 'reset-wake';

export type JobState =
  | 'scheduled'
  | 'submitting'
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'ambiguous';

export interface JobOwner {
  accountId: string | null;
  threadId: string;
}

/** The exact text a keepalive sends. Stable, because the reply must match. */
export const KEEPALIVE_PING = '[pacekeeper-keepalive] ping';

/** The exact reply that counts as a verified pong. */
export const KEEPALIVE_PONG = 'pong';

export interface Job {
  id: string;
  kind: JobKind;
  owner: JobOwner;
  dueAtMs: number;
  state: JobState;
  /**
   * Stable, caller-generated, recorded BEFORE sending. This is what makes an
   * interrupted attempt reconcilable instead of duplicable.
   */
  submissionId: string;
  queuedSubmissionId?: string;
  /** Reset generation for a wake, so a rolled-over reset cannot be reused. */
  resetGeneration?: number;
  /** Whether this attempt may be retried. False whenever delivery is unproven. */
  retryable: boolean;
  /** Only true after a completed turn whose result was exactly the pong. */
  pongVerified: boolean;
  cancelReason?: string;
  failureReason?: string;
}

export interface CreateJobInput {
  kind: JobKind;
  owner: JobOwner;
  dueAtMs: number;
  submissionId: string;
  resetGeneration?: number;
}

export function createJob(input: CreateJobInput): Job {
  // Identity covers kind, account and thread: a recurring keepalive and a
  // one-shot wake on the same thread must not share an id, or cancelling one
  // would silently cancel the other.
  const canonical = [
    input.kind,
    input.owner.accountId ?? ' unknown-account',
    input.owner.threadId
  ]
    .map((part) => `${part.length}:${part}`)
    .join('|');
  return {
    id: createHash('sha256').update(canonical).digest('hex').slice(0, 24),
    kind: input.kind,
    owner: input.owner,
    dueAtMs: input.dueAtMs,
    state: 'scheduled',
    submissionId: input.submissionId,
    ...(input.resetGeneration !== undefined ? { resetGeneration: input.resetGeneration } : {}),
    retryable: true,
    pongVerified: false
  };
}

export type JobEvent =
  | { type: 'submitting' }
  | { type: 'accepted'; queuedSubmissionId: string }
  | { type: 'turn-started' }
  | { type: 'completed'; result: string }
  | { type: 'rejected'; reason: string }
  | { type: 'ambiguous'; reason: string };

/** States from which no further progress is possible. */
const TERMINAL: ReadonlySet<JobState> = new Set<JobState>([
  'completed',
  'cancelled',
  'rejected',
  'ambiguous'
]);

export function advance(job: Job, event: JobEvent): Job {
  // Ambiguous is terminal on purpose. Re-entering `submitting` from it would
  // be exactly the duplicate delivery this module exists to prevent.
  if (TERMINAL.has(job.state)) return job;

  switch (event.type) {
    case 'submitting':
      return { ...job, state: 'submitting' };
    case 'accepted':
      // Acceptance means queued, never executed, so pongVerified stays false.
      return { ...job, state: 'queued', queuedSubmissionId: event.queuedSubmissionId };
    case 'turn-started':
      return { ...job, state: 'running' };
    case 'completed':
      return {
        ...job,
        state: 'completed',
        pongVerified: event.result.trim().toLowerCase() === KEEPALIVE_PONG
      };
    case 'rejected':
      // Explicitly refused: nothing was delivered, so another attempt is safe.
      return { ...job, state: 'rejected', retryable: true, failureReason: event.reason };
    case 'ambiguous':
      return { ...job, state: 'ambiguous', retryable: false, failureReason: event.reason };
  }
}

export interface QueuedSubmissionRecord {
  id: string;
  clientUserMessageId: string;
}

/**
 * Match an interrupted attempt against what the owner actually holds.
 *
 * Absence from the queue is NOT proof the message never ran: it may have been
 * delivered and completed while we were gone. So an unmatched ambiguous job
 * stays ambiguous and non-retryable rather than being reset for another try.
 */
export function reconcile(job: Job, queued: readonly QueuedSubmissionRecord[]): Job {
  if (job.state !== 'ambiguous') return job;
  const match = queued.find((record) => record.clientUserMessageId === job.submissionId);
  if (match === undefined) return job;
  return {
    ...job,
    state: 'queued',
    queuedSubmissionId: match.id,
    retryable: false,
    ...(job.failureReason !== undefined ? { failureReason: job.failureReason } : {})
  };
}

export interface EligibilityInput {
  nowMs: number;
  /** Genuine user activity at or after this time cancels a pending job. */
  userActiveSinceMs?: number;
  capacity?: 'included' | 'paid' | 'unknown' | 'unsupported';
  enabled?: boolean;
  pendingWork?: boolean;
}

/**
 * Re-check eligibility at execution time. The user winning a race with an
 * already-scheduled ping is the normal case, not an error.
 */
export function cancelIf(job: Job, input: EligibilityInput): Job {
  // Once the turn is running the message has reached the model; cancelling the
  // job record then would misreport what actually happened.
  if (job.state !== 'scheduled' && job.state !== 'queued') return job;

  const cancel = (reason: string): Job => ({ ...job, state: 'cancelled', cancelReason: reason });

  if (input.enabled === false) return cancel('keepalive is disabled');
  if (input.userActiveSinceMs !== undefined) return cancel('the user became active');
  if (input.capacity !== undefined && input.capacity !== 'included') {
    return cancel(`subscription capacity is ${input.capacity}, not confirmed included`);
  }
  if (input.pendingWork === false) return cancel('no pending work remains');
  return job;
}
