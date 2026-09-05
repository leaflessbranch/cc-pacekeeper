/**
 * Read-only diagnostics entrypoint.
 *
 * It reports what the configuration and pinned protocol establish. It makes no
 * native calls, sends nothing, and changes nothing, so it is safe to run at any
 * time, including while a session is live.
 */
import { loadCodexConfig } from './config';
import { NATIVE_PROTOCOL_VERSION, normalizeNativeCapabilities } from './native';
import { diagnose } from './doctor';

const loaded = loadCodexConfig();
// No owner probe is performed here: discovering an owner requires talking to a
// running server, and this command is deliberately read-only.
const report = diagnose({
  protocolVersion: NATIVE_PROTOCOL_VERSION,
  capabilities: normalizeNativeCapabilities({ version: NATIVE_PROTOCOL_VERSION }),
  ownerStatus: 'unknown',
  authenticated: false,
  capacity: 'unknown',
  quotaAgeSeconds: Number.POSITIVE_INFINITY,
  freshnessSeconds: loaded.config.usage_freshness_seconds,
  configDiagnostics: loaded.diagnostics
});

const symbol: Record<string, string> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'FAIL',
  blocked: 'blocked',
  deferred: 'deferred'
};
for (const check of report.checks) {
  console.log(`[${symbol[check.status]}] ${check.name}: ${check.detail}`);
}
console.log(`\noverall: ${report.overall}`);
