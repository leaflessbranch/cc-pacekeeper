import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUsageToken, readUsageTokenFromMacKeychain, readUsageCacheFile } from '../vendor/usage-fetch';

const CRED_BLOB = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123' } });

describe('readUsageTokenFromMacKeychain', () => {
    test('parses the credential blob returned by `security`', () => {
        const exec = () => CRED_BLOB + '\n';
        expect(readUsageTokenFromMacKeychain(exec)).toBe('tok-123');
    });

    test('returns null when `security` fails (no entry / denied)', () => {
        const exec = () => { throw new Error('exit 44'); };
        expect(readUsageTokenFromMacKeychain(exec)).toBeNull();
    });

    test('returns null on non-credential output', () => {
        const exec = () => 'not json';
        expect(readUsageTokenFromMacKeychain(exec)).toBeNull();
    });
});

describe('getUsageToken source order', () => {
    let tmp: string;
    const ORIGINAL = process.env.CLAUDE_CONFIG_DIR;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-cred-'));
        process.env.CLAUDE_CONFIG_DIR = tmp;
    });
    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = ORIGINAL;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('credentials file wins when present', () => {
        fs.writeFileSync(path.join(tmp, '.credentials.json'),
            JSON.stringify({ claudeAiOauth: { accessToken: 'file-tok' } }));
        expect(getUsageToken()).toBe('file-tok');
    });
});

describe('readUsageCacheFile verifyTokenHash', () => {
    test('mismatched tokenHash returns null only when verification requested', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-hash-'));
        process.env.CLAUDE_CONFIG_DIR = tmp;
        fs.writeFileSync(path.join(tmp, '.credentials.json'),
            JSON.stringify({ claudeAiOauth: { accessToken: 'current-token' } }));
        const cacheDir = path.join(os.homedir(), '.cache', 'cc-pacekeeper');
        fs.mkdirSync(cacheDir, { recursive: true });
        const cacheFile = path.join(cacheDir, 'usage.json');
        const backup = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null;
        try {
            fs.writeFileSync(cacheFile, JSON.stringify({ sessionUsage: 42, tokenHash: 'stale-account-hash' }));
            expect(readUsageCacheFile()?.sessionUsage).toBe(42);                       // lenient default
            expect(readUsageCacheFile({ verifyTokenHash: true })).toBeNull();          // strict on request
        } finally {
            if (backup !== null) fs.writeFileSync(cacheFile, backup); else fs.rmSync(cacheFile, { force: true });
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
