import type { Config, ThresholdLevels } from './config';
import type { Level, Meter } from './state';
import type { UsageData } from './vendor/usage-types';
import { modelFamily } from './model-family';

export interface MeterReading {
    meter: Meter;
    percent: number;          // 0-100
    level: Level;
    resetsAt?: string;        // ISO datetime for windowed meters
    /** The cached reset time is in the past — the block rolled over but no
     * fresh data has landed. percent is the LAST-KNOWN value from the ended
     * block, not current usage: display-only, never feed it into decisions. */
    stale?: boolean;
}

export interface Snapshot {
    readings: MeterReading[];
    /** Highest level across all meters. */
    maxLevel: Level;
    /** Reading at maxLevel, used to compose the directive line. */
    driver?: MeterReading;
    /** Extra-usage state, if known. Surfaced at warn+. */
    extraUsage?: {
        enabled?: boolean;
        utilizationPercent?: number;
        usedCredits?: number;
        monthlyLimit?: number;
        currency?: string;
    };
}

const LEVEL_RANK: Record<Level, number> = { none: 0, notify: 1, warn: 2, critical: 3 };

function isResetInPast(iso: string | undefined, now: number = Date.now()): boolean {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t <= now;
}

function levelFor(percent: number, t: ThresholdLevels): Level {
    if (percent >= t.critical) return 'critical';
    if (percent >= t.warn) return 'warn';
    if (percent >= t.notify) return 'notify';
    return 'none';
}

export interface ComputeInputs {
    contextPercent: number | null;
    usage: UsageData | null;
}

export function computeSnapshot(inputs: ComputeInputs, cfg: Config, now: number = Date.now()): Snapshot {
    const readings: MeterReading[] = [];

    if (inputs.contextPercent !== null) {
        readings.push({
            meter: 'context',
            percent: inputs.contextPercent,
            level: levelFor(inputs.contextPercent, cfg.thresholds.context)
        });
    }

    const u = inputs.usage;
    if (u && !u.error) {
        if (u.sessionUsage !== undefined && !isResetInPast(u.sessionResetAt, now)) {
            readings.push({
                meter: 'five_hour',
                percent: u.sessionUsage,
                level: levelFor(u.sessionUsage, cfg.thresholds.five_hour),
                resetsAt: u.sessionResetAt
            });
        } else if (u.sessionUsage !== undefined) {
            // Post-rollover, cache not yet refreshed: keep the field visible
            // as last-known instead of dropping it for however long the fetch
            // lags (observed: ~an hour). level none so it drives no decisions.
            readings.push({
                meter: 'five_hour',
                percent: u.sessionUsage,
                level: 'none',
                stale: true
            });
        }
        if (u.weeklyUsage !== undefined && !isResetInPast(u.weeklyResetAt, now)) {
            readings.push({
                meter: 'weekly',
                percent: u.weeklyUsage,
                level: levelFor(u.weeklyUsage, cfg.thresholds.weekly),
                resetsAt: u.weeklyResetAt
            });
        }
        if (u.weeklySonnetUsage !== undefined && !isResetInPast(u.weeklySonnetResetAt, now)) {
            readings.push({
                meter: 'weekly_sonnet',
                percent: u.weeklySonnetUsage,
                level: levelFor(u.weeklySonnetUsage, cfg.thresholds.weekly),
                resetsAt: u.weeklySonnetResetAt
            });
        }
        if (u.weeklyOpusUsage !== undefined && !isResetInPast(u.weeklyOpusResetAt, now)) {
            readings.push({
                meter: 'weekly_opus',
                percent: u.weeklyOpusUsage,
                level: levelFor(u.weeklyOpusUsage, cfg.thresholds.weekly),
                resetsAt: u.weeklyOpusResetAt
            });
        }
    }

    let maxLevel: Level = 'none';
    let driver: MeterReading | undefined;
    for (const r of readings) {
        if (LEVEL_RANK[r.level] > LEVEL_RANK[maxLevel]) {
            maxLevel = r.level;
            driver = r;
        }
    }

    const snap: Snapshot = { readings, maxLevel, driver };
    if (u && u.extraUsageEnabled !== undefined) {
        snap.extraUsage = {
            enabled: u.extraUsageEnabled,
            utilizationPercent: u.extraUsageUtilization,
            usedCredits: u.extraUsageUsed,
            monthlyLimit: u.extraUsageLimit,
            currency: u.extraUsageCurrency
        };
    }
    return snap;
}

