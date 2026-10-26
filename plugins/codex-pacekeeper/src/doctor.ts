/**
 * Structured Codex diagnostics.
 *
 * Two rules govern this report. A capability Codex does not offer is
 * reported as `deferred` with the reason, never as `ok`. And nothing here
 * identifies an account, thread or prompt, because a diagnostic report is the
 * thing users paste into issues.
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
  /** Whether the local control socket hosts the current thread. */
  ownerStatus: 'found' | 'absent' | 'ambiguous' | 'unknown';
  authenticated: boolean | null;
  capacity: 'included' | 'paid' | 'unknown' | 'unsupported';
  /** Age of the most recent quota reading from either source. */
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
  /** A socket path is endpoint evidence only; it does not prove a thread is loaded. */
  nativeControlSocketObserved?: boolean;
  /** The current thread's rollout: found, and whether it carried a token count. */
  rollout?: { found: boolean; tokenCount: boolean; rateLimits: boolean } | null;
  /** Background service heartbeat age, or null when it never ran. */
  serviceHeartbeatAgeSeconds?: number | null;
  /** Keepalive configuration and pending-work state for the current thread. */
  keepalive?: { enabled: boolean; pendingWork: boolean | null };
  /** The most recent completed ping for this thread. */
  lastPing?: { pongVerified: boolean; result: string | null; toolCalls: number | null; ageSeconds: number } | null;
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

  if (input.rollout !== undefined) {
    const rollout = input.rollout;
    checks.push({
      name: 'rollout readings',
      status: rollout !== null && rollout.found && rollout.tokenCount ? 'ok' : 'warn',
      detail: rollout === null
        ? 'not run inside a Codex session (CODEX_THREAD_ID unset); the hook reads context and the default quota bucket from the rollout'
        : !rollout.found
          ? 'this thread\'s rollout was not found under CODEX_HOME/sessions; context and quota fall back to the native read'
          : rollout.tokenCount
            ? `context is readable from the rollout${rollout.rateLimits ? ', and so is the default rate-limit bucket' : '; no rate-limit snapshot yet'}`
            : 'the rollout has no token count yet; meters appear after the first model response'
    });
  }

  if (input.nativeControlSocketObserved !== undefined) {
    checks.push({
      name: 'native control socket',
      status: input.nativeControlSocketObserved ? 'ok' : 'warn',
      detail: input.nativeControlSocketObserved
        ? 'the local Codex control socket is present'
        : 'the local Codex control socket was not found; keepalive, reset wake and the account read need it'
    });
  }

  checks.push({
    name: 'native owner',
    status: input.ownerStatus === 'found' ? 'ok' : input.ownerStatus === 'absent' ? 'fail' : 'warn',
    detail:
      input.ownerStatus === 'found'
        ? 'the control socket hosts this thread, so pings and wakes have a target'
        : input.ownerStatus === 'absent'
          ? 'the control socket does not host this thread; delivery has no target'
          : 'not checked: run doctor from inside a Codex session whose control socket is available'
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
        ? 'thread/queue/add is available; a queued ping starts when the thread is idle'
        : `thread/queue/add is ${input.capabilities.queue}; scheduled delivery cannot be confirmed`
  });

  checks.push({
    name: 'authentication',
    status: input.authenticated === true ? 'ok' : input.authenticated === false ? 'fail' : 'warn',
    detail: input.authenticated === true
      ? 'a subscription account is authenticated'
      : input.authenticated === false
        ? 'no supported subscription authentication was found'
        : 'subscription authentication was not observed recently; keepalive and wake wait for a fresh read'
  });

  const neverRead = !Number.isFinite(input.quotaAgeSeconds);
  const stale = input.quotaAgeSeconds > input.freshnessSeconds;
  checks.push({
    name: 'quota freshness',
    status: neverRead ? 'warn' : 'ok',
    detail: neverRead
      ? 'no quota reading has been taken yet; it arrives with the first model response'
      : stale
        ? `the last reading is ${Math.round(input.quotaAgeSeconds)}s old; the service refreshes it before any delivery`
        : `the last reading is ${Math.round(input.quotaAgeSeconds)}s old`
  });

  if (input.keepalive !== undefined) {
    const heartbeat = input.serviceHeartbeatAgeSeconds;
    const running = heartbeat !== null && heartbeat !== undefined && heartbeat < 90;
    const needed = input.keepalive.enabled && input.keepalive.pendingWork === true;
    checks.push({
      name: 'keepalive service',
      status: !input.keepalive.enabled ? 'ok' : running || !needed ? 'ok' : 'warn',
      detail: !input.keepalive.enabled
        ? 'keepalive is disabled in the configuration'
        : running
          ? 'the background service is running'
          : needed
            ? 'work is pending but the background service is not running; the next turn end relaunches it'
            : 'idle (it starts at a turn end when a checkpoint or handoff is pending)'
    });
    const ping = input.lastPing;
    if (ping !== undefined && ping !== null) {
      checks.push({
        name: 'last keepalive ping',
        status: ping.pongVerified ? 'ok' : 'warn',
        detail: ping.pongVerified
          ? `answered pong with no tools ${Math.round(ping.ageSeconds / 60)}m ago`
          : `${Math.round(ping.ageSeconds / 60)}m ago the ping replied ${JSON.stringify(ping.result ?? '')} with ${ping.toolCalls ?? '?'} tool call(s); the cache was still refreshed`
      });
    }
  }

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
      ? 'a hook ran for this thread'
      : input.hookTrust === false
        ? 'the hook is not trusted by the harness'
        : 'no hook has run for this thread; trust the plugin\'s hooks in Codex'
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

  if (input.cacheFields !== undefined) {
    checks.push({
      name: 'cache fields',
      status: input.cacheFields.cachedInputTokens ? 'ok' : 'warn',
      detail: `cachedInputTokens=${input.cacheFields.cachedInputTokens ? 'observed' : 'missing'}, `
        + `cacheWriteInputTokens=${input.cacheFields.cacheWriteInputTokens ? 'observed' : 'missing'}`
    });
  }

  checks.push({
    name: 'subscription capacity',
    status:
      input.capacity === 'included' ? 'ok' : input.capacity === 'unsupported' ? 'fail' : 'warn',
    detail:
      input.capacity === 'included'
        ? 'included subscription capacity is confirmed'
        : `capacity is ${input.capacity}; keepalive and wake send nothing until included capacity is confirmed`
  });

  checks.push({
    name: 'configuration',
    status: input.configDiagnostics.length === 0 ? 'ok' : 'warn',
    detail:
      input.configDiagnostics.length === 0
        ? 'configuration validated'
        : input.configDiagnostics.join('; ')
  });

  // Out of scope for Codex. Existing Claude behavior is preserved.
  checks.push({
    name: 'model/window arbitrage',
    status: 'deferred',
    detail: 'not implemented for Codex: Codex exposes no per-family weekly bucket to arbitrage between'
  });
  checks.push({
    name: 'presence and away routing',
    status: 'deferred',
    detail: 'Codex has no plugin monitor to deliver presence changes; the service samples presence locally, and no channel destination is requested or stored'
  });

  let overall: CheckStatus = 'ok';
  for (const entry of checks) {
    if (entry.status === 'deferred') continue;
    if (SEVERITY.indexOf(entry.status) > SEVERITY.indexOf(overall)) overall = entry.status;
  }
  return { overall, checks };
}
