import { describe, expect, test } from 'bun:test';
import { awayDirective, onboardingDirective } from '../channels';
import { DEFAULT_CONFIG, type Config } from '../config';

function cfgWith(channels: Partial<Config['channels']>): Config {
    return { ...DEFAULT_CONFIG, channels: { ...DEFAULT_CONFIG.channels, ...channels } };
}

describe('onboardingDirective', () => {
    test('asks when nothing is configured', () => {
        const d = onboardingDirective(DEFAULT_CONFIG);
        expect(d).not.toBeNull();
        expect(d).toContain('No away-channel is configured');
    });

    test('stops once the user has answered, even if they declined', () => {
        // `asked` is the gate, not the presence of a preference — otherwise
        // declining would re-prompt every session forever.
        expect(onboardingDirective(cfgWith({ asked: true }))).toBeNull();
    });

    test('stops when a preference already exists', () => {
        expect(onboardingDirective(cfgWith({ preferred: ['somechannel'] }))).toBeNull();
    });

    test('names no specific channel — the plugin cannot know which exist', () => {
        const d = onboardingDirective(DEFAULT_CONFIG) ?? '';
        for (const name of ['signal', 'telegram', 'slack', 'discord']) {
            expect(d.toLowerCase()).not.toContain(name);
        }
    });
});

describe('awayDirective', () => {
    const configured = cfgWith({ preferred: ['chan-a'], target: 'dest-1', asked: true });

    test('emits an instruction naming the configured channel and target', () => {
        const d = awayDirective(configured, [{ reason: 'five_hour is at warn (86%)' }]) ?? '';
        expect(d).toContain('chan-a');
        expect(d).toContain('dest-1');
        expect(d).toContain('five_hour is at warn (86%)');
    });

    test('is silent when no channel is configured', () => {
        // Nothing to send through; injecting would be noise the user cannot act on.
        expect(awayDirective(DEFAULT_CONFIG, [{ reason: 'anything' }])).toBeNull();
    });

    test('is silent when there is nothing to report', () => {
        expect(awayDirective(configured, [])).toBeNull();
    });

    test('batches multiple notices into one message', () => {
        const d = awayDirective(configured, [
            { reason: 'five_hour is at critical (96%)' },
            { reason: 'weekly is at warn (72%)' }
        ]) ?? '';
        expect(d).toContain('five_hour is at critical (96%)');
        expect(d).toContain('weekly is at warn (72%)');
        expect(d).toContain('ONE message');
    });

    test('lists every preferred channel so Claude can fall back', () => {
        const d = awayDirective(cfgWith({ preferred: ['chan-a', 'chan-b'] }), [{ reason: 'x' }]) ?? '';
        expect(d).toContain('chan-a or chan-b');
    });

    test('omits the target clause when none is set', () => {
        const d = awayDirective(cfgWith({ preferred: ['chan-a'] }), [{ reason: 'x' }]) ?? '';
        expect(d).not.toContain('target:');
    });
});
