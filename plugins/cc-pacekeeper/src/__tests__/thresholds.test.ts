import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../config';
import { computeSnapshot, formatArbitrageNudge, formatBridgeDirective, formatDirective, formatStatusLine } from '../thresholds';
import { formatUsageErrorNote, usageErrorNoteToSurface } from '../thresholds';

describe('computeSnapshot', () => {
    test('all meters none when below thresholds', () => {
        const snap = computeSnapshot({
            contextPercent: 10,
            usage: { sessionUsage: 10, weeklyUsage: 10 }
        }, DEFAULT_CONFIG);
        expect(snap.maxLevel).toBe('none');
        expect(snap.driver).toBeUndefined();
        expect(snap.readings).toHaveLength(3);
    });

    test('picks highest level across meters', () => {
        const snap = computeSnapshot({
            contextPercent: 65,        // notify
            usage: { sessionUsage: 88, weeklyUsage: 30 }  // 5h warn, weekly none
        }, DEFAULT_CONFIG);
        expect(snap.maxLevel).toBe('warn');
        expect(snap.driver?.meter).toBe('five_hour');
    });

    test('critical wins over warn', () => {
        const snap = computeSnapshot({
            contextPercent: 78,        // warn
            usage: { sessionUsage: 96, weeklyUsage: 30 }  // 5h critical
        }, DEFAULT_CONFIG);
        expect(snap.maxLevel).toBe('critical');
        expect(snap.driver?.meter).toBe('five_hour');
    });

    test('includes extra usage when enabled', () => {
        const snap = computeSnapshot({
            contextPercent: 50,
            usage: {
                sessionUsage: 30,
                extraUsageEnabled: true,
                extraUsageUtilization: 12,
                extraUsageUsed: 1200,
                extraUsageLimit: 10000,
                extraUsageCurrency: 'USD'
            }
        }, DEFAULT_CONFIG);
        expect(snap.extraUsage?.enabled).toBe(true);
        expect(snap.extraUsage?.utilizationPercent).toBe(12);
    });

    test('skips meters when usage has error', () => {
        const snap = computeSnapshot({
            contextPercent: 50,
            usage: { error: 'rate-limited' }
        }, DEFAULT_CONFIG);
        // Only the context reading should be present.
        expect(snap.readings).toHaveLength(1);
        expect(snap.readings[0]?.meter).toBe('context');
    });

    test('null usage and null context: empty snapshot', () => {
        const snap = computeSnapshot({ contextPercent: null, usage: null }, DEFAULT_CONFIG);
        expect(snap.readings).toHaveLength(0);
        expect(snap.maxLevel).toBe('none');
    });

    test('keeps five_hour as a stale display-only reading when sessionResetAt is past', () => {
        const pastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const snap = computeSnapshot({
            contextPercent: 10,
            usage: {
                sessionUsage: 95,           // would be critical, but stale
                sessionResetAt: pastIso,
                weeklyUsage: 40,
                weeklyResetAt: futureIso
            }
        }, DEFAULT_CONFIG);
        // Rollover: kept as a stale, decision-inert reading instead of being
        // dropped (the field used to vanish from the line for ~an hour).
        const five = snap.readings.find(r => r.meter === 'five_hour');
        expect(five).toBeDefined();
        expect(five!.stale).toBe(true);
        expect(five!.level).toBe('none');
        expect(five!.resetsAt).toBeUndefined();
        expect(snap.readings.find(r => r.meter === 'weekly')).toBeDefined();
        expect(snap.maxLevel).toBe('none');
    });

    test('keeps five_hour reading when sessionResetAt is in the future', () => {
        const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const snap = computeSnapshot({
            contextPercent: null,
            usage: { sessionUsage: 88, sessionResetAt: futureIso }
        }, DEFAULT_CONFIG);
        expect(snap.readings.find(r => r.meter === 'five_hour')?.level).toBe('warn');
    });

    test('drops each weekly meter independently when its reset is past', () => {
        const past = new Date(Date.now() - 1000).toISOString();
        const future = new Date(Date.now() + 1000_000).toISOString();
        const snap = computeSnapshot({
            contextPercent: null,
            usage: {
                weeklyUsage: 90, weeklyResetAt: past,
                weeklySonnetUsage: 70, weeklySonnetResetAt: future,
                weeklyOpusUsage: 80, weeklyOpusResetAt: past
            }
        }, DEFAULT_CONFIG);
        expect(snap.readings.find(r => r.meter === 'weekly')).toBeUndefined();
        expect(snap.readings.find(r => r.meter === 'weekly_opus')).toBeUndefined();
        expect(snap.readings.find(r => r.meter === 'weekly_sonnet')).toBeDefined();
    });
});

describe('formatStatusLine', () => {
    test('includes pacekeeper prefix and meter percents', () => {
        const snap = computeSnapshot({
            contextPercent: 64,
            usage: { sessionUsage: 72, weeklyUsage: 41, sessionResetAt: undefined }
        }, DEFAULT_CONFIG);
        const line = formatStatusLine(snap);
        expect(line).toContain('[pacekeeper]');
        expect(line).toContain('ctx 64%');
        expect(line).toContain('5h 72%');
        expect(line).toContain('week 41%');
    });

    test('appends extra-usage suffix when enabled', () => {
        const snap = computeSnapshot({
            contextPercent: 50,
            usage: {
                sessionUsage: 60,
                extraUsageEnabled: true,
                extraUsageUtilization: 12,
                extraUsageUsed: 1200,
                extraUsageLimit: 10000,
                extraUsageCurrency: 'USD'
            }
        }, DEFAULT_CONFIG);
        const line = formatStatusLine(snap);
        expect(line).toMatch(/extra USD 12\.00\/100\.00 \(12%\)/);
    });
});

