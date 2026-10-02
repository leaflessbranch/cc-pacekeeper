import { describe, expect, test } from 'bun:test';
import {
  KEEPALIVE_PING,
  advance,
  cancelIf,
  createJob,
  reconcile,
  type Job
} from '../jobs';

const NOW = 1_700_000_000_000;

function keepalive(overrides: Partial<Job> = {}): Job {
  return {
    ...createJob({
      kind: 'keepalive',
      owner: { accountId: 'acct-1', threadId: 'thread-1' },
      dueAtMs: NOW,
      submissionId: 'sub-1'
    }),
    ...overrides
  };
}

describe('job identity', () => {
  // A recurring keepalive and a one-shot reset wake must never share identity,
  // or cancelling one would silently cancel the other.
  test('keepalive and reset-wake are separate identities', () => {
    const a = createJob({
      kind: 'keepalive',
      owner: { accountId: 'acct-1', threadId: 'thread-1' },
      dueAtMs: NOW,
      submissionId: 'sub-1'
    });
    const b = createJob({
      kind: 'reset-wake',
      owner: { accountId: 'acct-1', threadId: 'thread-1' },
      dueAtMs: NOW,
      submissionId: 'sub-2'
    });
    expect(a.id).not.toBe(b.id);
    expect(a.kind).not.toBe(b.kind);
  });

  test('the same thread under two accounts yields distinct jobs', () => {
    const a = createJob({
      kind: 'keepalive',
      owner: { accountId: 'acct-1', threadId: 'shared' },
      dueAtMs: NOW,
      submissionId: 's'
    });
    const b = createJob({
      kind: 'keepalive',
      owner: { accountId: 'acct-2', threadId: 'shared' },
      dueAtMs: NOW,
      submissionId: 's'
    });
    expect(a.id).not.toBe(b.id);
  });

  test('a new job starts scheduled with its intent recorded', () => {
    const job = keepalive();
    expect(job.state).toBe('scheduled');
    expect(job.submissionId).toBe('sub-1');
  });
});

describe('state transitions', () => {
  test('a normal delivery walks scheduled to completed', () => {
    let job = keepalive();
    job = advance(job, { type: 'submitting' });
    expect(job.state).toBe('submitting');
    job = advance(job, { type: 'accepted', queuedSubmissionId: 'q-1' });
    expect(job.state).toBe('queued');
    expect(job.queuedSubmissionId).toBe('q-1');
    job = advance(job, { type: 'turn-started' });
    expect(job.state).toBe('running');
    job = advance(job, { type: 'completed', result: 'pong', nativeCompleted: true, toolCalls: 0 });
    expect(job.state).toBe('completed');
  });

  // A lost acknowledgement is the case that must never retry: the message may
  // already have been delivered.
  test('an ambiguous outcome is terminal for this attempt, not a retry', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'ambiguous', reason: 'transport timed out' });
    expect(job.state).toBe('ambiguous');
    expect(job.retryable).toBe(false);
  });

  test('an ambiguous job cannot be advanced back into submitting', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'ambiguous', reason: 'timeout' });
    const again = advance(job, { type: 'submitting' });
    expect(again.state).toBe('ambiguous');
  });

  test('an explicit rejection is retryable, since nothing was delivered', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'rejected', reason: 'owner refused' });
    expect(job.state).toBe('rejected');
    expect(job.retryable).toBe(true);
  });

  test('a completed job ignores further transitions', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'accepted', queuedSubmissionId: 'q' });
    job = advance(job, { type: 'completed', result: 'pong', nativeCompleted: true, toolCalls: 0 });
    expect(advance(job, { type: 'turn-started' }).state).toBe('completed');
  });
});

