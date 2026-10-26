import { describe, expect, test } from 'bun:test';
import { NATIVE_PROTOCOL_VERSION } from '../native';
import { diagnose, type DoctorInput } from '../doctor';

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    capabilities: {
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      versionMatchesPin: true,
      queue: 'supported',
      accountRateLimits: 'supported',
      toolDisable: 'unsupported',
      preModelSuppression: 'unsupported',
      saveBarrier: 'unsupported'
    },
    ownerStatus: 'found',
    authenticated: true,
    capacity: 'included',
    quotaAgeSeconds: 5,
    freshnessSeconds: 180,
    configDiagnostics: [],
    ...overrides
  };
}

function check(report: ReturnType<typeof diagnose>, name: string) {
  const found = report.checks.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

describe('healthy baseline', () => {
  test('a supported owner and fresh included capacity report ok', () => {
    const report = diagnose(input());
    expect(check(report, 'native owner').status).toBe('ok');
    expect(check(report, 'quota freshness').status).toBe('ok');
    expect(check(report, 'subscription capacity').status).toBe('ok');
  });
});

describe('distinct failure modes', () => {
  test('an absent owner is distinguished from an unsupported queue', () => {
    expect(check(diagnose(input({ ownerStatus: 'absent' })), 'native owner').status).toBe('fail');
    const unsupported = diagnose(
      input({ capabilities: { ...input().capabilities, queue: 'unsupported' } })
    );
    expect(check(unsupported, 'queue delivery').status).toBe('fail');
    // The owner itself is still fine; only the capability is missing.
    expect(check(unsupported, 'native owner').status).toBe('ok');
  });

  test('an ambiguous owner is a warning, not a healthy result', () => {
    expect(check(diagnose(input({ ownerStatus: 'ambiguous' })), 'native owner').status).toBe('warn');
  });

  test('a missing control socket is a warning that names what needs it', () => {
    const report = diagnose(input({ nativeControlSocketObserved: false }));
    expect(check(report, 'native control socket').status).toBe('warn');
    expect(check(report, 'native control socket').detail).toContain('keepalive');
  });

  test('a version mismatch warns without disabling a working queue', () => {
    const report = diagnose(
      input({
        capabilities: { ...input().capabilities, versionMatchesPin: false, protocolVersion: '0.154.0' }
      })
    );
    expect(check(report, 'protocol version').status).toBe('warn');
    expect(check(report, 'queue delivery').status).toBe('ok');
  });

  test('stale quota is reported with its age; a never-read quota warns', () => {
    expect(check(diagnose(input({ quotaAgeSeconds: 600 })), 'quota freshness').detail).toContain('600s old');
    expect(check(diagnose(input({ quotaAgeSeconds: Number.POSITIVE_INFINITY })), 'quota freshness').status).toBe('warn');
  });

  test('unsupported authentication is a failure, never included capacity', () => {
    const report = diagnose(input({ authenticated: false, capacity: 'unsupported' }));
    expect(check(report, 'authentication').status).toBe('fail');
    expect(check(report, 'subscription capacity').status).toBe('fail');
  });

  test('paid capacity is surfaced without offering a purchase', () => {
    const report = diagnose(input({ capacity: 'paid' }));
    expect(check(report, 'subscription capacity').status).toBe('warn');
    const text = JSON.stringify(report).toLowerCase();
    expect(text).not.toContain('buy');
    expect(text).not.toContain('purchase');
  });

  test('invalid configuration is reported rather than silently defaulted', () => {
    const report = diagnose(input({ configDiagnostics: ['thresholds.weekly: out of order'] }));
    expect(check(report, 'configuration').status).toBe('warn');
    expect(check(report, 'configuration').detail).toContain('weekly');
  });
});

describe('keepalive diagnostics', () => {
  test('a missing service is a warning only when work is pending', () => {
    expect(check(diagnose(input({ keepalive: { enabled: true, pendingWork: true }, serviceHeartbeatAgeSeconds: null })), 'keepalive service').status).toBe('warn');
    expect(check(diagnose(input({ keepalive: { enabled: true, pendingWork: false }, serviceHeartbeatAgeSeconds: null })), 'keepalive service').status).toBe('ok');
    expect(check(diagnose(input({ keepalive: { enabled: true, pendingWork: true }, serviceHeartbeatAgeSeconds: 10 })), 'keepalive service').detail).toContain('running');
  });

  test('a non-exact ping reply is reported, not fatal', () => {
    const report = diagnose(input({ keepalive: { enabled: true, pendingWork: true }, serviceHeartbeatAgeSeconds: 5, lastPing: { pongVerified: false, result: 'Pong!', toolCalls: 0, ageSeconds: 600 } }));
    expect(check(report, 'last keepalive ping').status).toBe('warn');
    expect(check(report, 'last keepalive ping').detail).toContain('"Pong!"');
    expect(report.overall).toBe('warn');
  });

  test('rollout readings distinguish missing file, no token count yet and readable', () => {
    expect(check(diagnose(input({ rollout: { found: false, tokenCount: false, rateLimits: false } })), 'rollout readings').status).toBe('warn');
    expect(check(diagnose(input({ rollout: { found: true, tokenCount: false, rateLimits: false } })), 'rollout readings').detail).toContain('first model response');
    expect(check(diagnose(input({ rollout: { found: true, tokenCount: true, rateLimits: true } })), 'rollout readings').status).toBe('ok');
  });

  test('no capability is reported as blocked any more', () => {
    expect(diagnose(input()).checks.some((entry) => entry.status === 'blocked')).toBe(false);
  });
});

describe('deferred capabilities', () => {
  test('arbitrage and away routing are deferred, not failing', () => {
    const report = diagnose(input());
    expect(check(report, 'model/window arbitrage').status).toBe('deferred');
    expect(check(report, 'presence and away routing').status).toBe('deferred');
  });

  // Channels are deferred, so Codex must not ask a user to configure one.
  test('the report never asks for a channel preference', () => {
    const text = JSON.stringify(diagnose(input())).toLowerCase();
    expect(text).not.toContain('preferred channel');
    expect(text).not.toContain('configure a channel');
  });
});

describe('report hygiene', () => {
  test('the report is read-only and carries no credentials or prompts', () => {
    const report = diagnose(
      input({ accountId: 'acct-secret-1', threadId: 'thread-secret-1' })
    );
    const text = JSON.stringify(report);
    expect(text).not.toContain('acct-secret-1');
    expect(text).not.toContain('thread-secret-1');
  });

  test('overall health is the worst non-deferred check', () => {
    expect(diagnose(input({ hookTrust: true, permissionsOk: true, crashCount: 0, executableObserved: true, protocolObserved: true })).overall).toBe('ok');
    expect(diagnose(input({ ownerStatus: 'absent' })).overall).toBe('fail');
  });
});
