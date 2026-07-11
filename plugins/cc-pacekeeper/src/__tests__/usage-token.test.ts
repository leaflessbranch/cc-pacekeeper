import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUsageToken, readUsageTokenFromMacKeychain } from '../vendor/usage-fetch';

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
