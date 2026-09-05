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

  // A new block invalidates the levels recorded against the previous one, so
  // the first reminder of the new block is not suppressed by the old one.
  const resetAtMs = facts.fiveHour?.resetsAtMs ?? null;
  const blockChanged = resetAtMs !== null && state.blockResetAtMs !== null && resetAtMs !== state.blockResetAtMs;
  const base: PolicyState = blockChanged
    ? { levels: {}, lastInjectedAtMs: {}, blockResetAtMs: resetAtMs, savedThisCycle: false, ...(state.lastUserActivityAtMs !== undefined ? { lastUserActivityAtMs: state.lastUserActivityAtMs } : {}) }
    : { ...state, levels: { ...state.levels }, lastInjectedAtMs: { ...state.lastInjectedAtMs }, blockResetAtMs: resetAtMs ?? state.blockResetAtMs };

  // A synthetic turn is our own keepalive. It must produce no pacing output
  // and must not look like the user being present.
  if (input.synthetic === true) {
    return { inject: false, level: null, meter: null, reason: 'synthetic turn: policy output suppressed', nextState: base };
  }

  const isUserActivity = input.event === 'UserPromptSubmit' || input.event === 'PreToolUse';
  const nextState: PolicyState = isUserActivity ? { ...base, lastUserActivityAtMs: nowMs } : base;

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
      lastInjectedAtMs: { ...nextState.lastInjectedAtMs, [meter]: nowMs }
    }
  };
}
