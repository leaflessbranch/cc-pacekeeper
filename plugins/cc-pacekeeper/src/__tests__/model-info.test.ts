import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MODEL_INFO_CACHE_FILE, readCachedMaxInputTokens, authHeaders, resolveModelInfoAuth } from '../model-info';

const CACHE_DIR = path.dirname(MODEL_INFO_CACHE_FILE);
let backupPath: string | null = null;

beforeEach(() => {
    try {
        if (fs.existsSync(MODEL_INFO_CACHE_FILE)) {
            backupPath = path.join(os.tmpdir(), `model-info-backup-${process.pid}-${Date.now()}.json`);
            fs.copyFileSync(MODEL_INFO_CACHE_FILE, backupPath);
        }
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch { /* ignore */ }
});

afterEach(() => {
    try { fs.unlinkSync(MODEL_INFO_CACHE_FILE); } catch { /* ignore */ }
    if (backupPath) {
        try { fs.renameSync(backupPath, MODEL_INFO_CACHE_FILE); } catch { /* ignore */ }
        backupPath = null;
    }
});

describe('readCachedMaxInputTokens', () => {
    test('returns null when cache file is missing', () => {
        try { fs.unlinkSync(MODEL_INFO_CACHE_FILE); } catch { /* ignore */ }
        expect(readCachedMaxInputTokens('claude-opus-4-7')).toBeNull();
    });

    test('returns null when model id is not in the cache', () => {
        fs.writeFileSync(MODEL_INFO_CACHE_FILE, JSON.stringify({
            'claude-sonnet-4-6': { max_input_tokens: 1_000_000, fetched_at: '2026-06-18T00:00:00Z' }
        }));
        expect(readCachedMaxInputTokens('claude-opus-4-7')).toBeNull();
    });

    test('returns max_input_tokens for cached entries', () => {
        fs.writeFileSync(MODEL_INFO_CACHE_FILE, JSON.stringify({
            'claude-opus-4-7': { max_input_tokens: 1_000_000, fetched_at: '2026-06-18T00:00:00Z' }
        }));
        expect(readCachedMaxInputTokens('claude-opus-4-7')).toBe(1_000_000);
    });

    test('returns null when entry shape is invalid', () => {
        fs.writeFileSync(MODEL_INFO_CACHE_FILE, JSON.stringify({
            'claude-opus-4-7': { max_input_tokens: -1, fetched_at: 'x' }
        }));
        expect(readCachedMaxInputTokens('claude-opus-4-7')).toBeNull();
    });
});

describe('model-info auth', () => {
    test('api-key fallback when no OAuth token and ANTHROPIC_API_KEY set', () => {
        // No CLAUDE_CONFIG_DIR credentials in this env path
        process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-noauth-'));
        const auth = resolveModelInfoAuth({ ANTHROPIC_API_KEY: 'sk-ant-test' } as NodeJS.ProcessEnv);
        // On darwin the keychain may yield a real token; accept either source
        if (auth?.kind === 'api-key') {
            expect(auth.key).toBe('sk-ant-test');
        } else {
            expect(auth?.kind).toBe('oauth');
        }
    });

    test('authHeaders shapes', () => {
        expect(authHeaders({ kind: 'oauth', token: 't' })).toEqual({
            'Authorization': 'Bearer t',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20'
        });
        expect(authHeaders({ kind: 'api-key', key: 'k' })).toEqual({
            'x-api-key': 'k',
            'anthropic-version': '2023-06-01'
        });
    });
});
