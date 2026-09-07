/**
 * Structured Codex diagnostics.
 *
 * Two rules govern this report. A capability blocked by a missing platform
 * feature is reported as `blocked`, never as `ok` and never as a plain
 * failure: it will not start working after a retry, and calling it healthy
 * would be a false support claim. And nothing here identifies an account,
 * thread or prompt, because a diagnostic report is the thing users paste into
 * issues.
 *
 * The report is read-only. It performs no native calls of its own; a caller
 * supplies what it already observed.
 */
import type { NativeCapabilities } from './native';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'blocked' | 'deferred';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  overall: CheckStatus;
  checks: DoctorCheck[];
}

export interface DoctorInput {
  protocolVersion: string;
  capabilities: NativeCapabilities;
  ownerStatus: 'found' | 'absent' | 'ambiguous' | 'unknown';
  authenticated: boolean | null;
  capacity: 'included' | 'paid' | 'unknown' | 'unsupported';
  /** Age of the most recent quota reading. */
  quotaAgeSeconds: number;
  freshnessSeconds: number;
  configDiagnostics: string[];
  /** Explicitly false when no native handshake/version read occurred. */
  protocolObserved?: boolean;
  /** Executable/version checks are supplied by the CLI, never self-asserted. */
  executableObserved?: boolean;
  executableVersion?: string | null;
  hookTrust?: boolean | null;
  permissionsOk?: boolean | null;
  crashCount?: number | null;
  cacheFields?: {
    cachedInputTokens: boolean;
    cacheWriteInputTokens: boolean;
  };
  /** Persistent sampler state is local; proactive native notification needs a
   * separate, observed harness delivery boundary. */
  presenceDelivery?: 'observed' | 'unavailable' | 'unknown';
  /** Accepted so a caller need not strip them; never included in the report. */
  accountId?: string;
  threadId?: string;
}

/** Worst-first ordering for the overall verdict. `deferred` is out of scope. */
const SEVERITY: readonly CheckStatus[] = ['ok', 'warn', 'blocked', 'fail'];

