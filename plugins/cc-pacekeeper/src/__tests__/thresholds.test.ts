import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../config';
import { computeSnapshot, formatDirective, formatStatusLine } from '../thresholds';

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
