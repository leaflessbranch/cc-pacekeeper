import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { crashLogFile, readCrashLog, recordCrash } from '../crash-log';

let backupPath: string | null = null;

beforeEach(() => {
    try {
        if (fs.existsSync(crashLogFile())) {
            backupPath = path.join(os.tmpdir(), `crash-log-backup-${process.pid}-${Date.now()}.json`);
            fs.copyFileSync(crashLogFile(), backupPath);
        }
    } catch { /* ignore */ }
    fs.rmSync(crashLogFile(), { force: true });
});

afterEach(() => {
    fs.rmSync(crashLogFile(), { force: true });
    if (backupPath) {
        try { fs.renameSync(backupPath, crashLogFile()); } catch { /* ignore */ }
        backupPath = null;
    }
});

describe('crash-log', () => {
    test('records and reads a crash with count accumulation', () => {
        recordCrash('tick', new Error('boom'));
        recordCrash('refresh', 'string error');
        const log = readCrashLog();
        expect(log?.count).toBe(2);
        expect(log?.lastScript).toBe('refresh');
        expect(log?.lastMessage).toBe('string error');
        expect(Date.parse(log!.lastAt)).toBeGreaterThan(0);
    });

    test('missing file reads as null', () => {
        expect(readCrashLog()).toBeNull();
    });
});
