/**
 * Pure pacing decisions.
 *
 * No filesystem, clock or native access happens here: everything the decision
 * needs arrives in `DecisionInput`, and everything it changes leaves in
 * `nextState`. That is what makes the race and crash cases testable, and it
 * keeps the delivery mechanism separate from the policy that schedules it.
 */
import type { CodexConfig } from './config';
import type { CodexFacts, Level, MeterName } from './facts';

/** Native lifecycle events this policy encodes. */
export type PolicyEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'Interrupt';

export interface PolicyState {
  /** Last level emitted per meter, used to detect escalation. */
  levels: Partial<Record<MeterName, Level>>;
  lastInjectedAtMs: Partial<Record<MeterName, number>>;
  /** Reset time of the block the recorded levels belong to. */
  blockResetAtMs: number | null;
  /** Whether a context-critical save already ran this compaction cycle. */
  savedThisCycle: boolean;
  /** Last genuine user activity. Synthetic turns never advance this. */
  lastUserActivityAtMs?: number;
  /** Last substantive harness/model work; never treated as user presence. */
  lastWorkAtMs?: number;
  /** Last tool lifecycle event, retained for idle diagnostics only. */
  lastToolActivityAtMs?: number;
}

export interface DecisionInput {
  event: PolicyEvent;
  facts: CodexFacts;
  state: PolicyState;
  nowMs: number;
  /**
   * The native harness reports a continuation is already in flight. Injecting
   * again would extend the turn repeatedly rather than once.
   */
  continuationActive?: boolean;
  /**
   * This turn was produced by our own keepalive, not by the user. It must not
   * emit pacing output or count as user activity.
   */
  synthetic?: boolean;
  /** Explicit override for harnesses that can distinguish user input. */
  userActivity?: boolean;
}

export interface Decision {
  inject: boolean;
  level: Level | null;
  meter: MeterName | null;
  reason: string;
  nextState: PolicyState;
}

const ORDER: readonly Level[] = ['none', 'notify', 'warn', 'critical'];

function rank(level: Level | null): number {
  return level === null ? -1 : ORDER.indexOf(level);
}

/** Events that cannot usefully carry injected context back to the model. */
const SILENT_EVENTS: ReadonlySet<PolicyEvent> = new Set<PolicyEvent>([
  'SessionEnd',
  'PostToolUse',
  'Interrupt'
]);

export function decide(input: DecisionInput, config: CodexConfig): Decision {
  const { facts, state, nowMs } = input;

  // Synthetic keepalive events have no policy side effects at all. In
  // particular, do not first apply a new-block reset: doing so clears the
  // debounce/save state even though the ping must be transparent.
  if (input.synthetic === true) {
    return {
      inject: false,
      level: null,
      meter: null,
      reason: 'synthetic turn: policy output suppressed',
      nextState: {
        ...state,
        levels: { ...state.levels },
        lastInjectedAtMs: { ...state.lastInjectedAtMs }
      }
    };
  }

  // A new block invalidates the levels recorded against the previous one, so
  // the first reminder of the new block is not suppressed by the old one.
  const resetAtMs = facts.fiveHour?.resetsAtMs ?? null;
  const blockChanged = resetAtMs !== null && state.blockResetAtMs !== null && resetAtMs !== state.blockResetAtMs;
  const base: PolicyState = blockChanged
    ? {
        levels: {},
        lastInjectedAtMs: {},
        blockResetAtMs: resetAtMs,
        savedThisCycle: false,
        ...(state.lastUserActivityAtMs !== undefined ? { lastUserActivityAtMs: state.lastUserActivityAtMs } : {}),
        ...(state.lastWorkAtMs !== undefined ? { lastWorkAtMs: state.lastWorkAtMs } : {}),
        ...(state.lastToolActivityAtMs !== undefined ? { lastToolActivityAtMs: state.lastToolActivityAtMs } : {})
      }
    : {
        ...state,
        levels: { ...state.levels },
        lastInjectedAtMs: { ...state.lastInjectedAtMs },
        blockResetAtMs: resetAtMs ?? state.blockResetAtMs
      };

  const isUserActivity = input.userActivity ?? input.event === 'UserPromptSubmit';
  const isToolEvent = input.event === 'PreToolUse' || input.event === 'PostToolUse';
  const nextState: PolicyState = {
    ...base,
    ...(isUserActivity ? { lastUserActivityAtMs: nowMs } : {}),
    ...(isToolEvent ? { lastToolActivityAtMs: nowMs, lastWorkAtMs: nowMs } : {}),
    ...(input.event === 'PostCompact' ? { savedThisCycle: false } : {})
  };

  // PreCompact is the only point at which a context-critical save request is
  // meaningful. Keep it one-shot for this compaction cycle; PostCompact above
  // explicitly re-arms the next cycle. The native boundary still cannot turn
  // this request into a verified save, which is reported by the adapter.
  if (input.event === 'PreCompact' && facts.context?.level === 'critical' && base.savedThisCycle) {
    return {
      inject: false,
      level: 'critical',
      meter: 'context',
      reason: 'context-critical save was already requested in this compaction cycle',
      nextState
    };
  }

  if (SILENT_EVENTS.has(input.event)) {
    return { inject: false, level: null, meter: null, reason: `${input.event} cannot carry injected context`, nextState };
  }

  if (input.continuationActive === true) {
    return { inject: false, level: null, meter: null, reason: 'a continuation is already active', nextState };
  }

  // Pick the most severe readable meter. A null level means unreadable, which
  // is never a reason to speak and never a reason to act.
  const candidates: Array<[MeterName, Level | null]> = [
    ['context', facts.context?.level ?? null],
    ['five_hour', facts.fiveHour?.level ?? null],
    ['weekly', facts.weekly?.level ?? null]
  ];
  let meter: MeterName | null = null;
  let level: Level | null = null;
  for (const [name, candidate] of candidates) {
    if (candidate === null || candidate === 'none') continue;
    if (rank(candidate) > rank(level)) {
      meter = name;
      level = candidate;
    }
  }

  if (meter === null || level === null) {
    return { inject: false, level: null, meter: null, reason: 'no meter is at a reportable level', nextState };
  }

  const previous = base.levels[meter] ?? 'none';
  const escalated = rank(level) > rank(previous);
  const lastAtMs = base.lastInjectedAtMs[meter];
  const debounceElapsed =
    lastAtMs === undefined || nowMs - lastAtMs >= config.debounce_seconds * 1000;

  if (rank(level) < rank(previous)) {
    return {
      inject: false,
      level,
      meter,
      reason: `${meter} fell from ${previous} to ${level}`,
      nextState: { ...nextState, levels: { ...nextState.levels, [meter]: level } }
    };
  }

  // Escalation is urgent enough to bypass the debounce window; an unchanged
  // level re-emits only once that window has elapsed.
  if (!escalated && !debounceElapsed) {
    return { inject: false, level, meter, reason: `${meter} is unchanged within the debounce window`, nextState };
  }

  return {
    inject: true,
    level,
    meter,
    reason: escalated ? `${meter} escalated to ${level}` : `${meter} re-emitted at ${level}`,
    nextState: {
      ...nextState,
      levels: { ...nextState.levels, [meter]: level },
      lastInjectedAtMs: { ...nextState.lastInjectedAtMs, [meter]: nowMs },
      ...(input.event === 'PreCompact' && facts.context?.level === 'critical' ? { savedThisCycle: true } : {})
    }
  };
}
