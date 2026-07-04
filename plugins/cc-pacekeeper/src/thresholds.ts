import type { Config, ThresholdLevels } from './config';
import type { Level, Meter } from './state';
import type { UsageData } from './vendor/usage-types';

export interface MeterReading {
    meter: Meter;
    percent: number;          // 0-100
    level: Level;
    resetsAt?: string;        // ISO datetime for windowed meters
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

export function computeSnapshot(inputs: ComputeInputs, cfg: Config): Snapshot {
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
        if (u.sessionUsage !== undefined && !isResetInPast(u.sessionResetAt)) {
            readings.push({
                meter: 'five_hour',
                percent: u.sessionUsage,
                level: levelFor(u.sessionUsage, cfg.thresholds.five_hour),
                resetsAt: u.sessionResetAt
            });
        }
        if (u.weeklyUsage !== undefined && !isResetInPast(u.weeklyResetAt)) {
            readings.push({
                meter: 'weekly',
                percent: u.weeklyUsage,
                level: levelFor(u.weeklyUsage, cfg.thresholds.weekly),
                resetsAt: u.weeklyResetAt
            });
        }
        if (u.weeklySonnetUsage !== undefined && !isResetInPast(u.weeklySonnetResetAt)) {
            readings.push({
                meter: 'weekly_sonnet',
                percent: u.weeklySonnetUsage,
                level: levelFor(u.weeklySonnetUsage, cfg.thresholds.weekly),
                resetsAt: u.weeklySonnetResetAt
            });
        }
        if (u.weeklyOpusUsage !== undefined && !isResetInPast(u.weeklyOpusResetAt)) {
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
