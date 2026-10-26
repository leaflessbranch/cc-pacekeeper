import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, existsSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
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
import { refreshFromOwner } from '../refresh';
import { readRollout, type RolloutReading } from '../rollout';
import { ACCOUNT_IDENTITY, CodexStore } from '../storage';
import { presenceStateFile, samplePresence } from '../presence';
import { invokingProvenance } from '../checkpoint-cli';
import { listLiveClaudeSessions } from '../live-sessions';
import { cleanupDecision, cleanupWorktrees, listWorktrees } from '../worktrees';
import { assembleFacts, readAccountRecord } from '../tick';
import {
  NATIVE_PROTOCOL_VERSION,
  QUEUE_ADD_METHOD,
  QUEUE_DELETE_METHOD,
  QUEUE_LIST_METHOD,
  NativeClient,
  normalizeNativeCapabilities,
  parseQueueListResponse,
  parseRateLimitsResponse,
  type NativeTransport
} from '../native';

const EMPTY_ROLLOUT: RolloutReading = { meta: null, tokenUsage: null, tokenUsageObservedAtMs: null, rateLimits: null, rateLimitsObservedAtMs: null, compactedSinceUsage: false };

const FIXTURE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'codex-pacekeeper-repairs-')));
const ROLLOUT_HOME = mkdtempSync(join(FIXTURE_ROOT, 'codex-home-'));
mkdirSync(join(ROLLOUT_HOME, 'sessions'), { recursive: true });
const fixtureUnsafe = (dir: string): boolean => !dir.startsWith(FIXTURE_ROOT);
const owner = { accountId: 'acct-1', threadId: 'thread-1' };
const NOW = 1_700_000_000_000;

