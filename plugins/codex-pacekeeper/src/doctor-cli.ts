#!/usr/bin/env bun
/** Environment diagnostics. No owner is started and no credential is read; the
 * only write is the account record a successful native read refreshes. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCodexConfig } from './config';
import { diagnose, type DoctorReport } from './doctor';
import { discoverNativeControlClient, findCodexExecutable, nativeControlSocketPath } from './live-sessions';
import { NATIVE_PROTOCOL_VERSION, normalizeNativeCapabilities } from './native';
import { refreshFromOwner } from './refresh';
import { findRolloutForThread, readRollout } from './rollout';
import { lastKeepalivePing } from './service';
import { CodexStore } from './storage';
import { assembleFacts, readAccountRecord } from './tick';

function executableVersion(executable: string | null): string | null {
  if (!executable) return null;
  try { return execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

function permissionsObserved(): boolean | null {
  const cacheHome = process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache');
  const target = path.join(cacheHome, 'cc-pacekeeper');
  try {
    const parent = fs.existsSync(target) ? target : path.dirname(target);
    fs.accessSync(parent, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch { return false; }
}

function crashCountObserved(): number | null {
  try { return new CodexStore().list('crash').length; } catch { return null; }
}

export async function runDoctorCli(): Promise<DoctorReport> {
  const loaded = loadCodexConfig(process.env['XDG_CONFIG_HOME']);
  const config = loaded.config;
  const store = new CodexStore();
  const nowMs = Date.now();
  const threadId = process.env['CODEX_THREAD_ID']?.trim() || undefined;
  const executable = findCodexExecutable();
  const version = executableVersion(executable);
  const socket = nativeControlSocketPath();
  let ownerStatus: 'found' | 'absent' | 'unknown' = 'unknown';
  let capabilities = normalizeNativeCapabilities({ version: 'unknown' });
  let protocolObserved = false;
  if (threadId !== undefined && socket !== null) {
    const client = await discoverNativeControlClient(threadId, null);
    ownerStatus = client === null ? 'absent' : 'found';
    if (client !== null) {
      capabilities = client.capabilities;
      protocolObserved = true;
      await refreshFromOwner(client, { accountId: null, threadId }, store, { nowMs });
    }
  }
  const rollout = threadId === undefined ? null : readRollout(findRolloutForThread(threadId), nowMs, threadId);
  const account = readAccountRecord(store);
  const facts = assembleFacts(rollout ?? { meta: null, tokenUsage: null, tokenUsageObservedAtMs: null, rateLimits: null, rateLimitsObservedAtMs: null, compactedSinceUsage: false }, account, config, nowMs);
  const quotaAt = Math.max(typeof account.quotaObservedAtMs === 'number' ? account.quotaObservedAtMs : -1, rollout?.rateLimitsObservedAtMs ?? -1);
  const authAt = typeof account.authObservedAtMs === 'number' ? account.authObservedAtMs : null;
  const authenticated = typeof account.authenticated === 'boolean' && authAt !== null && nowMs - authAt <= 3_600_000 ? account.authenticated : null;
  const timeline = threadId === undefined ? null : store.read({ accountId: null, threadId }, 'timeline') as Record<string, unknown> | null;
  const heartbeat = store.read({ accountId: null, threadId: 'service' }, 'service') as Record<string, unknown> | null;
  const beatAt = typeof heartbeat?.['heartbeatAtMs'] === 'number' ? heartbeat['heartbeatAtMs'] : null;
  const lastPing = threadId === undefined ? null : lastKeepalivePing(store.list('job'), threadId);
  const cache = facts.context?.cache;
  return diagnose({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    capabilities,
    ownerStatus,
    authenticated,
    capacity: facts.capacity,
    quotaAgeSeconds: quotaAt < 0 ? Number.POSITIVE_INFINITY : Math.max(0, (nowMs - quotaAt) / 1000),
    freshnessSeconds: config.usage_freshness_seconds,
    configDiagnostics: loaded.diagnostics,
    protocolObserved,
    nativeControlSocketObserved: socket !== null,
    rollout: rollout === null ? null : { found: rollout.meta !== null, tokenCount: rollout.tokenUsage !== null, rateLimits: rollout.rateLimits !== null },
    serviceHeartbeatAgeSeconds: beatAt === null ? null : Math.max(0, (nowMs - beatAt) / 1000),
    keepalive: { enabled: config.keepalive.enabled, pendingWork: typeof timeline?.['pendingWork'] === 'boolean' ? timeline['pendingWork'] : null },
    lastPing: lastPing === null ? null : {
      pongVerified: lastPing.pongVerified,
      result: lastPing.result,
      toolCalls: lastPing.toolCalls ?? null,
      ageSeconds: Math.max(0, (nowMs - lastPing.completedAtMs) / 1000)
    },
    executableObserved: executable !== null,
    executableVersion: version,
    // A timeline row exists only after a hook ran, which proves trust.
    hookTrust: threadId === undefined ? null : timeline !== null ? true : null,
    permissionsOk: permissionsObserved(),
    crashCount: crashCountObserved(),
    ...(cache ? { cacheFields: { cachedInputTokens: cache.cachedInputTokens !== null, cacheWriteInputTokens: cache.cacheWriteInputTokens !== null } } : {})
  });
}

async function main(): Promise<void> {
  const report = await runDoctorCli();
  const symbol: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✗', blocked: '✗', deferred: '–' };
  for (const check of report.checks) console.log(`${symbol[check.status]} ${check.name}: ${check.detail}`);
  console.log(`\noverall: ${report.overall}`);
  if (report.checks.some((check) => check.status === 'fail')) process.exitCode = 1;
}

if (import.meta.main) void main();
