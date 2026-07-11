#!/usr/bin/env bun
import { bootstrapConfigIfMissing, isProjectDenied, loadConfig } from './config';
import { emitAdditionalContext, emitEmpty, readStdinJson } from './hook-io';
import { recordCrash } from './crash-log';

async function main(): Promise<void> {
    const stdin = await readStdinJson();
    const cwd = stdin.cwd ?? process.cwd();

    bootstrapConfigIfMissing();
    const cfg = loadConfig();

    if (isProjectDenied(cwd, cfg)) {
        emitEmpty();
        return;
    }

    const text = [
        '⚠ Context compaction is imminent.',
        '',
        'Before compaction lossily summarizes the conversation, save the current state:',
        '  /cc-pacekeeper:checkpoint save',
        '',
        'A checkpoint preserves goal, in-flight step, next step, and open questions in a resumable file under the project\'s working tree — so you can pick up cleanly in a fresh session if compaction loses key details.'
    ].join('\n');

    emitAdditionalContext('PreCompact', text);
}

main().catch((err) => {
    recordCrash('precompact', err);
    try { process.stderr.write(`pacekeeper-precompact error: ${err instanceof Error ? err.message : String(err)}\n`); } catch { /* ignore */ }
    emitEmpty();
});
