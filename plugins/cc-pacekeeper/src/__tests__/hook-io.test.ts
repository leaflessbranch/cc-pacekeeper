import { describe, expect, test } from 'bun:test';
import { emitBlock } from '../hook-io';

describe('emitBlock', () => {
    test('writes a block decision with the given reason', () => {
        const chunks: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        (process.stdout.write as unknown) = (chunk: string) => { chunks.push(chunk); return true; };
        try {
            emitBlock('[pacekeeper] keepalive ping suppressed — user active');
        } finally {
            process.stdout.write = original;
        }
        const out = JSON.parse(chunks.join(''));
        expect(out).toEqual({
            decision: 'block',
            reason: '[pacekeeper] keepalive ping suppressed — user active'
        });
    });
});
