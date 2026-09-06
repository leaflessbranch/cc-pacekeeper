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

function observedBoolean(name: string): boolean | null {
  const value = process.env[name];
  if (value === undefined) return null;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return null;
}

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
  const ownerStatus = threadId ? findLiveOwner(threadId, accountId).status : 'unknown';
  const executable = findCodexExecutable();
  const version = executableVersion(executable);
  const protocolVersion = registry.owners.map((owner) => typeof owner.protocolVersion === 'string' ? owner.protocolVersion : null).find((value): value is string => value !== null && value !== 'unknown') ?? 'unknown';
  // A registry version is an observation, but a method list is still absent.
  // Therefore queue/rate-limit capabilities remain unavailable until an actual
  // native handshake supplies the schema.
  return diagnose({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    capabilities: normalizeNativeCapabilities({ version: protocolVersion }),
    ownerStatus,
    authenticated: observedBoolean('CODEX_AUTHENTICATED'),
    capacity: 'unknown',
    quotaAgeSeconds: Number.POSITIVE_INFINITY,
    freshnessSeconds: config.config.usage_freshness_seconds,
    configDiagnostics: config.diagnostics,
    protocolObserved: protocolVersion !== 'unknown',
    executableObserved: executable !== null,
    executableVersion: version,
    hookTrust: observedBoolean('CODEX_HOOK_TRUSTED'),
    permissionsOk: permissionsObserved(),
    crashCount: crashCountObserved()
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
