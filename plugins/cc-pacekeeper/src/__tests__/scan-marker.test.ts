import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { scanMarkerCreates, scanKeepaliveState, KEEPALIVE_MARKER } from '../keepalive';
import { RESUME_MARKER } from '../agent-budget';

let TRANSCRIPT = '';

beforeEach(() => {
    TRANSCRIPT = path.join(os.tmpdir(), `pace-scan-marker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
});

afterEach(() => {
    try { fs.unlinkSync(TRANSCRIPT); } catch { /* ignore */ }
});

function writeLines(lines: unknown[]): void {
    fs.writeFileSync(TRANSCRIPT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function cronCreate(id: string, prompt: string): unknown {
    return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'CronCreate', input: { cron: '7 * * * *', prompt } }] } };
}

function cronResult(useId: string, jobId: string): unknown {
    return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: useId, content: `Scheduled job ${jobId}.` }] } };
}

function cronDelete(jobId: string): unknown {
    return { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'del-1', name: 'CronDelete', input: { id: jobId } }] } };
}

describe('scanMarkerCreates', () => {
    test('scoped to its marker: resume create is invisible to the keepalive scan and vice versa', () => {
        writeLines([
            cronCreate('tu-1', `${RESUME_MARKER} lane main`),
            cronResult('tu-1', 'abcd1234')
        ]);
        expect(scanMarkerCreates(TRANSCRIPT, RESUME_MARKER).hasPending).toBe(true);
        expect(scanMarkerCreates(TRANSCRIPT, KEEPALIVE_MARKER).hasPending).toBe(false);
    });

    test('pending resume-marker job goes non-pending after CronDelete of its id', () => {
        writeLines([
            cronCreate('tu-1', `${RESUME_MARKER} lane main`),
            cronResult('tu-1', 'abcd1234'),
            cronDelete('abcd1234')
        ]);
        expect(scanMarkerCreates(TRANSCRIPT, RESUME_MARKER).hasPending).toBe(false);
    });

    test('keepalive regression: scanKeepaliveState wrapper behaves exactly as before', () => {
        writeLines([
            cronCreate('tu-1', `${KEEPALIVE_MARKER} tiny turn`),
            cronResult('tu-1', 'wxyz9876')
        ]);
        const state = scanKeepaliveState(TRANSCRIPT);
        expect(state.hasPending).toBe(true);
        expect(state.pendingTaskId).toBe('wxyz9876');
    });

    test('missing transcript: not pending', () => {
        expect(scanMarkerCreates('/nonexistent/t.jsonl', RESUME_MARKER).hasPending).toBe(false);
    });
});
