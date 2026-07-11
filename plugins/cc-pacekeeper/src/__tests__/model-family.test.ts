import { describe, expect, test } from 'bun:test';
import { modelFamily } from '../model-family';

describe('modelFamily', () => {
    test.each([
        ['claude-opus-4-8', 'opus'],
        ['claude-sonnet-5', 'sonnet'],
        ['claude-3-5-sonnet-20241022', 'sonnet'],
        ['claude-haiku-4-5-20251001', 'haiku'],
        ['claude-fable-5', 'fable'],
        ['claude-mythos-5', 'mythos'],
        ['us.anthropic.claude-opus-4-8-v1:0', 'opus'],
        ['claude-sonnet-4-5[1m]', 'sonnet']
    ] as const)('%s → %s', (id, fam) => {
        expect(modelFamily(id)).toBe(fam);
    });

    test('unknown and absent ids → null', () => {
        expect(modelFamily('gpt-4o')).toBeNull();
        expect(modelFamily(undefined)).toBeNull();
        expect(modelFamily('')).toBeNull();
    });
});