describe('formatDirective', () => {
    test('empty at none', () => {
        const snap = computeSnapshot({ contextPercent: 10, usage: null }, DEFAULT_CONFIG);
        expect(formatDirective(snap)).toBe('');
    });

    test('warn produces directive with checkpoint hint', () => {
        const snap = computeSnapshot({
            contextPercent: 80,
            usage: null
        }, DEFAULT_CONFIG);
        const out = formatDirective(snap);
        expect(out).toContain('Approaching');
        expect(out).toContain('/cc-pacekeeper:checkpoint save');
    });

    test('critical produces full directive with options', () => {
        const snap = computeSnapshot({
            contextPercent: 92,
            usage: null
        }, DEFAULT_CONFIG);
        const out = formatDirective(snap);
        expect(out).toContain('🛑');
        expect(out).toContain('(a) continue');
        expect(out).toContain('(b) save a checkpoint');
        expect(out).toContain('(c) keep going');
    });
});

describe('formatBridgeDirective', () => {
    const now = Date.parse('2026-07-04T10:00:00Z');
    const resetIn = (min: number): string => new Date(now + min * 60000).toISOString();

    test('null when 5h not warn/critical', () => {
        const snap = computeSnapshot({ contextPercent: 10, usage: { sessionUsage: 20, sessionResetAt: resetIn(30) } }, DEFAULT_CONFIG, now);
        expect(formatBridgeDirective(snap, 60, now)).toBeNull();
    });

    test('bridges when 5h warn and reset is near', () => {
        const snap = computeSnapshot({ contextPercent: 10, usage: { sessionUsage: 88, sessionResetAt: resetIn(20) } }, DEFAULT_CONFIG, now);
        const out = formatBridgeDirective(snap, 60, now);
        expect(out).toContain('resets in ~20m');
        expect(out).toContain('[pacekeeper-keepalive]');
    });

    test('null when reset is beyond max wait', () => {
        const snap = computeSnapshot({ contextPercent: 10, usage: { sessionUsage: 88, sessionResetAt: resetIn(90) } }, DEFAULT_CONFIG, now);
        expect(formatBridgeDirective(snap, 60, now)).toBeNull();
    });
});

describe('formatArbitrageNudge', () => {
    // opus family stressed, all-weekly fine, sonnet has headroom
    const nudgeable = computeSnapshot({
        contextPercent: 10,
        usage: { weeklyUsage: 30, weeklyOpusUsage: 75, weeklySonnetUsage: 20 }
    }, DEFAULT_CONFIG);

    test('nudges to switch family when current family stressed', () => {
        const out = formatArbitrageNudge(nudgeable, 'claude-opus-4-8');
        expect(out).toContain('Opus');
        expect(out).toContain('Sonnet');
    });

    test('null when overall weekly also tight', () => {
        const snap = computeSnapshot({ contextPercent: 10, usage: { weeklyUsage: 80, weeklyOpusUsage: 75, weeklySonnetUsage: 20 } }, DEFAULT_CONFIG);
        expect(formatArbitrageNudge(snap, 'claude-opus-4-8')).toBeNull();
    });

    test('null when other family has no headroom', () => {
        const snap = computeSnapshot({ contextPercent: 10, usage: { weeklyUsage: 30, weeklyOpusUsage: 75, weeklySonnetUsage: 60 } }, DEFAULT_CONFIG);
        expect(formatArbitrageNudge(snap, 'claude-opus-4-8')).toBeNull();
    });

    test('null for unknown model family', () => {
        expect(formatArbitrageNudge(nudgeable, 'some-other-model')).toBeNull();
    });
});

describe('usage error surfacing', () => {
    const cfg = DEFAULT_CONFIG; // thresholds.test.ts already imports/builds a config — reuse its pattern
    const emptySnap = computeSnapshot({ contextPercent: 10, usage: { error: 'no-credentials' } }, cfg);

    test('fires for no-credentials when no windowed meters present', () => {
        expect(usageErrorNoteToSurface({ error: 'no-credentials' }, emptySnap, undefined)).toBe('no-credentials');
    });

    test('suppressed once surfaced for the same error kind', () => {
        const entry = { sessionStartedAt: 0, lastEventAt: 0, usageErrorSurfaced: 'no-credentials' };
        expect(usageErrorNoteToSurface({ error: 'no-credentials' }, emptySnap, entry)).toBeNull();
    });

    test('suppressed when windowed meters exist (stale cache still shows numbers)', () => {
        const snap = computeSnapshot({ contextPercent: 10, usage: { sessionUsage: 40, sessionResetAt: new Date(Date.now() + 3600_000).toISOString() } }, cfg);
        expect(usageErrorNoteToSurface({ error: 'timeout', sessionUsage: 40 }, snap, undefined)).toBeNull();
    });

    test('note text names the failure and preserves the ctx meter promise', () => {
        const note = formatUsageErrorNote('no-credentials');
        expect(note).toContain('[pacekeeper]');
        expect(note).toContain('credentials');
        expect(note).toContain('context meter still works');
    });
});
