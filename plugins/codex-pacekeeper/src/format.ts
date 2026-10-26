/**
 * Model-facing text. Ported from the Claude package's thresholds.ts and
 * timeline.ts so a Codex session sees the same status line, directives and
 * orientation wording; only the command names and the Codex-specific
 * mechanics (the save CLI registers the reset wake itself) differ.
 */
import type { CodexConfig } from './config';
import type { CodexFacts, Level, WindowFact } from './facts';
import { checkpointCliPath, RESUME_MARKER } from './agent-budget';

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

export function formatResetCountdown(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs === null) return '';
  const deltaSec = Math.max(0, Math.floor((resetsAtMs - nowMs) / 1000));
  const h = Math.floor(deltaSec / 3600);
  const m = Math.floor((deltaSec % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d${h % 24}h`;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  return `${m}m`;
}

/** `Fri 2026-07-04 18:42 IST · session 2h13m[ · idle 47m]`. */
export function formatTimeSegment(nowMs: number, sessionStartedAtMs: number, lastEventAtMs: number, config: CodexConfig): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short'
  }).formatToParts(new Date(nowMs));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const wall = `${pick('weekday')} ${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')} ${pick('timeZoneName')}`;
  const segments = [wall, `session ${formatDuration(nowMs - sessionStartedAtMs)}`];
  const idleMs = nowMs - lastEventAtMs;
  if (idleMs >= config.time.idle_threshold_min * 60000) segments.push(`idle ${formatDuration(idleMs)}`);
  return segments.join(' · ');
}

export function detectAfkReturn(gapMs: number, config: CodexConfig): string | null {
  if (gapMs < config.time.idle_threshold_min * 60000) return null;
  return `⏱ You were away ${formatDuration(gapMs)} — welcome back.`;
}

function windowSegment(label: string, window: WindowFact | null, nowMs: number): string | null {
  if (window === null) return null;
  if (window.usedPercent === null) return `${label} ?`;
  if (window.rolledOver) return `${label} rolled over (was ${window.usedPercent}%, awaiting fresh data)`;
  const reset = formatResetCountdown(window.resetsAtMs, nowMs);
  return reset ? `${label} ${window.usedPercent}% (${reset})` : `${label} ${window.usedPercent}%`;
}

/** `ctx 62% · 5h 71% (1h20m) · week 43%`, omitting meters that were never read. */
export function formatMeterSegment(facts: CodexFacts, nowMs: number): string {
  const parts: string[] = [];
  if (facts.context !== null) parts.push(facts.context.usedPercent === null ? 'ctx ?' : `ctx ${facts.context.usedPercent}%`);
  const five = windowSegment('5h', facts.fiveHour, nowMs);
  if (five !== null) parts.push(five);
  const weekly = windowSegment('week', facts.weekly, nowMs);
  if (weekly !== null) parts.push(weekly);
  if (facts.capacity === 'paid') parts.push('using credits');
  return parts.join(' · ');
}

export function formatStatusLine(facts: CodexFacts, nowMs: number): string {
  const meters = formatMeterSegment(facts, nowMs);
  return meters ? `[pacekeeper] ${meters}` : '[pacekeeper] meters unavailable';
}

const METER_HUMAN = { context: 'context window', five_hour: '5-hour session block', weekly: 'weekly limit' } as const;
export type ReminderMeter = keyof typeof METER_HUMAN;

export interface MeterReading {
  meter: ReminderMeter;
  percent: number;
  level: Level;
  resetsAtMs: number | null;
}

/** Decision-grade readings: rolled-over windows and unknown percentages are display-only. */
export function readings(facts: CodexFacts): MeterReading[] {
  const out: MeterReading[] = [];
  if (facts.context?.usedPercent !== null && facts.context?.usedPercent !== undefined && facts.context.level !== null) {
    out.push({ meter: 'context', percent: facts.context.usedPercent, level: facts.context.level, resetsAtMs: null });
  }
  for (const [meter, window] of [['five_hour', facts.fiveHour], ['weekly', facts.weekly]] as const) {
    if (window === null || window.usedPercent === null || window.level === null || window.rolledOver) continue;
    out.push({ meter, percent: window.usedPercent, level: window.level, resetsAtMs: window.resetsAtMs });
  }
  return out;
}

const RANK: Record<Level, number> = { none: 0, notify: 1, warn: 2, critical: 3 };
export function levelGt(a: Level, b: Level): boolean { return RANK[a] > RANK[b]; }

export function driver(facts: CodexFacts): MeterReading | null {
  let best: MeterReading | null = null;
  for (const reading of readings(facts)) {
    if (best === null || RANK[reading.level] > RANK[best.level]) best = reading;
  }
  return best === null || best.level === 'none' ? null : best;
}

export function formatDirective(facts: CodexFacts, nowMs: number): string {
  const status = formatStatusLine(facts, nowMs);
  const top = driver(facts);
  if (top === null) return '';
  if (top.level === 'notify') return status;
  const name = METER_HUMAN[top.meter];
  if (top.level === 'warn') {
    return [
      status,
      '',
      `⚠ Approaching ${name} (${top.percent}%). Finish the current step cleanly, then ask the user whether to save a checkpoint via \`${checkpointCliPath()} save\` before continuing.`
    ].join('\n');
  }
  const reset = formatResetCountdown(top.resetsAtMs, nowMs);
  const credits = facts.capacity === 'paid'
    ? ' This account is already drawing on credits.'
    : '';
  return [
    status,
    '',
    `🛑 At critical threshold on ${name} (${top.percent}%).${reset ? ` ${name} resets in ${reset}.` : ''}${credits}`,
    'Stop, summarize the in-flight work, and ask the user whether to:',
    '  (a) continue on credits if the account has them,',
    `  (b) save a checkpoint via \`${checkpointCliPath()} save\` and resume after reset,`,
    '  (c) keep going if confident the next step is small.'
  ].join('\n');
}

/** When the 5h block is warn+ but resets within the bridge window, wait it out. */
export function formatBridgeDirective(facts: CodexFacts, maxWaitMin: number, nowMs: number): string | null {
  const five = facts.fiveHour;
  if (five === null || five.rolledOver || five.usedPercent === null || five.resetsAtMs === null) return null;
  if (five.level !== 'warn' && five.level !== 'critical') return null;
  const mins = (five.resetsAtMs - nowMs) / 60000;
  if (mins >= maxWaitMin || mins < 0) return null;
  return [
    formatStatusLine(facts, nowMs),
    '',
    `⏳ 5-hour block at ${five.usedPercent}%, but it resets in ~${Math.ceil(mins)}m — close enough to wait out rather than checkpoint.`,
    'Keep working on small steps; if the block runs out first, pacekeeper wakes this thread after the reset when a checkpoint is pending.'
  ].join('\n');
}

export function formatCtxAutoSaveDirective(facts: CodexFacts, nowMs: number, threadId: string, mainThread: boolean): string {
  const tail = mainThread
    ? ', then continue on small steps until compaction runs. Do not start a new session for this: when Codex compacts, pacekeeper re-injects this checkpoint.'
    : ', then continue on small steps until compaction runs.';
  return [
    formatStatusLine(facts, nowMs),
    '',
    `🛑 Context window at critical — save now, do not ask: run \`${checkpointCliPath()} save --thread-id ${threadId}\` immediately${tail}`
  ].join('\n');
}

export function formatAutoLoopDirective(facts: CodexFacts, config: CodexConfig, nowMs: number, threadId: string): string {
  const five = facts.fiveHour;
  const wakeAt = five?.resetsAtMs === null || five?.resetsAtMs === undefined
    ? null
    : new Date(five.resetsAtMs + config.auto.wake_delay_min * 60_000).toISOString();
  const ctxAlsoCritical = facts.context?.level === 'critical';
  return [
    formatStatusLine(facts, nowMs),
    '',
    'This overrides any keepalive single-word instruction — perform these steps now, then reply briefly.',
    `🔁 5-hour block auto-renewal (≥ ${config.auto.five_hour_pct}%${ctxAlsoCritical ? '; context also critical — one save covers both' : ''}):`,
    `  1. Save to the current lane NOW via \`${checkpointCliPath()} save --thread-id ${threadId}\` — do not ask the user first.`,
    `  2. The save registers a one-shot wake${wakeAt ? ` for ${wakeAt} (reset + ${config.auto.wake_delay_min}m)` : ' just after the reset'}; it arrives as a prompt starting with ${RESUME_MARKER}. Check the CLI printed "Registered reset wake"; if it printed "Reset wake withheld", tell the user the work will need a manual resume.`,
    '  3. Continue only on small steps until renewal; defer heavy work or new subagent dispatches until the wake prompt arrives.'
  ].join('\n');
}

export function formatSubagentTickLine(facts: CodexFacts, pausePct: number, nowMs: number): string {
  const five = facts.fiveHour;
  const pct = five?.usedPercent === null || five?.usedPercent === undefined || five.rolledOver ? '?' : `${five.usedPercent}`;
  const reset = five ? formatResetCountdown(five.resetsAtMs, nowMs) : '';
  return `[pacekeeper] 5h ${pct}%${reset ? ` (${reset})` : ''} · pause at ${pausePct.toFixed(0)}%`;
}

export function formatDispatchAdvisory(facts: CodexFacts): string | null {
  const five = facts.fiveHour;
  if (five === null || five.rolledOver || five.usedPercent === null) return null;
  if (five.level !== 'warn' && five.level !== 'critical') return null;
  return `[pacekeeper] Note: 5-hour block already at ${five.usedPercent}% — the dispatched agent tree will inherit this budget and may need to pause partway; it carries its own budget contract.`;
}
