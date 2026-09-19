import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    autoCompactWindow, contextPercent, ONE_M_AUTOCOMPACT_TOKENS, parseWindowSetting,
    readAutoCompactEnabled, readAutoCompactSetting, readContextTokens, readMostRecentModel,
    resolveUsableContextWindow
} from '../ctx-tokens';

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
        expect(tokens.fromCompactBoundary).toBeUndefined();
    });

    test('after a compact_boundary with no assistant turn since, reports the boundary postTokens', () => {
        const lines = [
            { type: 'assistant', message: { usage: { input_tokens: 32, cache_read_input_tokens: 830_000 } } },
            { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 830_263, postTokens: 21_531 } },
            { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' } }
        ];
        fs.writeFileSync(TRANSCRIPT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        const t = readContextTokens(TRANSCRIPT)!;
        expect(t.contextLength).toBe(21_531);
        expect(t.model).toBeUndefined();
        expect(t.fromCompactBoundary).toBe(true);
    });

    test('an assistant turn after the boundary takes over from postTokens', () => {
        const lines = [
            { type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens: 21_531 } },
            { type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 41_461, cache_read_input_tokens: 36_458 } } }
        ];
        fs.writeFileSync(TRANSCRIPT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        expect(readContextTokens(TRANSCRIPT)!.contextLength).toBe(2 + 41_461 + 36_458);
    });

    test('a boundary without postTokens yields null rather than the stale pre-compaction size', () => {
        const lines = [
            { type: 'assistant', message: { usage: { input_tokens: 830_000 } } },
            { type: 'system', subtype: 'compact_boundary' }
        ];
        fs.writeFileSync(TRANSCRIPT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        expect(readContextTokens(TRANSCRIPT)).toBeNull();
    });

    test('a sidechain boundary is ignored', () => {
        const lines = [
            { type: 'assistant', message: { usage: { input_tokens: 500 } } },
            { type: 'system', subtype: 'compact_boundary', isSidechain: true, compactMetadata: { postTokens: 1 } }
        ];
        fs.writeFileSync(TRANSCRIPT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        expect(readContextTokens(TRANSCRIPT)!.contextLength).toBe(500);
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

    test('sidechain assistant rows are skipped — main-thread usage wins', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ctx-'));
        const tp = path.join(tmp, 't.jsonl');
        const mainRow = JSON.stringify({
            type: 'assistant',
            message: { model: 'claude-fable-5', usage: { input_tokens: 100, cache_read_input_tokens: 900 } }
        });
        const sidechainRow = JSON.stringify({
            type: 'assistant', isSidechain: true,
            message: { model: 'claude-haiku-4-5', usage: { input_tokens: 5 } }
        });
        fs.writeFileSync(tp, mainRow + '\n' + sidechainRow + '\n');
        const r = readContextTokens(tp);
        expect(r?.contextLength).toBe(1000);
        expect(r?.model).toBe('claude-fable-5');
        expect(readMostRecentModel(tp)).toBe('claude-fable-5');
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});

/** Keep the window tests off the developer's own env and settings.json. */
function isolateAutoCompactEnv(): void {
    let dir: string;
    let prevWindow: string | undefined;
    let prevConfigDir: string | undefined;
    let prevDisable1M: string | undefined;
    beforeEach(() => {
        prevWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        prevDisable1M = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ctx-env-'));
        process.env.CLAUDE_CONFIG_DIR = dir;
    });
    afterEach(() => {
        if (prevWindow === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prevWindow;
        if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
        if (prevDisable1M === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
        else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prevDisable1M;
        fs.rmSync(dir, { recursive: true, force: true });
    });
}

describe('resolveUsableContextWindow', () => {
    isolateAutoCompactEnv();

    // The denominator is Claude Code's auto-compact point, not 80% of the window.
    test('falls back to the full 200k window when nothing is known', () => {
        expect(resolveUsableContextWindow(undefined, 200_000)).toBe(200_000);
    });

    test('a 1M window from a display-name hint compacts at ~967k', () => {
        expect(resolveUsableContextWindow('claude-opus-4-7 [1M]', 200_000)).toBe(ONE_M_AUTOCOMPACT_TOKENS);
    });

    test('honors a non-default config override as the window itself', () => {
        expect(resolveUsableContextWindow(undefined, 300_000)).toBe(300_000);
    });

    test('ignores a config override equal to the historical default (200k)', () => {
        expect(resolveUsableContextWindow('claude-opus [1M]', 200_000)).toBe(ONE_M_AUTOCOMPACT_TOKENS);
    });

    // Docs, model-config: with this set, models with a native 1M window are
    // held at — and compact at — the 200K boundary.
    test('CLAUDE_CODE_DISABLE_1M_CONTEXT=1 holds a 1M model at the 200k boundary', () => {
        const prev = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
        process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
        try {
            expect(resolveUsableContextWindow('claude-opus [1M]', 200_000)).toBe(200_000);
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
            else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prev;
        }
    });

    test('CLAUDE_CODE_AUTO_COMPACT_WINDOW in the environment wins', () => {
        const prev = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '500000';
        try {
            expect(resolveUsableContextWindow('claude-opus [1M]', 200_000)).toBe(500_000);
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
            else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prev;
        }
    });
});

describe('autoCompactWindow', () => {
    isolateAutoCompactEnv();

    test('model default: 1M windows compact at 967k, smaller windows at the window', () => {
        expect(autoCompactWindow(1_000_000, {}, null)).toEqual({ tokens: 967_000, source: 'model-default' });
        expect(autoCompactWindow(200_000, {}, null)).toEqual({ tokens: 200_000, source: 'model-default' });
    });

    test('env overrides settings, settings override the model default, both capped at the window', () => {
        expect(autoCompactWindow(1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }, 300_000))
            .toEqual({ tokens: 400_000, source: 'env' });
        expect(autoCompactWindow(1_000_000, {}, 300_000)).toEqual({ tokens: 300_000, source: 'settings' });
        expect(autoCompactWindow(200_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' }, null))
            .toEqual({ tokens: 200_000, source: 'env' });
    });

    test('an unparseable env value is ignored', () => {
        expect(autoCompactWindow(1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'lots' }, null).source).toBe('model-default');
    });

    // The env var takes a plain token count only (docs, env-vars reference):
    // `500k` reads as `500`, which then clamps to the documented 100K floor.
    test('the env var is a plain integer: 500k reads as 500 and clamps to the floor', () => {
        expect(autoCompactWindow(1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }, null))
            .toEqual({ tokens: 100_000, source: 'env' });
    });

    test('env and settings values clamp to [100K, 1M] before the window cap', () => {
        expect(autoCompactWindow(1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' }, null))
            .toEqual({ tokens: 100_000, source: 'env' });
        expect(autoCompactWindow(1_000_000, {}, 50_000)).toEqual({ tokens: 100_000, source: 'settings' });
        expect(autoCompactWindow(1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '2000000' }, null))
            .toEqual({ tokens: 1_000_000, source: 'env' });
        expect(autoCompactWindow(200_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '2000000' }, null))
            .toEqual({ tokens: 200_000, source: 'env' });
    });
});

describe('parseWindowSetting / readAutoCompactSetting', () => {
    test('accepts the forms /autocompact accepts', () => {
        expect(parseWindowSetting(200000)).toBe(200_000);
        expect(parseWindowSetting('200000')).toBe(200_000);
        expect(parseWindowSetting('500k')).toBe(500_000);
        expect(parseWindowSetting('1M')).toBe(1_000_000);
        expect(parseWindowSetting('200')).toBe(200_000);   // bare 100..1000 = thousands
        expect(parseWindowSetting('')).toBeNull();
        expect(parseWindowSetting('abc')).toBeNull();
        expect(parseWindowSetting(-5)).toBeNull();
        expect(parseWindowSetting(undefined)).toBeNull();
    });

    // End to end: the settings file, not just the reader, moves the denominator.
    test('resolveUsableContextWindow honors a settings.json autoCompactWindow', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ctx-settings-e2e-'));
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autoCompactWindow: '300k' }));
        const prevDir = process.env.CLAUDE_CONFIG_DIR;
        const prevWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        const prevDisable1M = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
        process.env.CLAUDE_CONFIG_DIR = dir;
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
        try {
            expect(resolveUsableContextWindow('claude-opus [1M]', 200_000)).toBe(300_000);
        } finally {
            if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = prevDir;
            if (prevWindow !== undefined) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prevWindow;
            if (prevDisable1M !== undefined) process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prevDisable1M;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('reads autoCompactWindow from settings.json under CLAUDE_CONFIG_DIR', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ctx-settings-'));
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autoCompactWindow: '300k' }));
        const prev = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = dir;
        try {
            expect(readAutoCompactSetting()).toBe(300_000);
            fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
            expect(readAutoCompactSetting()).toBeNull();
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = prev;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('readAutoCompactEnabled', () => {
    /** Run `fn` with an empty config dir and no DISABLE_AUTO_COMPACT. */
    function isolated(fn: (dir: string) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ctx-autocompact-'));
        const prevDir = process.env.CLAUDE_CONFIG_DIR;
        const prevDisable = process.env.DISABLE_AUTO_COMPACT;
        process.env.CLAUDE_CONFIG_DIR = dir;
        delete process.env.DISABLE_AUTO_COMPACT;
        try {
            fn(dir);
        } finally {
            if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = prevDir;
            if (prevDisable === undefined) delete process.env.DISABLE_AUTO_COMPACT;
            else process.env.DISABLE_AUTO_COMPACT = prevDisable;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    test('defaults to true; DISABLE_AUTO_COMPACT=1 or true turns it off', () => {
        isolated(() => {
            expect(readAutoCompactEnabled()).toBe(true);
            process.env.DISABLE_AUTO_COMPACT = '1';
            expect(readAutoCompactEnabled()).toBe(false);
            process.env.DISABLE_AUTO_COMPACT = 'true';
            expect(readAutoCompactEnabled()).toBe(false);
            process.env.DISABLE_AUTO_COMPACT = '0';
            expect(readAutoCompactEnabled()).toBe(true);
        });
    });

    test('honors autoCompactEnabled in settings.json, true on anything unreadable', () => {
        isolated(dir => {
            const settings = path.join(dir, 'settings.json');
            fs.writeFileSync(settings, JSON.stringify({ autoCompactEnabled: false }));
            expect(readAutoCompactEnabled()).toBe(false);
            fs.writeFileSync(settings, JSON.stringify({ autoCompactEnabled: true }));
            expect(readAutoCompactEnabled()).toBe(true);
            fs.writeFileSync(settings, '{not json');
            expect(readAutoCompactEnabled()).toBe(true);
        });
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
