#!/usr/bin/env bun
/** Read-only environment diagnostics. No owner is started and no credential is read. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCodexConfig } from './config';
import { diagnose, type DoctorReport } from './doctor';
import { findCodexExecutable, findLiveOwner, readOwnerRegistry } from './live-sessions';
import { NATIVE_PROTOCOL_VERSION, normalizeNativeCapabilities } from './native';
import { CodexStore } from './storage';

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

export function runDoctorCli(): DoctorReport {
  const config = loadCodexConfig(process.env['XDG_CONFIG_HOME']);
  const registry = readOwnerRegistry();
  const threadId = process.env['CODEX_THREAD_ID'];
  const accountId = process.env['CODEX_ACCOUNT_ID'] ?? null;
  const ownerLookup = threadId ? findLiveOwner(threadId, accountId) : null;
  const owner = ownerLookup?.owner;
  const ownerStatus = ownerLookup?.status ?? 'unknown';
  const executable = findCodexExecutable();
  const version = executableVersion(executable);
  const protocolVersion = owner?.protocolVersion
    ?? registry.owners.map((candidate) => typeof candidate.protocolVersion === 'string' ? candidate.protocolVersion : null).find((value): value is string => value !== null && value !== 'unknown')
    ?? 'unknown';
  // A method list published by the selected owner is an observed capability
  // record. It is still separate from a successful request, so account facts
  // and quota freshness remain unknown until a native read supplies them.
  const capabilities = normalizeNativeCapabilities({ version: protocolVersion, methods: owner?.methods });
  const protocolObserved = owner !== undefined
    && owner.protocolVersion !== 'unknown'
    && owner.methods !== undefined;
  const timeline = threadId && ownerStatus === 'found'
    ? new CodexStore().read({ accountId, threadId }, 'timeline')
    : null;
  const timelineRow = typeof timeline === 'object' && timeline !== null ? timeline as Record<string, unknown> : null;
  const lastObservedAtMs = typeof timelineRow?.['quotaObservedAtMs'] === 'number'
    ? timelineRow['quotaObservedAtMs']
    : null;
  const quotaAgeSeconds = lastObservedAtMs === null ? Number.POSITIVE_INFINITY : Math.max(0, (Date.now() - lastObservedAtMs) / 1000);
  const authObservedAtMs = typeof timelineRow?.['authObservedAtMs'] === 'number' ? timelineRow['authObservedAtMs'] : null;
  const authenticated = typeof timelineRow?.['authenticated'] === 'boolean'
    && authObservedAtMs !== null
    && Date.now() >= authObservedAtMs
    && Date.now() - authObservedAtMs <= config.config.usage_freshness_seconds * 1000
    ? timelineRow['authenticated'] as boolean
    : null;
  const cache = typeof timelineRow?.['tokenUsage'] === 'object' && timelineRow['tokenUsage'] !== null
    ? (timelineRow['tokenUsage'] as Record<string, unknown>)['cache']
    : null;
  const cacheRow = typeof cache === 'object' && cache !== null ? cache as Record<string, unknown> : null;
  return diagnose({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    capabilities,
    ownerStatus,
    authenticated,
    capacity: 'unknown',
    quotaAgeSeconds,
    freshnessSeconds: config.config.usage_freshness_seconds,
    configDiagnostics: config.diagnostics,
    protocolObserved,
    executableObserved: executable !== null,
    executableVersion: version,
    // Environment configuration can say a hook is enabled, but it cannot
    // prove that the harness invoked or trusted it. Keep this unobserved until
    // an actual hook receipt is available.
    hookTrust: null,
    permissionsOk: permissionsObserved(),
    crashCount: crashCountObserved(),
    cacheFields: cacheRow === null ? undefined : {
      cachedInputTokens: cacheRow['cachedInputTokens'] !== null && cacheRow['cachedInputTokens'] !== undefined,
      cacheWriteInputTokens: cacheRow['cacheWriteInputTokens'] !== null && cacheRow['cacheWriteInputTokens'] !== undefined
    }
  });
}

function main(): void {
  const report = runDoctorCli();
  const symbol: Record<string, string> = { ok: 'ok', warn: 'warn', fail: 'FAIL', blocked: 'blocked', deferred: 'deferred' };
  for (const check of report.checks) console.log(`[${symbol[check.status]}] ${check.name}: ${check.detail}`);
  console.log(`\noverall: ${report.overall}`);
  if (report.checks.some((check) => check.status === 'fail')) process.exitCode = 1;
}

if (import.meta.main) main();
