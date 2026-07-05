import { describe, expect, test } from 'bun:test';
import { pingGate } from '../keepalive';
import { DEFAULT_CONFIG } from '../config';

/**
 * At ping-fire time, idle is measurable: now - lastEventAt is the true gap
 * since the last real event. pingGate decides whether the ping should be
 * blocked hook-side (user active — zero context cost) or passed through.
 */
describe('pingGate', () => {
    test('blocks when the idle gap is small (user active)', () => {
        // 30s gap → user just did something → suppress.
        expect(pingGate(30_000, DEFAULT_CONFIG)).toBe('block');
    });

    test('passes through when the idle gap is at/above threshold', () => {
        // interval_min=30 default → gate is ~24m (0.8 factor). 40m idle → passthrough.
        expect(pingGate(40 * 60_000, DEFAULT_CONFIG)).toBe('passthrough');
    });

    test('gate is capped at interval_min * 0.8 even with a large idle_threshold_min', () => {
        const cfg = {
            ...DEFAULT_CONFIG,
            time: { ...DEFAULT_CONFIG.time, idle_threshold_min: 120 },
            keepalive: { ...DEFAULT_CONFIG.keepalive, interval_min: 10 }
        };
        // Cap = 10 * 0.8 = 8min. A 9-minute gap should pass through despite the
        // 120-minute idle_threshold_min.
        expect(pingGate(9 * 60_000, cfg)).toBe('passthrough');
        expect(pingGate(7 * 60_000, cfg)).toBe('block');
    });
});
