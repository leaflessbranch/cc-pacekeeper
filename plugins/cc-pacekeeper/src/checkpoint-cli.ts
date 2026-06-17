#!/usr/bin/env bun
import * as fs from 'fs';
import * as path from 'path';
import { bootstrapConfigIfMissing, loadConfig } from './config';
import {
    archiveCheckpoint,
    listActive,
    listArchive,
    listLive,
    readCheckpoint,
    saveCheckpoint,
    ageDays,
    type Checkpoint
} from './checkpoint';
import { contextPercent, readContextTokens } from './ctx-tokens';
import { readUsageCacheFile } from './vendor/usage-fetch';

interface Args {
    verb: string;
    flags: Record<string, string | true>;
    positional: string[];
}

function parseArgs(argv: string[]): Args {
    const [verb = 'help', ...rest] = argv;
    const flags: Record<string, string | true> = {};
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i] ?? '';
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq > 0) {
                flags[a.slice(2, eq)] = a.slice(eq + 1);
            } else {
                const next = rest[i + 1];
                if (next !== undefined && !next.startsWith('--')) {
                    flags[a.slice(2)] = next;
                    i++;
                } else {
                    flags[a.slice(2)] = true;
                }
            }
        } else {
            positional.push(a);
        }
    }
    return { verb, flags, positional };
}

function fmt(ts: string | undefined): string {
    if (!ts) return '(unknown time)';
    try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }
    catch { return ts; }
}

function shortGoal(body: string): string {
    const m = /(^|\n)## Goal\s*\n([\s\S]*?)(?=\n## |\n*$)/.exec(body);
    if (!m) return '(no goal section)';
    const first = (m[2] ?? '').trim().split('\n')[0] ?? '';
    return first || '(empty goal)';
}

function buildSavePrompt(cwd: string): void {
    // Used when invoked without stdin body content: emit a template to stdout
    // for Claude to fill in and re-invoke with --body.
    const tpl = [
        '## Goal',
        '<one-line statement of what this session is trying to accomplish>',
        '',
        '## Status',
        '<where we are in the plan; bullet list of completed steps>',
        '',
        '## In flight',
        '<the exact step interrupted, with enough detail for fresh-session resume>',
        '',
        '## Next',
        '<the next concrete step>',
        '',
        '## Open questions',
        '<anything blocked on user input; or "none">',
        '',
        '## References',
        '- <plan/PR/issue/related-file>'
    ].join('\n');
    process.stdout.write(tpl);
    process.stderr.write(`\nFill in the template above and re-invoke with --body or via the /cc-pacekeeper:checkpoint skill in cwd ${cwd}.\n`);
}

async function readAllStdin(): Promise<string> {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk.toString();
    return raw;
}

function gatherMeters(transcriptPath: string | undefined, windowSize: number): Record<string, unknown> {
    const usage = readUsageCacheFile();
    const ctx = transcriptPath ? readContextTokens(transcriptPath) : null;
    const meters: Record<string, unknown> = {};
    if (ctx) meters.context_pct = Math.round(contextPercent(ctx.contextLength, windowSize));
    if (usage) {
        if (usage.sessionUsage !== undefined) meters.five_hour_pct = Math.round(usage.sessionUsage);
        if (usage.weeklyUsage !== undefined) meters.weekly_all_pct = Math.round(usage.weeklyUsage);
        if (usage.weeklySonnetUsage !== undefined) meters.weekly_sonnet_pct = Math.round(usage.weeklySonnetUsage);
        if (usage.weeklyOpusUsage !== undefined) meters.weekly_opus_pct = Math.round(usage.weeklyOpusUsage);
        if (usage.sessionResetAt) meters.five_hour_resets_at = usage.sessionResetAt;
        if (usage.weeklyResetAt) meters.weekly_resets_at = usage.weeklyResetAt;
    }
    return meters;
}