describe('reconciliation after a crash', () => {
  // The submission id is stable and recorded before sending, so an interrupted
  // attempt is matched rather than duplicated.
  test('an ambiguous job matching a queued submission is reconciled, not resent', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'ambiguous', reason: 'crash before ack' });
    const result = reconcile(job, [{ id: 'q-9', clientUserMessageId: 'sub-1' }]);
    expect(result.state).toBe('queued');
    expect(result.queuedSubmissionId).toBe('q-9');
  });

  test('an ambiguous job absent from the queue stays ambiguous', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'ambiguous', reason: 'crash' });
    // Absent from the queue does not prove it never ran: it may have completed.
    const result = reconcile(job, [{ id: 'q-9', clientUserMessageId: 'someone-else' }]);
    expect(result.state).toBe('ambiguous');
    expect(result.retryable).toBe(false);
  });

  test('a persisted submitting job is reconciled without creating a new id', () => {
    const submitting = advance(keepalive(), { type: 'submitting' });
    const result = reconcile(submitting, [{ id: 'q-recovered', clientUserMessageId: 'sub-1' }]);
    expect(result.state).toBe('queued');
    expect(result.submissionId).toBe('sub-1');
    expect(result.queuedSubmissionId).toBe('q-recovered');
  });

  test('reconciling never invents a new submission id', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'ambiguous', reason: 'crash' });
    expect(reconcile(job, []).submissionId).toBe('sub-1');
  });
});

describe('cancellation', () => {
  test('user activity cancels a pending keepalive', () => {
    const job = keepalive();
    const result = cancelIf(job, { userActiveSinceMs: NOW - 1_000, nowMs: NOW });
    expect(result.state).toBe('cancelled');
    expect(result.cancelReason).toContain('user');
  });

  test('a job already running is not cancelled by late activity', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'accepted', queuedSubmissionId: 'q' });
    job = advance(job, { type: 'turn-started' });
    expect(cancelIf(job, { userActiveSinceMs: NOW, nowMs: NOW }).state).toBe('running');
  });

  test('losing included capacity cancels a pending job', () => {
    const result = cancelIf(keepalive(), { capacity: 'paid', nowMs: NOW });
    expect(result.state).toBe('cancelled');
    expect(result.cancelReason).toContain('capacity');
  });

  test('an eligible job is left alone', () => {
    expect(cancelIf(keepalive(), { capacity: 'included', nowMs: NOW }).state).toBe('scheduled');
  });

  test('require_pending=false does not cancel solely because pending work is false', () => {
    expect(cancelIf(keepalive(), { capacity: 'included', pendingWork: false, requirePending: false, nowMs: NOW }).state).toBe('scheduled');
  });

  test('maximum continuous idle cancels a pending keepalive, while unknown idle fails closed', () => {
    const maxIdleMs = 60 * 60_000;
    const expired = cancelIf(keepalive(), { nowMs: NOW, idleForMs: maxIdleMs, maxIdleMs, strict: true });
    expect(expired.state).toBe('cancelled');
    expect(expired.cancelReason).toContain('maximum');
    const unknown = cancelIf(keepalive(), { nowMs: NOW, maxIdleMs, strict: true });
    expect(unknown.state).toBe('cancelled');
    expect(unknown.cancelReason).toContain('idle');
  });
});

describe('keepalive contract', () => {
  test('the ping text is an exact stable marker', () => {
    expect(KEEPALIVE_PING).toBe('[pacekeeper-keepalive] ping');
  });

  // A queue acknowledgement is not a completed turn, and a completed turn with
  // the wrong result is not a successful pong.
  test('a non-exact result is recorded as a failure, not a success', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'accepted', queuedSubmissionId: 'q' });
    job = advance(job, { type: 'turn-started' });
    job = advance(job, { type: 'completed', result: 'sure thing, happy to help', nativeCompleted: true, toolCalls: 0 });
    expect(job.state).toBe('completed');
    expect(job.pongVerified).toBe(false);
  });

  test('an exact pong verifies', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'accepted', queuedSubmissionId: 'q' });
    job = advance(job, { type: 'turn-started' });
    job = advance(job, { type: 'completed', result: 'pong', nativeCompleted: true, toolCalls: 0 });
    expect(job.pongVerified).toBe(true);
  });

  test('acceptance alone never marks a pong verified', () => {
    let job = advance(keepalive(), { type: 'submitting' });
    job = advance(job, { type: 'accepted', queuedSubmissionId: 'q' });
    expect(job.pongVerified).toBe(false);
  });
});
