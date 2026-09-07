import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS, loadCodexConfig } from '../config';
import { CodexCheckpoints } from '../checkpoint';
import { buildFacts } from '../facts';
import { buildContract, shouldPause } from '../agent-budget';
import { decide, type PolicyState } from '../policy';
import { advance, cancelIf, createJob } from '../jobs';
import { diagnose } from '../doctor';
import { resolveProjectRoot } from '../resolve-root';
import { refreshObservations } from '../refresh';
import { CodexStore } from '../storage';
import { cleanupDecision } from '../worktrees';
import { runTick } from '../tick';
import {
  NATIVE_PROTOCOL_VERSION,
  QUEUE_ADD_METHOD,
  QUEUE_DELETE_METHOD,
  QUEUE_LIST_METHOD,
  NativeClient,
  normalizeNativeCapabilities,
  parseQueueListResponse,
  type NativeTransport
} from '../native';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'codex-pacekeeper-repairs-'));
const fixtureUnsafe = (dir: string): boolean => !dir.startsWith(FIXTURE_ROOT);
const owner = { accountId: 'acct-1', threadId: 'thread-1' };
const NOW = 1_700_000_000_000;

function freshConfigRoot(contents: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-pacekeeper-config-repair-'));
  mkdirSync(join(root, 'cc-pacekeeper'), { recursive: true });
  writeFileSync(join(root, 'cc-pacekeeper', 'config.json'), JSON.stringify(contents));
  return root;
}

function job() {
  return createJob({
    kind: 'keepalive',
    owner,
    dueAtMs: NOW,
    submissionId: 'submission-1'
  });
}