function verbSave(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): Promise<void> | void {
    const bodyFromFlag = typeof args.flags.body === 'string' ? args.flags.body : null;
    const bodyFromFile = typeof args.flags['body-file'] === 'string' ? fs.readFileSync(args.flags['body-file'] as string, 'utf8') : null;
    const trigger = (typeof args.flags.trigger === 'string' ? args.flags.trigger : 'user_invoked');
    const sessionId = typeof args.flags['session-id'] === 'string' ? args.flags['session-id'] : undefined;
    const transcriptPath = typeof args.flags['transcript-path'] === 'string' ? args.flags['transcript-path'] : undefined;

    return (async () => {
        let body = bodyFromFlag ?? bodyFromFile;
        if (body === null) {
            // Try stdin; if empty, emit template and bail.
            if (!process.stdin.isTTY) {
                const stdin = await readAllStdin();
                if (stdin.trim() !== '') body = stdin;
            }
        }
        if (body === null || body.trim() === '') {
            buildSavePrompt(cwd);
            process.exitCode = 2;
            return;
        }

        const meters = gatherMeters(transcriptPath, cfg.context_window_size);
        const { path: written, supersededPaths } = saveCheckpoint({
            cwd,
            checkpointDirName: cfg.checkpoint_dir_name,
            frontmatter: {
                session_id: sessionId,
                trigger,
                meters: Object.keys(meters).length > 0 ? meters : undefined,
                project_root: cwd
            },
            body
        });
        process.stdout.write(`Saved checkpoint: ${written}\n`);
        if (supersededPaths.length > 0) {
            process.stdout.write(`Superseded ${supersededPaths.length} earlier active checkpoint(s) → archive/\n`);
        }
    })();
}

function verbList(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
    const archived = args.flags.archived === true;
    const items: Checkpoint[] = archived
        ? listArchive(cwd, cfg.checkpoint_dir_name)
        : listLive(cwd, cfg.checkpoint_dir_name);

    if (items.length === 0) {
        process.stdout.write(archived ? 'No archived checkpoints.\n' : 'No live checkpoints.\n');
        return;
    }
    const rows = items.map((c, i) => {
        const age = ageDays(c).toFixed(1);
        const status = c.frontmatter.status;
        const goal = shortGoal(c.body);
        return `[${i + 1}] ${status.padEnd(11)} ${fmt(c.frontmatter.created_at)}  (${age}d)  ${path.basename(c.path)}\n     ${goal}`;
    });
    process.stdout.write(rows.join('\n') + '\n');
}

function verbResume(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
    const n = args.positional[0] ? parseInt(args.positional[0], 10) : 1;
    const active = listActive(cwd, cfg.checkpoint_dir_name);
    if (active.length === 0) {
        process.stdout.write('No active checkpoints to resume.\n');
        return;
    }
    if (n < 1 || n > active.length) {
        process.stdout.write(`Index ${n} out of range. Use \`list\` to see available checkpoints (1..${active.length}).\n`);
        process.exitCode = 1;
        return;
    }
    const ckpt = active[n - 1]!;
    process.stdout.write('=== Checkpoint orientation ===\n');
    process.stdout.write(`File: ${ckpt.path}\n`);
    process.stdout.write(`Created: ${ckpt.frontmatter.created_at}\n`);
    if (ckpt.frontmatter.git_branch) process.stdout.write(`Git: ${ckpt.frontmatter.git_branch} @ ${ckpt.frontmatter.git_head ?? '?'}\n`);
    process.stdout.write('\n');
    process.stdout.write(ckpt.body + '\n');
    process.stdout.write('\n=== End checkpoint ===\n');

    // Move to archive with status=resumed.
    const moved = archiveCheckpoint(ckpt, 'resumed', cwd, cfg.checkpoint_dir_name);
    if (moved) {
        process.stdout.write(`\nCheckpoint marked resumed and moved to: ${moved}\n`);
    }
}

function verbDiscard(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
    const n = args.positional[0] ? parseInt(args.positional[0], 10) : 1;
    const reason = typeof args.flags.reason === 'string' ? args.flags.reason : '(no reason given)';
    const active = listActive(cwd, cfg.checkpoint_dir_name);
    if (active.length === 0) {
        process.stdout.write('No active checkpoints to discard.\n');
        return;
    }
    if (n < 1 || n > active.length) {
        process.stdout.write(`Index ${n} out of range (1..${active.length}).\n`);
        process.exitCode = 1;
        return;
    }
    const ckpt = active[n - 1]!;
    const moved = archiveCheckpoint(ckpt, 'superseded', cwd, cfg.checkpoint_dir_name, { discard_reason: reason });
    process.stdout.write(moved ? `Discarded → ${moved}\n` : 'Discard failed.\n');
}

