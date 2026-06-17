import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { contextPercent, readContextTokens } from '../ctx-tokens';

let TRANSCRIPT: string;

beforeEach(() => {
    TRANSCRIPT = path.join(os.tmpdir(), `cc-pacekeeper-ctx-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
});

afterEach(() => {
    try { fs.unlinkSync(TRANSCRIPT); } catch { /* ignore */ }
});

describe('readContextTokens', () => {
    test('returns null when file missing', () => {
        expect(readContextTokens('/nonexistent/file.jsonl')).toBeNull();
    });

    test('returns null when no usage records', () => {
        fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
        expect(readContextTokens(TRANSCRIPT)).toBeNull();
    });

    test('picks up the most recent assistant.message.usage', () => {
        const lines = [
            { type: 'user', message: { content: 'q' } },
            { type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 } } },
            { type: 'user', message: { content: 'q2' } },
            { type: 'assistant', message: { usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 100 } } }
        ];
        fs.writeFileSync(TRANSCRIPT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        const tokens = readContextTokens(TRANSCRIPT)!;
        // Most recent: input 200 + creation 10 + read 100 = 310 context
        expect(tokens.contextLength).toBe(310);
        expect(tokens.inputTotal).toBe(200);
        expect(tokens.outputTotal).toBe(30);
        expect(tokens.cached).toBe(110);
    });

    test('handles missing optional fields gracefully', () => {
        fs.writeFileSync(TRANSCRIPT, JSON.stringify({
            type: 'assistant',
            message: { usage: { input_tokens: 42 } }
        }) + '\n');
        const tokens = readContextTokens(TRANSCRIPT)!;
        expect(tokens.inputTotal).toBe(42);
        expect(tokens.cached).toBe(0);
        expect(tokens.contextLength).toBe(42);
    });

    test('skips malformed JSON lines', () => {
        const content = [
            'not json at all',
            JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 99 } } })
        ].join('\n') + '\n';
        fs.writeFileSync(TRANSCRIPT, content);
        const tokens = readContextTokens(TRANSCRIPT)!;
        expect(tokens.inputTotal).toBe(99);
    });
});

describe('contextPercent', () => {
    test('clamps at 100', () => {
        expect(contextPercent(300_000, 200_000)).toBe(100);
    });
    test('clamps at 0', () => {
        expect(contextPercent(-5, 200_000)).toBe(0);
    });
    test('computes correctly', () => {
        expect(contextPercent(50_000, 200_000)).toBe(25);
    });
    test('handles zero window size', () => {
        expect(contextPercent(50_000, 0)).toBe(0);
    });
});