const METER_LABELS: Record<Meter, string> = {
    context: 'ctx',
    five_hour: '5h',
    weekly: 'week',
    weekly_sonnet: 'week-sonnet',
    weekly_opus: 'week-opus'
};

function formatResetCountdown(resetsAt: string | undefined, now: Date = new Date()): string {
    if (!resetsAt) return '';
    const t = Date.parse(resetsAt);
    if (Number.isNaN(t)) return '';
    const deltaSec = Math.max(0, Math.floor((t - now.getTime()) / 1000));
    const h = Math.floor(deltaSec / 3600);
    const m = Math.floor((deltaSec % 3600) / 60);
    if (h > 24) return `${Math.floor(h / 24)}d${h % 24}h`;
    if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
    return `${m}m`;
}

function formatExtra(extra: Snapshot['extraUsage']): string {
    if (!extra || extra.enabled !== true) return '';
    const pct = extra.utilizationPercent;
    const cur = (extra.currency ?? 'USD').toUpperCase();
    if (extra.usedCredits !== undefined && extra.monthlyLimit !== undefined) {
        const used = (extra.usedCredits / 100).toFixed(2);
        const limit = (extra.monthlyLimit / 100).toFixed(2);
        const pctStr = pct !== undefined ? ` (${pct.toFixed(0)}%)` : '';
        return ` · extra ${cur} ${used}/${limit}${pctStr}`;
    }
    if (pct !== undefined) return ` · extra ${pct.toFixed(0)}%`;
    return '';
}

/**
 * The meter body without the `[pacekeeper]` prefix, e.g.
 * `ctx 62% · 5h 71% (1h20m) · week 43%` — composable into a combined line.
 */
export function formatMeterSegment(snap: Snapshot): string {
    const parts = snap.readings
        .filter(r => r.meter === 'context' || r.meter === 'five_hour' || r.meter === 'weekly')
        .map(r => {
            const label = METER_LABELS[r.meter];
            if (r.stale) return `${label} rolled over (was ${r.percent.toFixed(0)}%, awaiting fresh data)`;
            const reset = formatResetCountdown(r.resetsAt);
            return reset ? `${label} ${r.percent.toFixed(0)}% (${reset})` : `${label} ${r.percent.toFixed(0)}%`;
        });
    return `${parts.join(' · ')}${formatExtra(snap.extraUsage)}`;
}

export function formatStatusLine(snap: Snapshot): string {
    return `[pacekeeper] ${formatMeterSegment(snap)}`;
}

const METER_HUMAN: Record<Meter, string> = {
    context: 'context window',
    five_hour: '5-hour session block',
    weekly: 'weekly limit',
    weekly_sonnet: 'weekly Sonnet limit',
    weekly_opus: 'weekly Opus limit'
};

/**
 * Minutes until a windowed meter resets, or null if unknown.
 */
export function minutesUntilReset(resetsAt: string | undefined, now: number = Date.now()): number | null {
    if (!resetsAt) return null;
    const t = Date.parse(resetsAt);
    if (!Number.isFinite(t)) return null;
    return (t - now) / 60000;
}

/**
 * The 5h block-reset bridge. When the 5-hour block is warn/critical and its
 * reset is near (< maxWaitMin), suppress the checkpoint directive — waiting out
 * a short reset beats a full checkpoint/resume cycle. Returns the bridge text,
 * or null when the bridge doesn't apply (caller falls back to formatDirective).
 */
export function formatBridgeDirective(snap: Snapshot, maxWaitMin: number, now: number = Date.now()): string | null {
    const five = snap.readings.find(r => r.meter === 'five_hour');
    if (!five || (five.level !== 'warn' && five.level !== 'critical')) return null;
    const mins = minutesUntilReset(five.resetsAt, now);
    if (mins === null || mins >= maxWaitMin || mins < 0) return null;
    const status = formatStatusLine(snap);
    const m = Math.ceil(mins);
    return [
        status,
        '',
        `⏳ 5-hour block at ${five.percent.toFixed(0)}%, but it resets in ~${m}m — close enough to wait out rather than checkpoint.`,
        `Keep working on small steps. If you expect to go idle before the reset, schedule a ${KEEPALIVE_MARKER_HINT} one-shot for reset+2m as a safety net to reset the block cleanly.`
    ].join('\n');
}