function verbCleanup(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
    const apply = args.flags.apply === true;
    const olderThanFlag = typeof args.flags['older-than'] === 'string' ? args.flags['older-than'] as string : null;
    const liveThresholdDays = olderThanFlag ? parseDays(olderThanFlag) : cfg.checkpoint.stale_after_days;
    const archiveThresholdDays = cfg.checkpoint.archive_keep_days;

    const live = listLive(cwd, cfg.checkpoint_dir_name);
    const arc = listArchive(cwd, cfg.checkpoint_dir_name);

    const liveStale = live.filter(c => c.frontmatter.status === 'active' && ageDays(c) > liveThresholdDays);
    const archiveExpired = arc.filter(c => ageDays(c) > archiveThresholdDays);

    if (liveStale.length === 0 && archiveExpired.length === 0) {
        process.stdout.write(`Nothing to clean up.\n  Live actives older than ${liveThresholdDays}d: 0\n  Archive files older than ${archiveThresholdDays}d: 0\n`);
        return;
    }

    process.stdout.write(`Cleanup candidates${apply ? '' : ' (dry-run; pass --apply to execute)'}:\n`);
    if (liveStale.length > 0) {
        process.stdout.write(`  Move to archive (status → stale): ${liveStale.length}\n`);
        for (const c of liveStale) process.stdout.write(`    ${path.basename(c.path)}  (${ageDays(c).toFixed(1)}d old)\n`);
    }
    if (archiveExpired.length > 0) {
        process.stdout.write(`  Delete from archive (older than ${archiveThresholdDays}d): ${archiveExpired.length}\n`);
        for (const c of archiveExpired) process.stdout.write(`    archive/${path.basename(c.path)}  (${ageDays(c).toFixed(1)}d old)\n`);
    }

    if (!apply) return;

    let movedCount = 0;
    let deletedCount = 0;
    for (const c of liveStale) {
        const r = archiveCheckpoint(c, 'stale', cwd, cfg.checkpoint_dir_name);
        if (r) movedCount++;
    }
    for (const c of archiveExpired) {
        try { fs.unlinkSync(c.path); deletedCount++; } catch { /* ignore */ }
    }
    process.stdout.write(`\nApplied: moved ${movedCount}, deleted ${deletedCount}.\n`);
}

function parseDays(s: string): number {
    const m = /^(\d+)([dD]?)$/.exec(s.trim());
    if (!m) return Number(s) || 0;
    return parseInt(m[1] ?? '0', 10);
}

function verbHelp(): void {
    process.stdout.write([
        'cc-pacekeeper checkpoint CLI',
        '',
        'Usage: pacekeeper-checkpoint <verb> [args]',
        '',
        'Verbs:',
        '  save [--body <text> | --body-file <path>] [--trigger <kind>]',
        '       [--session-id <id>] [--transcript-path <path>]',
        '       Write a new active checkpoint. Body may also be piped on stdin.',
        '       If no body is provided, emits a template and exits 2.',
        '',
        '  resume [N]            Show checkpoint #N (default: newest active) and archive it as resumed.',
        '  list [--archived]     List live (or archived) checkpoints for this cwd.',
        '  discard [N] [--reason <text>]  Move active checkpoint #N to archive without resuming.',
        '  cleanup [--older-than Nd] [--apply]',
        '                        Show stale live files + expired archive files. Dry-run by default.',
        '',
        '  help                  Show this message.',
        ''
    ].join('\n'));
}

async function main(): Promise<void> {
    bootstrapConfigIfMissing();
    const cfg = loadConfig();
    const cwd = process.cwd();
    const args = parseArgs(process.argv.slice(2));

    switch (args.verb) {
        case 'save': await verbSave(args, cwd, cfg); return;
        case 'resume': verbResume(args, cwd, cfg); return;
        case 'list': verbList(args, cwd, cfg); return;
        case 'discard': verbDiscard(args, cwd, cfg); return;
        case 'cleanup': verbCleanup(args, cwd, cfg); return;
        case 'help':
        case '--help':
        case '-h':
            verbHelp(); return;
        default:
            process.stdout.write(`Unknown verb: ${args.verb}\n\n`);
            verbHelp();
            process.exitCode = 1;
    }
}

main().catch((err) => {
    process.stderr.write(`pacekeeper-checkpoint error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
});