export function diagnose(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];

  const protocolObserved = input.protocolObserved
    ?? (input.capabilities.protocolVersion !== 'unknown'
      && input.capabilities.queue !== 'unavailable');

  checks.push({
    name: 'protocol version',
    status: !protocolObserved ? 'warn' : input.capabilities.versionMatchesPin ? 'ok' : 'warn',
    detail: !protocolObserved
      ? 'native protocol version was not observed; no pinned-version claim is made'
      : input.capabilities.versionMatchesPin
      ? `matches the pinned acceptance target ${input.protocolVersion}`
      : `reports ${input.capabilities.protocolVersion}, which differs from the pinned target; ` +
        'capabilities are read from the server rather than assumed'
  });

  checks.push({
    name: 'native owner',
    status:
      input.ownerStatus === 'found'
        ? 'ok'
        : input.ownerStatus === 'absent'
          ? 'fail'
          : 'warn',
    detail:
      input.ownerStatus === 'found'
        ? 'exactly one live owner was identified for this thread'
        : input.ownerStatus === 'absent'
          ? 'no live owner holds this thread; delivery has no target'
          : `owner selection was ${input.ownerStatus}; delivery is withheld rather than guessed`
  });

  checks.push({
    name: 'queue delivery',
    status:
      input.capabilities.queue === 'supported'
        ? 'ok'
        : input.capabilities.queue === 'unsupported'
          ? 'fail'
          : 'warn',
    detail:
      input.capabilities.queue === 'supported'
        ? 'thread/queue/add is available on the existing owner'
        : `thread/queue/add is ${input.capabilities.queue}; scheduled delivery cannot be confirmed`
  });

  checks.push({
    name: 'authentication',
    status: input.authenticated === true ? 'ok' : input.authenticated === false ? 'fail' : 'warn',
    detail: input.authenticated === true
      ? 'a subscription account is authenticated'
      : input.authenticated === false
        ? 'no supported subscription authentication was found'
        : 'subscription authentication was not observed; automation stays disabled'
  });

  checks.push({
    name: 'quota readings',
    status: input.capabilities.accountRateLimits === 'supported' ? 'ok' : 'fail',
    detail:
      input.capabilities.accountRateLimits === 'supported'
        ? 'account/rateLimits/read is available'
        : `account/rateLimits/read is ${input.capabilities.accountRateLimits}; quotas are not confirmed readable`
  });

  const neverRead = !Number.isFinite(input.quotaAgeSeconds);
  const stale = input.quotaAgeSeconds > input.freshnessSeconds;
  checks.push({
    name: 'quota freshness',
    status: stale ? 'warn' : 'ok',
    detail: neverRead
      ? 'no quota reading has been taken; automation stays disabled until one is'
      : stale
        ? `the last reading is ${input.quotaAgeSeconds}s old, beyond the ${input.freshnessSeconds}s window; ` +
          'automation stays disabled until it refreshes'
        : `the last reading is ${input.quotaAgeSeconds}s old`
  });

  checks.push({
    name: 'Codex executable',
    status: input.executableObserved === true ? 'ok' : 'warn',
    detail: input.executableObserved === true
      ? `an executable was observed${input.executableVersion ? ` (${input.executableVersion})` : ''}`
      : 'the installed Codex executable was not observed; version is not self-reported'
  });

  checks.push({
    name: 'hook trust',
    status: input.hookTrust === true ? 'ok' : input.hookTrust === false ? 'fail' : 'warn',
    detail: input.hookTrust === true
      ? 'the hook trust state was observed as enabled'
      : input.hookTrust === false
        ? 'the hook is not trusted by the harness'
        : 'hook trust was not observed; configured hooks are not treated as executed'
  });

  checks.push({
    name: 'state permissions',
    status: input.permissionsOk === true ? 'ok' : input.permissionsOk === false ? 'fail' : 'warn',
    detail: input.permissionsOk === true
      ? 'state directories are writable'
      : input.permissionsOk === false
        ? 'state directories are not writable'
        : 'state directory permissions were not observed'
  });

  checks.push({
    name: 'crash breadcrumbs',
    status: input.crashCount === undefined || input.crashCount === null
      ? 'warn'
      : input.crashCount === 0 ? 'ok' : 'warn',
    detail: input.crashCount === undefined || input.crashCount === null
      ? 'crash breadcrumbs were not observed'
      : input.crashCount === 0
        ? 'none recorded'
        : `${input.crashCount} recorded crash breadcrumb(s)`
  });

  checks.push({
    name: 'cache fields',
    status: input.cacheFields === undefined
      ? 'warn'
      : input.cacheFields.cachedInputTokens
        ? 'ok'
        : 'warn',
    detail: input.cacheFields === undefined
      ? 'native cache read/write fields were not observed'
      : `cachedInputTokens=${input.cacheFields.cachedInputTokens ? 'observed' : 'missing'}, `
        + `cacheWriteInputTokens=${input.cacheFields.cacheWriteInputTokens ? 'observed' : 'missing'}`
  });

  checks.push({
    name: 'presence delivery',
    status: input.presenceDelivery === 'observed' ? 'ok' : 'blocked',
    detail: input.presenceDelivery === 'observed'
      ? 'presence transitions have an observed native notification path'
      : 'local presence transitions are sampled and persisted, but a proactive native notification path was not observed'
  });

  checks.push({
    name: 'subscription capacity',
    status:
      input.capacity === 'included' ? 'ok' : input.capacity === 'unsupported' ? 'fail' : 'warn',
    detail:
      input.capacity === 'included'
        ? 'included subscription capacity is confirmed fresh'
        : `capacity is ${input.capacity}; automation that would spend it stays disabled`
  });

  checks.push({
    name: 'configuration',
    status: input.configDiagnostics.length === 0 ? 'ok' : 'warn',
    detail:
      input.configDiagnostics.length === 0
        ? 'configuration validated'
        : input.configDiagnostics.join('; ')
  });

  // Blocked by a missing platform capability, verified against the pinned
  // protocol schema and the official hooks documentation. These do not become
  // healthy on a retry.
  checks.push({
    name: 'strict no-tools',
    status: 'blocked',
    detail:
      'no protocol field or method disables tools for a turn, and there is no blanket ' +
      'no-tools mode; hosted web search and post-exec write_stdin bypass PreToolUse, ' +
      'so a deny-all hook is not a boundary'
  });
  checks.push({
    name: 'pre-model suppression',
    status: 'blocked',
    detail:
      'thread/queue/delete can remove a queued submission, but the pinned protocol ' +
      'does not prove that deletion wins an execution race before model work begins; ' +
      'a ping that loses a race with real user input remains unverified'
  });
  checks.push({
    name: 'compaction save barrier',
    status: 'blocked',
    detail:
      'PreCompact ignores plain stdout and can only prevent compaction; preventing ' +
      'compaction is not a model-generated resumable save'
  });

  // Deliberately out of scope for Codex. Existing Claude behavior is preserved.
  checks.push({
    name: 'model/window arbitrage',
    status: 'deferred',
    detail: 'not implemented for Codex by decision; native model switching is not duplicated'
  });
  checks.push({
    name: 'away routing',
    status: 'deferred',
    detail: 'not implemented for Codex by decision; no destination is requested or stored'
  });

  let overall: CheckStatus = 'ok';
  for (const entry of checks) {
    if (entry.status === 'deferred') continue;
    if (SEVERITY.indexOf(entry.status) > SEVERITY.indexOf(overall)) overall = entry.status;
  }
  return { overall, checks };
}
