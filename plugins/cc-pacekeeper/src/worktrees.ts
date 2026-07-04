#!/usr/bin/env bun
import { execFileSync } from 'child_process';
import { listLiveSessions } from './live-sessions';

/**
 * Print the repo's git worktrees as JSON, annotated with dirty state and
 * whether a live Claude session is currently running in each. Consumed by the
 * /cc-pacekeeper:worktree skill's `list` verb.
 */

interface WorktreeRow {
    path: string;
    branch?: string;
    head?: string;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    dirty: boolean;
    liveSessions: number;
}

function git(args: string[], cwd: string): string | undefined {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return undefined;
    }
}

function parsePorcelain(out: string): WorktreeRow[] {
    const rows: WorktreeRow[] = [];
    let cur: Partial<WorktreeRow> | null = null;
    const flush = (): void => {
        if (cur && cur.path) {
            rows.push({
                path: cur.path,
                branch: cur.branch,
                head: cur.head,
                bare: cur.bare ?? false,
                detached: cur.detached ?? false,
                locked: cur.locked ?? false,
                dirty: false,
                liveSessions: 0
            });
        }
        cur = null;
    };
    for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) { flush(); cur = { path: line.slice('worktree '.length) }; }
        else if (line.startsWith('HEAD ') && cur) cur.head = line.slice('HEAD '.length);
        else if (line.startsWith('branch ') && cur) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        else if (line === 'bare' && cur) cur.bare = true;
        else if (line === 'detached' && cur) cur.detached = true;
        else if (line.startsWith('locked') && cur) cur.locked = true;
    }
    flush();
    return rows;
}

function main(): void {
    const cwd = process.cwd();
    const porcelain = git(['worktree', 'list', '--porcelain'], cwd);
    if (porcelain === undefined) {
        process.stdout.write(JSON.stringify({ error: 'not a git repository' }));
        return;
    }
    const rows = parsePorcelain(porcelain);
    const sessions = listLiveSessions() ?? [];

    for (const row of rows) {
        if (!row.bare) {
            const status = git(['status', '--porcelain'], row.path);
            row.dirty = status !== undefined && status.length > 0;
        }
        row.liveSessions = sessions.filter(s => s.cwd === row.path).length;
    }

    process.stdout.write(JSON.stringify({ worktrees: rows }, null, 2));
}

main();