describe('review repair regressions', () => {
  test('rejects a checkpoint destination that escapes through a symlink', () => {
    const root = join(FIXTURE_ROOT, 'symlink-project');
    const outside = join(FIXTURE_ROOT, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, '.claude-checkpoints'));
    expect(() => new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: fixtureUnsafe })).toThrow(/checkpoint|symlink|confined/i);
  });

  test('rejects a traversal checkpoint subdirectory before any filesystem write', () => {
    expect(() => new CodexCheckpoints(join(FIXTURE_ROOT, 'project'), { ...CODEX_DEFAULTS, checkpoint_subdir: '..' }, { isUnsafeRoot: fixtureUnsafe })).toThrow(/subdir|path|checkpoint/i);
  });

  test('canonicalizes a legitimate cache-root alias while retaining descendant containment', () => {
    const real = join(FIXTURE_ROOT, `cache-real-${Date.now()}`);
    const alias = join(FIXTURE_ROOT, `cache-alias-${Date.now()}`);
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias);
    const store = new CodexStore(alias);
    const identity = { accountId: 'acct-1', threadId: 'thread-1' };
    store.write(identity, 'timeline', { observed: true });
    expect(store.read(identity, 'timeline')).toEqual({ observed: true });
  });

  test('an unsafe explicit CLI root cannot fall through to another checkout', () => {
    const unsafe = mkdtempSync(join(tmpdir(), 'codex-pacekeeper-unsafe-root-'));
    expect(() => resolveProjectRoot({ cwdFlag: unsafe, processCwd: unsafe })).toThrow(/explicit project root is unsafe/);
  });

  test('cleanup always protects the actual invoking checkout', () => {
    const invoking = join(FIXTURE_ROOT, 'invoking-worktree');
    expect(cleanupDecision({ path: invoking, bare: false, detached: false, locked: false, dirty: false, liveOwners: 0 }, invoking).removable).toBe(false);
  });

  test('claims a checkpoint durably and archives only after acknowledgement', () => {
    const root = join(FIXTURE_ROOT, `claim-${Date.now()}`);
    const store = new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: fixtureUnsafe });
    const saved = store.save({ lane: 'main', owner, body: 'recoverable' });
    const claim = store.claim(saved.id);
    expect(claim.status).toBe('claimed');
    expect(existsSync(saved.file)).toBe(true);
    if (claim.status !== 'claimed') throw new Error('claim failed');
    expect(store.acknowledge(claim.id, claim.token).status).toBe('resumed');
    expect(existsSync(saved.file)).toBe(false);
  });

  test('unrecognized plan or unknown account cannot authorize automation', () => {
    const rateLimits = {
      rateLimits: {
        planType: 'mystery',
        spendControlReached: false,
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 }
      }
    };
    const facts = buildFacts({ rateLimits, observedAtMs: NOW - 1_000, tokenUsage: null, authenticated: true }, CODEX_DEFAULTS, NOW);
    expect(facts.capacity).toBe('unknown');
    expect(facts.automationAllowed).toBe(false);
    expect(facts.blockers.join(' ')).toContain('account');
  });

  test('spawn-relative contracts give a late child room through the auto boundary', () => {
    const contract = buildContract({ agentId: 'agent-1', agentType: 'worker', cliPath: '/opt/pacekeeper/bin/checkpoint', fiveHourPercentAtSpawn: 80 }, CODEX_DEFAULTS);
    expect(contract.pausePercent).toBe(CODEX_DEFAULTS.auto.five_hour_pct);
    expect(shouldPause({ fiveHourPercent: 80, fiveHourPercentAtSpawn: 80 }, CODEX_DEFAULTS).pause).toBe(false);
    expect(shouldPause({ fiveHourPercent: 85, fiveHourPercentAtSpawn: 80 }, CODEX_DEFAULTS).pause).toBe(true);
  });

  test('tool activity does not move the genuine user idle anchor', () => {
    const state: PolicyState = { levels: {}, lastInjectedAtMs: {}, blockResetAtMs: null, savedThisCycle: false, lastUserActivityAtMs: 10 };
    const facts = buildFacts({ rateLimits: {
      accountId: 'acct-1',
      rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } }
    }, observedAtMs: NOW - 1_000, tokenUsage: null, authenticated: true }, CODEX_DEFAULTS, NOW);
    const result = decide({ event: 'PreToolUse', facts, state, nowMs: 100, synthetic: false }, CODEX_DEFAULTS);
    expect(result.nextState.lastUserActivityAtMs).toBe(10);
    expect(result.nextState.lastWorkAtMs).toBe(100);
  });

  test('synthetic activity cannot clear state during a block rollover', () => {
    const state: PolicyState = { levels: { five_hour: 'warn' }, lastInjectedAtMs: { five_hour: 10 }, blockResetAtMs: 20, savedThisCycle: true, lastUserActivityAtMs: 10 };
    const facts = buildFacts({ rateLimits: {
      accountId: 'acct-1',
      rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } }
    }, observedAtMs: NOW - 1_000, tokenUsage: null, authenticated: true }, CODEX_DEFAULTS, NOW);
    const result = decide({ event: 'UserPromptSubmit', facts, state, nowMs: 100, synthetic: true }, CODEX_DEFAULTS);
    expect(result.nextState).toEqual(state);
  });

  test('illegal job events are ignored and sending makes retry impossible', () => {
    const scheduled = job();
    expect(advance(scheduled, { type: 'completed', result: 'pong' }).state).toBe('scheduled');
    const submitting = advance(scheduled, { type: 'submitting' });
    expect(submitting.retryable).toBe(false);
    const queued = advance(submitting, { type: 'accepted', queuedSubmissionId: 'queued-1' });
    expect(queued.retryable).toBe(false);
    expect(advance(queued, { type: 'submitting' }).state).toBe('queued');
  });

  test('queued cancellation waits for native acknowledgement', () => {
    const queued = advance(advance(job(), { type: 'submitting' }), { type: 'accepted', queuedSubmissionId: 'queued-1' });
    const requested = cancelIf(queued, { nowMs: NOW, userActiveSinceMs: NOW, strict: true, enabled: true, pendingWork: true, capacity: 'included', ownerLive: true, fresh: true });
    expect(requested.state).toBe('queued');
    expect(requested.cancelRequested).toBe(true);
    const cancelled = advance(requested, { type: 'cancelled' });
    expect(cancelled.state).toBe('cancelled');
  });

  test('pong verification is exact and independently requires native completion', () => {
    let current = advance(advance(advance(job(), { type: 'submitting' }), { type: 'accepted', queuedSubmissionId: 'queued-1' }), { type: 'turn-started' });
    expect(advance(current, { type: 'completed', result: 'PONG' }).pongVerified).toBe(false);
    expect(advance(current, { type: 'completed', result: 'pong', nativeCompleted: false }).pongVerified).toBe(false);
    expect(advance(current, { type: 'completed', result: 'pong', toolCalls: 1 }).pongVerified).toBe(false);
    current = advance(current, { type: 'completed', result: 'pong', nativeCompleted: true, toolCalls: 0 });
    expect(current.pongVerified).toBe(true);
  });

  test('config preserves valid sibling ladders when one ladder is invalid', () => {
    const result = loadCodexConfig(freshConfigRoot({ thresholds: {
      context: { notify: 0, warn: 70, critical: 85 },
      weekly: { notify: 90, warn: 50, critical: 60 }
    } }));
    expect(result.config.thresholds.context).toEqual({ notify: 0, warn: 70, critical: 85 });
    expect(result.config.thresholds.weekly).toEqual(CODEX_DEFAULTS.thresholds.weekly);
    expect(result.diagnostics.join(' ')).toContain('weekly');
  });

  test('doctor leaves unobserved native facts unobserved', () => {
    const capabilities = normalizeNativeCapabilities({});
    const report = diagnose({
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      capabilities,
      ownerStatus: 'unknown',
      authenticated: null,
      capacity: 'unknown',
      quotaAgeSeconds: Number.POSITIVE_INFINITY,
      freshnessSeconds: 180,
      configDiagnostics: [],
      executableObserved: false,
      hookTrust: null
    });
    expect(report.checks.find((check) => check.name === 'protocol version')?.status).toBe('warn');
    expect(report.checks.find((check) => check.name === 'authentication')?.detail).toContain('not observed');
  });

  test('queue deletion is represented separately from pre-model suppression', async () => {
    const capabilities = normalizeNativeCapabilities({ version: NATIVE_PROTOCOL_VERSION, methods: [QUEUE_ADD_METHOD, QUEUE_DELETE_METHOD, QUEUE_LIST_METHOD] });
    const transport: NativeTransport = { request: async (method) => method === QUEUE_LIST_METHOD ? { data: [{ id: 'q-1', clientUserMessageId: 'submission-1', input: [] }] } : { deleted: true } };
    const client = new NativeClient(transport, capabilities, { ownerId: 'o', pid: 1, accountId: 'acct-1', threadIds: ['thread-1'], protocolVersion: NATIVE_PROTOCOL_VERSION });
    expect(parseQueueListResponse(await client.listQueuedSubmissions('thread-1')).map((row) => row.id)).toEqual(['q-1']);
    expect((await client.deleteQueuedSubmission('thread-1', 'q-1')).status).toBe('deleted');
    expect(capabilities.preModelSuppression).toBe('unsupported');
  });

  test('an empty refresh does not renew quota freshness or discard bucket evidence', () => {
    const home = mkdtempSync(join(FIXTURE_ROOT, `facts-${Date.now()}`));
    const store = new CodexStore(home);
    const limits = {
      accountId: 'acct-1',
      rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } },
      rateLimitsByLimitId: { premium: { planType: 'plus', limitId: 'premium', limitName: 'Premium', primary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: (NOW + 86_400_000) / 1000 }, credits: { hasCredits: true, unlimited: false, balance: '12' } } }
    };
    const identity = refreshObservations({ thread_id: owner.threadId, account_id: owner.accountId, now_ms: NOW, rateLimits: limits, tokenUsage: { modelContextWindow: 100, last: { totalTokens: 10 } }, authenticated: true }, store);
    refreshObservations({ thread_id: owner.threadId, account_id: owner.accountId, now_ms: NOW + 600_000 }, store);
    const timeline = store.read(identity, 'timeline') as Record<string, unknown>;
    expect(timeline['quotaObservedAtMs']).toBe(NOW);
    expect(timeline['contextObservedAtMs']).toBe(NOW);
    expect((timeline['rateLimits'] as Record<string, unknown>)['byLimitId']).toBeDefined();
    const stale = buildFacts({ rateLimits: limits, observedAtMs: timeline['quotaObservedAtMs'] as number, tokenUsage: null, authenticated: true }, CODEX_DEFAULTS, NOW + 600_000);
    expect(stale.stale).toBe(true);
    expect(stale.unknownBuckets.length).toBeGreaterThanOrEqual(0);
    expect(runTick({ hook_event_name: 'SessionStart', thread_id: owner.threadId, account_id: owner.accountId, now_ms: NOW + 600_000 }, { config: CODEX_DEFAULTS, store }).facts.context).toBeNull();
  });
});
