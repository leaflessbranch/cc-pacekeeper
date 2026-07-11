import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { stateDir } from './state';

/**
 * Last-crash breadcrumbs for the hook entrypoints. Hooks deliberately swallow
 * errors (emit {} so Claude's workflow never breaks) — this file is the only
 * place a crash leaves a trace, surfaced by `doctor`.
 */

const CrashLogSchema = z.object({
    count: z.number(),
    lastScript: z.string(),
    lastMessage: z.string(),
    lastAt: z.string()
});
export type CrashLog = z.infer<typeof CrashLogSchema>;

export function crashLogFile(): string {
    return path.join(stateDir(), 'crash-log.json');
}

export function readCrashLog(): CrashLog | null {
    try {
        const parsed = CrashLogSchema.safeParse(JSON.parse(fs.readFileSync(crashLogFile(), 'utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function recordCrash(script: string, err: unknown): void {
    try {
        const prev = readCrashLog();
        const log: CrashLog = {
            count: (prev?.count ?? 0) + 1,
            lastScript: script,
            lastMessage: err instanceof Error ? err.message : String(err),
            lastAt: new Date().toISOString()
        };
        fs.mkdirSync(stateDir(), { recursive: true });
        fs.writeFileSync(crashLogFile(), JSON.stringify(log));
    } catch {
        // A crash handler must never throw.
    }
}
