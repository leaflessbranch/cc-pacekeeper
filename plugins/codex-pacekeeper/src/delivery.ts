/** Existing-owner delivery with durable intent and explicit uncertainty. */
import { randomUUID } from 'crypto';
import {
  NativeClient,
  parseQueueListResponse,
  type QueueDeleteResult,
  type QueueDeliveryResult
} from './native';
import { advance, reconcile, type Job, type JobEvent, type QueuedSubmissionRecord } from './jobs';

export interface JobPersistence {
  read(id: string): Job | null;
  write(job: Job): void;
}

export function stableSubmissionId(): string {
  return randomUUID();
}

function persist(job: Job, store?: JobPersistence): Job {
  store?.write(job);
  return job;
}

function queueEvent(result: QueueDeliveryResult): JobEvent {
  if (result.status === 'accepted') return { type: 'accepted', queuedSubmissionId: result.queuedSubmissionId };
  if (result.status === 'rejected') return { type: 'rejected', reason: result.reason };
  return { type: 'ambiguous', reason: `${result.status}: ${result.reason}` };
}

export interface DeliveryResult {
  job: Job;
  native: QueueDeliveryResult;
}

/** Record submitting intent before making the native request. */
export async function deliverJob(client: NativeClient, job: Job, message: string, store?: JobPersistence): Promise<DeliveryResult> {
  if (job.state !== 'scheduled') return { job, native: { status: 'rejected', reason: `job is ${job.state}`, clientUserMessageId: job.submissionId } };
  let current = persist(advance(job, { type: 'submitting' }), store);
  let result: QueueDeliveryResult;
  try {
    result = await client.queueExistingThread({ threadId: current.owner.threadId, message, clientUserMessageId: current.submissionId });
  } catch (error) {
    result = { status: 'ambiguous', reason: error instanceof Error ? error.message : 'native delivery failed', clientUserMessageId: current.submissionId };
  }
  current = persist(advance(current, queueEvent(result)), store);
  return { job: current, native: result };
}

export interface CancellationResult {
  job: Job;
  native: QueueDeleteResult;
}

/** Request deletion only for a native queue id; local intent stays queued until ack. */
export async function cancelQueuedJob(client: NativeClient, job: Job, reason: string, store?: JobPersistence): Promise<CancellationResult> {
  if (job.state !== 'queued' || !job.queuedSubmissionId) {
    const next = persist(advance(job, { type: 'cancelled' }), store);
    return {
      job: next,
      native: { status: 'rejected', reason: 'job has no cancellable queued submission', threadId: job.owner.threadId, queuedSubmissionId: job.queuedSubmissionId ?? '' }
    };
  }
  const requested = persist({ ...job, cancelRequested: true, cancelReason: reason, retryable: false }, store);
  const native = await client.deleteQueuedSubmission(job.owner.threadId, job.queuedSubmissionId);
  const next = native.status === 'deleted'
    ? persist(advance(requested, { type: 'cancelled' }), store)
    : native.status === 'ambiguous'
      ? persist(advance(requested, { type: 'ambiguous', reason: `queue cancellation: ${native.reason}` }), store)
      : requested;
  return { job: next, native };
}

export interface ReconciliationResult {
  job: Job;
  queued: QueuedSubmissionRecord[];
}

/** Reconcile an ambiguous submission by stable client id; absence stays ambiguous. */
export async function reconcileJob(client: NativeClient, job: Job, store?: JobPersistence): Promise<ReconciliationResult> {
  if (job.state !== 'ambiguous') return { job, queued: [] };
  let raw: unknown;
  try { raw = await client.listQueuedSubmissions(job.owner.threadId); }
  catch (error) {
    return { job: persist({ ...job, failureReason: error instanceof Error ? error.message : 'queue reconciliation failed' }, store), queued: [] };
  }
  const queued = parseQueueListResponse(raw);
  const next = persist(reconcile(job, queued), store);
  return { job: next, queued };
}
