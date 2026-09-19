import { describe, expect, test } from 'bun:test';
import { emitBlock, parseHookStdin } from '../hook-io';

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

describe('parseHookStdin', () => {
    test('empty and malformed input parse to {}', () => {
        expect(parseHookStdin('')).toEqual({});
        expect(parseHookStdin('   ')).toEqual({});
        expect(parseHookStdin('{not json')).toEqual({});
    });

    test('carries session_crons through untyped, so a malformed entry cannot sink the whole tick', () => {
        const parsed = parseHookStdin(JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 's1',
            session_crons: [
                { id: 'cron-1', schedule: '13,43 * * * *', recurring: true, prompt: '[pacekeeper-keepalive] Keep the prompt cache warm.' },
                { bogus: true }
            ]
        }));
        expect(parsed.hook_event_name).toBe('Stop');
        expect(parsed.session_id).toBe('s1');
        expect(Array.isArray(parsed.session_crons)).toBe(true);
        expect(parsed.session_crons).toHaveLength(2);
    });
});
