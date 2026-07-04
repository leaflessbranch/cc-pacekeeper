import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { getClaudeConfigDir } from './vendor/claude-config-dir';

/**
 * Count concurrent live Claude Code sessions that share the same usage budget.
 *
 * Claude writes one file per session at ~/.claude/sessions/<pid>.json. This is
 * an UNDOCUMENTED internal format, so we parse defensively: any read/parse
 * failure returns null and the caller simply omits the segment — we never throw
 * into the hot path.
 *
 * A session counts as live only if its recorded pid is still running
 * (/proc/<pid> exists), so stale files from crashed sessions don't inflate it.
 */

const SessionFileSchema = z.object({
    pid: z.number(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    status: z.string().optional(),
    updatedAt: z.number().optional()
});

export type LiveSession = z.infer<typeof SessionFileSchema>;

function sessionsDir(): string {
    return path.join(getClaudeConfigDir(), 'sessions');
}

function pidAlive(pid: number): boolean {
    return fs.existsSync(`/proc/${pid}`);
}

/**
 * Return the list of live sessions, or null if the sessions dir can't be read.
 * An empty (but readable) dir returns [].
 */
export function listLiveSessions(): LiveSession[] | null {
    const dir = sessionsDir();
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const out: LiveSession[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        let parsed: LiveSession;
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            const r = SessionFileSchema.safeParse(raw);
            if (!r.success) continue;
            parsed = r.data;
        } catch {
            continue;
        }
        if (pidAlive(parsed.pid)) out.push(parsed);
    }
    return out;
}

/** Count of live sessions, or null when the dir is unreadable. */
export function liveSessionCount(): number | null {
    const list = listLiveSessions();
    return list === null ? null : list.length;
}
