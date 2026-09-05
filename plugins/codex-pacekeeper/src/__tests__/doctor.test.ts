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

  test('a version mismatch warns without disabling a working queue', () => {
    const report = diagnose(
      input({
        capabilities: { ...input().capabilities, versionMatchesPin: false, protocolVersion: '0.154.0' }
      })
    );
    expect(check(report, 'protocol version').status).toBe('warn');
    expect(check(report, 'queue delivery').status).toBe('ok');
  });

  test('stale quota is reported distinctly from unreadable quota', () => {
    expect(check(diagnose(input({ quotaAgeSeconds: 600 })), 'quota freshness').status).toBe('warn');
    const unreadable = diagnose(
      input({ capabilities: { ...input().capabilities, accountRateLimits: 'unavailable' } })
    );
    expect(check(unreadable, 'quota readings').status).toBe('fail');
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

describe('blocked capabilities are never reported healthy', () => {
  // These rows are blocked by a missing platform capability. Reporting them as
  // ok would be the exact false claim the acceptance ledger forbids.
  test('strict no-tools reports blocked with its reason', () => {
    const entry = check(diagnose(input()), 'strict no-tools');
    expect(entry.status).toBe('blocked');
    expect(entry.detail.toLowerCase()).toContain('no');
  });

  test('pre-model suppression reports blocked', () => {
    expect(check(diagnose(input()), 'pre-model suppression').status).toBe('blocked');
  });

  test('the compaction save barrier reports blocked', () => {
    expect(check(diagnose(input()), 'compaction save barrier').status).toBe('blocked');
  });

  test('no check anywhere reports a blocked capability as ok', () => {
    const report = diagnose(input());
    for (const name of ['strict no-tools', 'pre-model suppression', 'compaction save barrier']) {
      expect(check(report, name).status).not.toBe('ok');
    }
  });
});

describe('deferred capabilities', () => {
  test('arbitrage and away routing are deferred, not failing', () => {
    const report = diagnose(input());
    expect(check(report, 'model/window arbitrage').status).toBe('deferred');
    expect(check(report, 'away routing').status).toBe('deferred');
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
    expect(diagnose(input()).overall).toBe('blocked');
    expect(diagnose(input({ ownerStatus: 'absent' })).overall).toBe('fail');
  });
});
