import { describe, expect, test } from 'bun:test';
import { formatDoctorReport, runDoctor, type DoctorCheck } from '../doctor';

describe('doctor', () => {
    test('offline run produces every check with a severity', async () => {
        const checks = await runDoctor({ network: false });
        const names = checks.map(c => c.name);
        for (const expected of ['runtime', 'credentials', 'usage cache', 'config', 'context window override', 'model-info cache', 'state dirs']) {
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
});
