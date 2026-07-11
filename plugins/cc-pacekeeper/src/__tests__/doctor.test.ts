import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatDoctorReport, runDoctor, type DoctorCheck } from '../doctor';

describe('doctor', () => {
    test('offline run produces every check with a severity', async () => {
        const checks = await runDoctor({ network: false });
        const names = checks.map(c => c.name);
        for (const expected of ['runtime', 'credentials', 'usage cache', 'config', 'context window override', 'model-info cache', 'state dirs', 'hook crashes']) {
            expect(names).toContain(expected);
        }
        for (const c of checks) {
            expect(['ok', 'warn', 'fail']).toContain(c.severity);
            expect(c.detail.length).toBeGreaterThan(0);
        }
    });

    test('report renders one line per check with severity glyph', () => {
        const checks: DoctorCheck[] = [
            { name: 'runtime', severity: 'ok', detail: 'bun 1.3.14' },
            { name: 'credentials', severity: 'warn', detail: 'none found' }
        ];
        const out = formatDoctorReport(checks);
        expect(out).toContain('✓ runtime — bun 1.3.14');
        expect(out).toContain('⚠ credentials — none found');
    });

    test('unparseable usage cache is flagged as format drift, not "never written"', async () => {
        const cacheFile = path.join(os.homedir(), '.cache', 'cc-pacekeeper', 'usage.json');
        const backup = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null;
        try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, '{"totally": "unexpected schema"');
            const checks = await runDoctor({ network: false });
            const usage = checks.find(c => c.name === 'usage cache');
            expect(usage?.severity).toBe('fail');
            expect(usage?.detail).toContain('drift');
        } finally {
            if (backup !== null) fs.writeFileSync(cacheFile, backup); else fs.rmSync(cacheFile, { force: true });
        }
    });

    test('transcript check runs only when a path is given, and parses a healthy transcript', async () => {
        const none = await runDoctor({ network: false });
        expect(none.find(c => c.name === 'transcript format')).toBeUndefined();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-transcript-'));
        const tp = path.join(tmp, 't.jsonl');
        fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5', usage: { input_tokens: 5 } } }) + '\n');
        const withT = await runDoctor({ network: false, transcript: tp });
        const t = withT.find(c => c.name === 'transcript format');
        expect(t?.severity).toBe('ok');
        const bad = await runDoctor({ network: false, transcript: path.join(tmp, 'missing.jsonl') });
        expect(bad.find(c => c.name === 'transcript format')?.severity).toBe('fail');
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});