function withRolloutHome<T>(run: () => T): T {
  const previous = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = ROLLOUT_HOME;
  try { return run(); } finally {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
  }
}

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

  test('cleanup protects an invoking subdirectory and occupied Claude checkout', () => {
    const repo = join(FIXTURE_ROOT, `cleanup-${Date.now()}`);
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git(['init', '-q']);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'file.txt'), 'fixture');
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=test.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
    const child = join(repo, '.codex-worktrees', 'child');
    git(['worktree', 'add', '-q', '-b', 'fixture-child', child]);
    const registry = join(FIXTURE_ROOT, `owners-${Date.now()}.json`);
    writeFileSync(registry, '[]');
    const rows = cleanupWorktrees({ cwd: repo, currentCwd: join(child, 'src'), ownerRegistryFile: registry });
    const childDecision = rows.find((item) => item.path === child);
    expect(childDecision?.removable).toBe(false);
    expect(cleanupDecision({ path: child, bare: false, detached: false, locked: false, dirty: false, liveOwners: 0, liveClaudeOwners: 1 }, join(repo, 'src')).removable).toBe(false);
  });

  test('cleanup maps live child-directory owners to their worktree and protects main checkout', () => {
    const repo = join(FIXTURE_ROOT, `cleanup-occupancy-${Date.now()}`);
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git(['init', '-q']);
    writeFileSync(join(repo, 'file.txt'), 'fixture');
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=test.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
    const child = join(repo, '.codex-worktrees', 'child');
    git(['worktree', 'add', '-q', '-b', 'fixture-occupancy-child', child]);
    mkdirSync(join(child, 'src'), { recursive: true });
    const registry = join(FIXTURE_ROOT, `owners-occupancy-${Date.now()}.json`);
    writeFileSync(registry, JSON.stringify([{ ownerId: 'fixture-owner', pid: process.pid, accountId: 'acct-1', threadIds: ['thread-1'], cwd: join(child, 'src'), protocolVersion: NATIVE_PROTOCOL_VERSION }]));
    const sessions = join(FIXTURE_ROOT, `claude-sessions-occupancy-${Date.now()}`);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'session.json'), JSON.stringify({ pid: process.pid, cwd: join(child, 'src') }));
    const rows = listWorktrees({ cwd: repo, ownerRegistryFile: registry, claudeSessionsDir: sessions });
    expect(rows?.find((item) => item.path === child)?.liveOwners).toBe(1);
    expect(rows?.find((item) => item.path === child)?.liveClaudeOwners).toBe(1);
    const decisions = cleanupWorktrees({ cwd: repo, currentCwd: repo, ownerRegistryFile: registry, claudeSessionsDir: sessions });
    expect(decisions.find((item) => item.path === child)?.removable).toBe(false);
    expect(decisions.find((item) => item.path === repo)?.removable).toBe(false);

    writeFileSync(registry, JSON.stringify([{ ownerId: 'malformed-owner', pid: process.pid }]));
    const unknownRows = listWorktrees({ cwd: repo, ownerRegistryFile: registry, claudeSessionsDir: sessions });
    const unknownChild = unknownRows?.find((item) => item.path === child);
    expect(unknownChild?.liveOwners).toBeNull();
    expect(unknownChild && cleanupDecision(unknownChild, repo).removable).toBe(false);
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

  test('replaying an acknowledgement returns the durable consumed receipt', () => {
    const root = join(FIXTURE_ROOT, `claim-replay-${Date.now()}`);
    const store = new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: fixtureUnsafe });
    const saved = store.save({ lane: 'main', owner, body: 'replay-safe' });
    const claim = store.claim(saved.id, owner);
    if (claim.status !== 'claimed') throw new Error('claim failed');
    expect(store.acknowledge(saved.id, claim.token).status).toBe('resumed');
    expect(store.acknowledge(saved.id, claim.token).status).toBe('already-consumed');
    expect(store.reconcile(saved.id).status).toBe('already-consumed');
  });

  test('a mismatched archive sidecar never becomes a consumed receipt', () => {
    const root = join(FIXTURE_ROOT, `claim-corrupt-${Date.now()}`);
    const store = new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: fixtureUnsafe });
    const saved = store.save({ lane: 'main', owner, body: 'corruptible-receipt' });
    const claim = store.claim(saved.id, owner);
    if (claim.status !== 'claimed') throw new Error('claim failed');
    expect(store.acknowledge(saved.id, claim.token).status).toBe('resumed');
    const archived = store.listArchived().find((entry) => entry.id === saved.id);
    if (!archived) throw new Error('archive missing');
    writeFileSync(join(root, CODEX_DEFAULTS.checkpoint_dir_name, CODEX_DEFAULTS.checkpoint_subdir, 'archive', `${saved.id}.state.json`), JSON.stringify({
      id: 'different-checkpoint',
      disposition: 'consumed',
      phase: 'complete',
      destination: archived.file
    }));
    expect(store.reconcile(saved.id).status).toBe('not-found');
  });

  test('any thread may resume a lane another thread saved (review #1)', () => {
    const root = join(FIXTURE_ROOT, `claim-cross-thread-${Date.now()}`);
    const store = new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: fixtureUnsafe });
    const saved = store.save({ lane: 'main', owner, body: 'cross-thread' });
    const result = store.resume(saved.id, { accountId: null, threadId: 'thread-B' });
    expect(result.status).toBe('resumed');
    expect(store.listArchived().find((entry) => entry.id === saved.id)?.disposition).toBe('consumed');
    expect(store.resume(saved.id).status).toBe('already-consumed');
  });

  test('archive rename interruption remains recoverable by exact id', () => {
    const root = join(FIXTURE_ROOT, `claim-crash-${Date.now()}`);
    const store = new CodexCheckpoints(root, CODEX_DEFAULTS, { isUnsafeRoot: fixtureUnsafe });
    const saved = store.save({ lane: 'main', owner, body: 'rename-recoverable' });
    const claim = store.claim(saved.id, owner);
    if (claim.status !== 'claimed') throw new Error('claim failed');
    const checkpoints = store as unknown as { writeArchiveDisposition: () => void };
    const original = checkpoints.writeArchiveDisposition;
    checkpoints.writeArchiveDisposition = () => { throw new Error('simulated archive publication interruption'); };
    try { store.acknowledge(saved.id, claim.token); } catch { /* expected fault */ }
    checkpoints.writeArchiveDisposition = original;
    expect(store.reconcile(saved.id).status).toBe('already-consumed');
    expect(store.claim(saved.id, owner).status).toBe('already-consumed');
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

  test('an empty native read does not renew quota freshness or discard bucket evidence', async () => {
    const store = new CodexStore(mkdtempSync(join(FIXTURE_ROOT, `facts-${Date.now()}`)));
    const limits = {
      accountId: 'acct-1',
      rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } },
      rateLimitsByLimitId: { premium: { planType: 'plus', limitId: 'premium', limitName: 'Premium', primary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: (NOW + 86_400_000) / 1000 } } }
    };
    await refreshFromOwner({ readRateLimits: async () => parseRateLimitsResponse(limits, NOW) }, { accountId: null, threadId: owner.threadId }, store, { nowMs: NOW });
    await refreshFromOwner({ readRateLimits: async () => parseRateLimitsResponse({ accountId: 'acct-1', rateLimits: {} }, NOW + 600_000) }, { accountId: null, threadId: owner.threadId }, store, { nowMs: NOW + 600_000 });
    const account = store.read(ACCOUNT_IDENTITY, 'account') as Record<string, unknown>;
    expect(account['quotaObservedAtMs']).toBe(NOW);
    expect((account['rateLimits'] as Record<string, unknown>)['byLimitId']).toBeDefined();
    const stale = buildFacts({ rateLimits: limits, observedAtMs: account['quotaObservedAtMs'] as number, tokenUsage: null, authenticated: true }, CODEX_DEFAULTS, NOW + 600_000);
    expect(stale.stale).toBe(true);
  });

  test('rollout token counts preserve the native event timestamp and canonical thread', () => {
    const rollout = join(ROLLOUT_HOME, 'sessions', `rollout-context-${Date.now()}.jsonl`);
    const observedAtMs = NOW - 2_000;
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: new Date(NOW - 3_000).toISOString(), type: 'session_meta', payload: { id: owner.threadId, session_id: owner.threadId } }),
      JSON.stringify({ timestamp: new Date(observedAtMs).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 42, cached_input_tokens: 7, cache_write_input_tokens: 3 }, model_context_window: 200 } } })
    ].join('\n') + '\n');
    const observation = withRolloutHome(() => readRollout(rollout, NOW, owner.threadId));
    expect(observation.tokenUsageObservedAtMs).toBe(observedAtMs);
    expect(observation.tokenUsage).toEqual({ last: { totalTokens: 42, cachedInputTokens: 7, cacheWriteInputTokens: 3 }, modelContextWindow: 200 });
    expect(withRolloutHome(() => readRollout(rollout, NOW, 'another-thread')).tokenUsage).toBeNull();
  });

  test('rollout compaction boundary invalidates older token counts', () => {
    const rollout = join(ROLLOUT_HOME, 'sessions', `rollout-boundary-${Date.now()}.jsonl`);
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: new Date(NOW - 3_000).toISOString(), type: 'session_meta', payload: { id: owner.threadId, session_id: owner.threadId } }),
      JSON.stringify({ timestamp: new Date(NOW - 2_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 42 }, model_context_window: 200 } } }),
      JSON.stringify({ timestamp: new Date(NOW - 1_000).toISOString(), type: 'compacted' })
    ].join('\n') + '\n');
    const observation = withRolloutHome(() => readRollout(rollout, NOW, owner.threadId));
    expect(observation.tokenUsage).toBeNull();
    expect(observation.compactedSinceUsage).toBe(true);
  });

  test('a turn start does not invalidate context (review #6)', () => {
    const rollout = join(ROLLOUT_HOME, 'sessions', `rollout-turn-${Date.now()}.jsonl`);
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: new Date(NOW - 3_000).toISOString(), type: 'session_meta', payload: { id: owner.threadId, session_id: owner.threadId } }),
      JSON.stringify({ timestamp: new Date(NOW - 2_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 42 }, model_context_window: 200 } } }),
      JSON.stringify({ timestamp: new Date(NOW - 1_500).toISOString(), type: 'turn_context', payload: {} }),
      JSON.stringify({ timestamp: new Date(NOW - 1_000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: new Date(NOW - 900).toISOString(), type: 'event_msg', payload: { type: 'turn_started' } })
    ].join('\n') + '\n');
    const observation = withRolloutHome(() => readRollout(rollout, NOW, owner.threadId));
    expect(observation.tokenUsage).toEqual({ last: { totalTokens: 42 }, modelContextWindow: 200 });
  });

  test('an unknown later native token count invalidates an older context value', () => {
    const rollout = join(ROLLOUT_HOME, 'sessions', `rollout-unknown-${Date.now()}.jsonl`);
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: new Date(NOW - 2_000).toISOString(), type: 'session_meta', payload: { id: owner.threadId, session_id: owner.threadId } }),
      JSON.stringify({ timestamp: new Date(NOW - 1_500).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 42 }, model_context_window: 200 } } }),
      JSON.stringify({ timestamp: new Date(NOW - 1_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null } })
    ].join('\n') + '\n');
    const observation = withRolloutHome(() => readRollout(rollout, NOW, owner.threadId));
    expect(observation.tokenUsage).toBeNull();
    expect(observation.tokenUsageObservedAtMs).toBeNull();
  });

  test('bounded rollout reads keep the first native session identity and reject outside paths', () => {
    const rollout = join(ROLLOUT_HOME, 'sessions', `rollout-large-${Date.now()}.jsonl`);
    const filler = Array.from({ length: 70_000 }, () => JSON.stringify({
      timestamp: new Date(NOW - 1_500).toISOString(),
      type: 'event_msg',
      payload: { type: 'warning', message: 'bounded filler' }
    })).join('\n');
    writeFileSync(rollout, [
      JSON.stringify({ timestamp: new Date(NOW - 3_000).toISOString(), type: 'session_meta', payload: { id: owner.threadId, session_id: owner.threadId } }),
      JSON.stringify({ timestamp: new Date(NOW - 2_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 42 }, model_context_window: 200 } } }),
      filler,
      JSON.stringify({ timestamp: new Date(NOW - 900).toISOString(), type: 'session_meta', payload: { id: 'inherited-thread', session_id: 'inherited-thread' } }),
      JSON.stringify({ timestamp: new Date(NOW - 500).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 99 }, model_context_window: 240 } } })
    ].join('\n') + '\n');
    const observation = withRolloutHome(() => readRollout(rollout, NOW, owner.threadId));
    expect(observation.tokenUsageObservedAtMs).toBe(NOW - 500);
    expect(observation.tokenUsage).toEqual({ last: { totalTokens: 99 }, modelContextWindow: 240 });

    const outside = join(FIXTURE_ROOT, `outside-rollout-${Date.now()}.jsonl`);
    writeFileSync(outside, readFileSync(rollout));
    expect(withRolloutHome(() => readRollout(outside, NOW, owner.threadId).tokenUsage)).toBeNull();
  });

  test('ordinary usage permission revocation replaces prior included capacity', async () => {
    const store = new CodexStore(mkdtempSync(join(FIXTURE_ROOT, `permission-revocation-${Date.now()}`)));
    const initial = {
      accountId: owner.accountId,
      ordinaryUsageAllowed: true,
      rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } }
    };
    const read = (value: unknown, at: number) => ({ readRateLimits: async () => parseRateLimitsResponse(value, at), readAccount: async () => ({ kind: 'chatgpt' as const, authenticated: true, planType: 'plus', requiresOpenaiAuth: true, diagnostics: [] }) });
    await refreshFromOwner(read(initial, NOW), { accountId: null, threadId: owner.threadId }, store, { nowMs: NOW });
    const revoked = { accountId: owner.accountId, ordinaryUsageAllowed: false, rateLimits: { planType: 'plus', spendControlReached: false } };
    await refreshFromOwner(read(revoked, NOW + 1_000), { accountId: null, threadId: owner.threadId }, store, { nowMs: NOW + 1_000 });
    const account = store.read(ACCOUNT_IDENTITY, 'account') as Record<string, unknown>;
    expect((account['rateLimits'] as Record<string, unknown>)['ordinaryUsageAllowed']).toBe(false);
    const facts = assembleFacts(EMPTY_ROLLOUT, readAccountRecord(store), CODEX_DEFAULTS, NOW + 1_001);
    expect(facts.capacity).not.toBe('included');
    expect(facts.automationAllowed).toBe(false);
  });

  test('fulfilled account revocation clears auth when quota refresh fails', async () => {
    const store = new CodexStore(mkdtempSync(join(FIXTURE_ROOT, `auth-revocation-${Date.now()}`)));
    const limits = {
      accountId: owner.accountId,
      ordinaryUsageAllowed: true,
      rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } }
    };
    await refreshFromOwner({ readRateLimits: async () => parseRateLimitsResponse(limits, NOW), readAccount: async () => ({ kind: 'chatgpt' as const, authenticated: true, planType: 'plus', requiresOpenaiAuth: true, diagnostics: [] }) }, { accountId: null, threadId: owner.threadId }, store, { nowMs: NOW });
    const client = {
      readRateLimits: async () => { throw new Error('account switched'); },
      readAccount: async () => ({ kind: 'unknown' as const, authenticated: false, planType: null, requiresOpenaiAuth: true, diagnostics: ['logged out'] })
    };
    await expect(refreshFromOwner(client, owner, store, { nowMs: NOW + 1_000 })).resolves.not.toBeNull();
    const account = store.read(ACCOUNT_IDENTITY, 'account') as Record<string, unknown>;
    expect(account['authenticated']).toBe(false);
    expect(account['authObservedAtMs']).toBe(NOW + 1_000);
    expect(account['quotaObservedAtMs']).toBe(NOW);
    expect(assembleFacts(EMPTY_ROLLOUT, readAccountRecord(store), CODEX_DEFAULTS, NOW + 1_001).automationAllowed).toBe(false);
  });

  test('presence persists through a canonical cache-root alias', () => {
    const real = join(FIXTURE_ROOT, `presence-real-${Date.now()}`);
    const alias = join(FIXTURE_ROOT, `presence-alias-${Date.now()}`);
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias);
    samplePresence({ ...CODEX_DEFAULTS, presence: { ...CODEX_DEFAULTS.presence, enabled: false } }, NOW, null, alias);
    expect(existsSync(presenceStateFile(alias))).toBe(true);
  });

  test('presence refuses an owned-subtree symlink while accepting a cache-root alias', () => {
    const real = join(FIXTURE_ROOT, `presence-confined-${Date.now()}`);
    const alias = join(FIXTURE_ROOT, `presence-confined-alias-${Date.now()}`);
    const outside = join(FIXTURE_ROOT, `presence-outside-${Date.now()}`);
    mkdirSync(real, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(real, alias);
    symlinkSync(outside, join(real, 'cc-pacekeeper'));
    const sample = samplePresence({ ...CODEX_DEFAULTS, presence: { ...CODEX_DEFAULTS.presence, enabled: false } }, NOW, null, alias);
    expect(sample.persisted).toBe(false);
    expect(existsSync(join(outside, 'codex', 'presence-state.json'))).toBe(false);
  });

  test('checkpoint provenance follows a linked worktree while storage stays shared', () => {
    const repo = join(FIXTURE_ROOT, `provenance-${Date.now()}`);
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git(['init', '-q']);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'file.txt'), 'fixture');
    writeFileSync(join(repo, 'src', 'entry.txt'), 'fixture');
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=test.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
    const child = join(repo, '.codex-worktrees', 'child');
    git(['worktree', 'add', '-q', '-b', 'fixture-child', child]);
    const provenance = invokingProvenance(join(child, 'src'));
    expect(provenance.branch).toBe('fixture-child');
    expect(provenance.worktree).toBe(child);
  });

  test('plugin manifest uses the current relative hook and portable root contracts', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../.codex-plugin/plugin.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest['hooks']).toBe('./hooks/hooks.json');
    expect(manifest['skills']).toBe('./skills/');
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, '../../hooks/hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>> };
    expect(Object.keys(hooks)).toEqual(['hooks']);
    const commands = Object.values(hooks.hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command).filter((command): command is string => command !== undefined)));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.startsWith('"${PLUGIN_ROOT}/') && command.endsWith('"'))).toBe(true);
    const marketplace = JSON.parse(readFileSync(join(import.meta.dir, '../../../../.agents/plugins/marketplace.json'), 'utf8')) as { plugins?: Array<Record<string, unknown>> };
    expect(marketplace.plugins?.find((plugin) => plugin['name'] === 'codex-pacekeeper')?.['source']).toBe('./plugins/codex-pacekeeper');
  });

  test('malformed Claude occupancy data stays unknown for cleanup', () => {
    const dir = join(FIXTURE_ROOT, `claude-sessions-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{');
    expect(listLiveClaudeSessions(dir)).toBeNull();
  });
});
