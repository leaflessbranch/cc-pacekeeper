import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { contextPercent, readContextTokens, readMostRecentModel, resolveUsableContextWindow } from '../ctx-tokens';

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

describe('readContextTokens — model extraction', () => {
    test('returns the model id from the most recent assistant turn', () => {
        const lines = [
            { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 50 } } },
            { type: 'user', message: { content: 'q' } },
            { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 100 } } }
        ];
        fs.writeFileSync(TRANSCRIPT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        const tokens = readContextTokens(TRANSCRIPT)!;
        expect(tokens.model).toBe('claude-opus-4-7');
    });

    test('model is undefined when transcript records omit it', () => {
        fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } }) + '\n');
        const tokens = readContextTokens(TRANSCRIPT)!;
        expect(tokens.model).toBeUndefined();
    });
});

describe('readMostRecentModel', () => {
    test('returns null when no assistant turn', () => {
        fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', message: { content: 'q' } }) + '\n');
        expect(readMostRecentModel(TRANSCRIPT)).toBeNull();
    });

    test('returns the most recent model id, even without usage', () => {
        const lines = [
            { type: 'assistant', message: { model: 'claude-sonnet-4-6' } },
            { type: 'user', message: { content: 'q' } },
            { type: 'assistant', message: { model: 'claude-opus-4-7' } }
        ];
        fs.writeFileSync(TRANSCRIPT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        expect(readMostRecentModel(TRANSCRIPT)).toBe('claude-opus-4-7');
    });

    test('returns null when file missing', () => {
        expect(readMostRecentModel('/nonexistent/file.jsonl')).toBeNull();
    });
});

describe('resolveUsableContextWindow', () => {
    test('falls back to 80% of 200k (160k) when nothing is known', () => {
        expect(resolveUsableContextWindow(undefined, 200_000)).toBe(160_000);
    });

    test('parses a 1M window from a Claude 4-series id and returns 80% of 1M', () => {
        // ccstatusline parses sizes from the model string; "claude-opus-4-7" has
        // no size hint, so without an override it falls back to 200k. We hand
        // the override path the right value via configWindowSize when needed,
        // and otherwise rely on display-name hints like "[1M]".
        expect(resolveUsableContextWindow('claude-opus-4-7 [1M]', 200_000)).toBe(800_000);
    });

    test('honors a non-default config override', () => {
        // 300k override → usable = 240k
        expect(resolveUsableContextWindow(undefined, 300_000)).toBe(240_000);
    });

    test('ignores config override when it equals the historical default (200k)', () => {
        // Override 200k is treated as sentinel; model-parse takes over.
        expect(resolveUsableContextWindow('claude-opus [1M]', 200_000)).toBe(800_000);
    });
});

describe('resolveUsableContextWindow — per-model overrides', () => {
    test('exact-match override wins over the 200k default', () => {
        expect(resolveUsableContextWindow('claude-opus-4-8', 200_000, { 'claude-opus-4-8': 1_000_000 })).toBe(800_000);
    });

    test('prefix-match override covers dated/suffixed variants', () => {
        expect(resolveUsableContextWindow('claude-opus-4-8-20260101', 200_000, { 'claude-opus-4-8': 1_000_000 })).toBe(800_000);
        expect(resolveUsableContextWindow('claude-opus-4-8 [1M]', 200_000, { 'claude-opus-4-8': 1_000_000 })).toBe(800_000);
    });

    test('per-model override beats a non-default global override', () => {
        // global 500k → usable 400k; per-model 1M → usable 800k. Per-model wins.
        expect(resolveUsableContextWindow('claude-opus-4-8', 500_000, { 'claude-opus-4-8': 1_000_000 })).toBe(800_000);
    });

    test('longest matching prefix wins', () => {
        const overrides = { 'claude': 300_000, 'claude-opus-4-8': 1_000_000 };
        expect(resolveUsableContextWindow('claude-opus-4-8', 200_000, overrides)).toBe(800_000);
    });

    test('non-matching model falls through to normal detection', () => {
        // claude-sonnet-4-6 has no override and no size hint → 200k default → 160k.
        expect(resolveUsableContextWindow('claude-sonnet-4-6', 200_000, { 'claude-opus-4-8': 1_000_000 })).toBe(160_000);
    });

    test('empty/undefined override map preserves existing behavior', () => {
        expect(resolveUsableContextWindow('claude-opus-4-7 [1M]', 200_000, {})).toBe(800_000);
        expect(resolveUsableContextWindow(undefined, 200_000, { 'claude-opus-4-8': 1_000_000 })).toBe(160_000);
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