// Kept as a string constant here to avoid a circular import with keepalive.ts.
const KEEPALIVE_MARKER_HINT = '[pacekeeper-keepalive]';

/**
 * Weekly model-family arbitrage nudge. When the *current* model family's weekly
 * meter is stressed (≥ warn) but the all-models weekly is still fine (< warn)
 * and the other family has headroom (< notify), suggest switching families.
 * `modelId` picks the current family. Returns null when it doesn't apply.
 */
export function formatArbitrageNudge(snap: Snapshot, modelId: string | undefined): string | null {
    // Only opus/sonnet have their own weekly bucket to arbitrage against —
    // haiku/fable/mythos ids now resolve to a family (instead of accidentally
    // matching nothing) but correctly get no nudge.
    const family = modelFamily(modelId);
    if (family !== 'opus' && family !== 'sonnet') return null;

    const all = snap.readings.find(r => r.meter === 'weekly');
    const cur = snap.readings.find(r => r.meter === (family === 'opus' ? 'weekly_opus' : 'weekly_sonnet'));
    const other = snap.readings.find(r => r.meter === (family === 'opus' ? 'weekly_sonnet' : 'weekly_opus'));
    if (!all || !cur || !other) return null;

    const RANK: Record<Level, number> = { none: 0, notify: 1, warn: 2, critical: 3 };
    if (RANK[cur.level] < RANK['warn']) return null;   // current family not stressed
    if (RANK[all.level] >= RANK['warn']) return null;  // overall weekly also tight → switching won't help
    if (RANK[other.level] >= RANK['notify']) return null; // other family has no headroom

    const otherName = family === 'opus' ? 'Sonnet' : 'Opus';
    const curName = family === 'opus' ? 'Opus' : 'Sonnet';
    return `↔ Weekly ${curName} is at ${cur.percent.toFixed(0)}% while ${otherName} sits at ${other.percent.toFixed(0)}%. `
        + `If the next work suits ${otherName}, switching models spreads the load. `
        + `(Switching re-reads the context uncached once, a one-time token cost.)`;
}

export function formatDirective(snap: Snapshot): string {
    const status = formatStatusLine(snap);
    if (snap.maxLevel === 'none' || !snap.driver) return '';
    if (snap.maxLevel === 'notify') return status;

    const driver = snap.driver;
    const driverName = METER_HUMAN[driver.meter];
    const reset = formatResetCountdown(driver.resetsAt);

    if (snap.maxLevel === 'warn') {
        return [
            status,
            '',
            `⚠ Approaching ${driverName} (${driver.percent.toFixed(0)}%). Finish the current step cleanly, then ask the user whether to save a checkpoint via /cc-pacekeeper:checkpoint save before continuing.`
        ].join('\n');
    }

    // critical
    const extra = snap.extraUsage;
    const extraNote = extra?.enabled
        ? ` Extra-usage credits: ${extra.utilizationPercent?.toFixed(0) ?? '?'}% used`
            + (extra.usedCredits !== undefined && extra.monthlyLimit !== undefined
                ? ` (${(extra.currency ?? 'USD').toUpperCase()} ${(extra.usedCredits / 100).toFixed(2)}/${(extra.monthlyLimit / 100).toFixed(2)})`
                : '')
            + '.'
        : ' Extra-usage credits not enabled on this account.';
    const resetLine = reset ? ` ${driverName} resets in ${reset}.` : '';

    return [
        status,
        '',
        `🛑 At critical threshold on ${driverName} (${driver.percent.toFixed(0)}%).${resetLine}${extraNote}`,
        'Stop, summarize the in-flight work, and ask the user whether to:',
        '  (a) continue with extra-usage credits,',
        '  (b) save a checkpoint via /cc-pacekeeper:checkpoint save and resume after reset,',
        '  (c) keep going if confident the next step is small.'
    ].join('\n');
}
