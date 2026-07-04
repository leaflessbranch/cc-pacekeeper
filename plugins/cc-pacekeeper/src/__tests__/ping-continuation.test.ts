import { describe, expect, test } from 'bun:test';
import { pingContinuation } from '../keepalive';
import { DEFAULT_CONFIG } from '../config';

/**
 * At ping-fire time, idle is measurable: now - lastEventAt is the true gap since
 * the last real event. pingContinuation decides whether the keepalive chain
 * should reschedule (user still idle) or die quietly (user active again).
 */
describe('pingContinuation', () => {
    test('reschedules when the idle gap is at/above threshold', () => {
        // interval_min=30 default → gate is ~24m (0.8 factor). 40m idle → continue.
        const out = pingContinuation(40 * 60_000, DEFAULT_CONFIG);
        expect(out.reschedule).toBe(true);
    });

    test('dies quietly when the gap is small (user active again)', () => {
        // 30s gap → user just did something → do not reschedule.
        const out = pingContinuation(30_000, DEFAULT_CONFIG);
        expect(out.reschedule).toBe(false);
    });
});
