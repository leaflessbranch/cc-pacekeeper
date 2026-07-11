#!/usr/bin/env bun
import * as fs from 'fs';
import * as path from 'path';
import { bootstrapConfigIfMissing, loadConfig } from './config';
import { execFileSync } from 'child_process';
import {
    archiveCheckpoint,
    laneOf,
    sanitizeLaneName,
    listActive,
    listArchive,
    listLive,
    readCheckpoint,
    saveCheckpoint,
    ageDays,
    type Checkpoint
} from './checkpoint';
import { contextPercent, readContextTokens, resolveUsableContextWindow } from './ctx-tokens';
import { readUsageCacheFile } from './vendor/usage-fetch';
import { projectRootFromTranscript, resolveProjectRoot, worktreeInfo } from './resolve-root';
import { archiveHandoff, listHandoffs, writeHandoff } from './agent-budget';
import { formatDoctorReport, runDoctor } from './doctor';

interface Args {
    verb: string;
    flags: Record<string, string | true>;
    positional: string[];
}

export function parseArgs(argv: string[]): Args {
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

function gatherMeters(transcriptPath: string | undefined, configWindowSize: number): Record<string, unknown> {
    const usage = readUsageCacheFile();
    const ctx = transcriptPath ? readContextTokens(transcriptPath) : null;
    const meters: Record<string, unknown> = {};
    if (ctx) {
        const usable = resolveUsableContextWindow(ctx.model, configWindowSize);
        meters.context_pct = Math.round(contextPercent(ctx.contextLength, usable));
    }
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
    const name = typeof args.flags.name === 'string' ? args.flags.name : undefined;
    const wakeAt = typeof args.flags['wake-at'] === 'string' ? args.flags['wake-at'] : undefined;
    const wakePrompt = typeof args.flags['wake-prompt'] === 'string' ? args.flags['wake-prompt'] : undefined;

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

        // Provenance: if the session was running in a *linked* worktree, record
        // the worktree path + its branch so resume can re-enter it. Resolve from
        // the session's real dir (transcript cwd → process cwd), before `cwd`
        // was snapped to the main repo root.
        const sessionDir = (transcriptPath ? projectRootFromTranscript(transcriptPath) : undefined) ?? process.cwd();
        const wt = worktreeInfo(sessionDir);
        const worktreeProvenance = wt?.isWorktree ? wt.worktreeRoot : undefined;

        const { path: written, supersededPaths } = saveCheckpoint({
            cwd,
            checkpointDirName: cfg.checkpoint_dir_name,
            frontmatter: {
                name,
                session_id: sessionId,
                trigger,
                meters: Object.keys(meters).length > 0 ? meters : undefined,
                project_root: cwd,
                ...(worktreeProvenance ? { worktree: worktreeProvenance } : {}),
                ...(wt?.isWorktree && wt.branch ? { git_branch: wt.branch } : {}),
                ...(wakeAt ? { wake_at: wakeAt } : {}),
                ...(wakePrompt ? { wake_prompt: wakePrompt } : {})
            },
            body
        });
        process.stdout.write(`Saved checkpoint: ${written}\n`);
        if (supersededPaths.length > 0) {
            process.stdout.write(`Superseded ${supersededPaths.length} earlier active checkpoint(s) → archive/\n`);
        }
    })();
}

export function verbList(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
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
        const name = laneOf(c.frontmatter);
        const branch = c.frontmatter.git_branch ?? '-';
        const worktree = c.frontmatter.worktree ?? '-';
        return `[${i + 1}] ${name.padEnd(20)} ${status.padEnd(11)} branch=${branch}  worktree=${worktree}  (${age}d)  ${path.basename(c.path)}\n     ${goal}`;
    });
    process.stdout.write(rows.join('\n') + '\n');
}

/**
 * Resolve which active checkpoint `resume`/`peek`/`discard` operate on: a lane
 * name, a numeric index from `list`, or (bare) the sole active lane. Prints
 * its own guidance and returns null when the caller should stop (ambiguous or
 * out of range) — the exit code is left to the caller since `peek`/`discard`
 * treat failures slightly differently in practice, but today all agree on 1.
 */
function resolveTarget(selector: string | undefined, active: Checkpoint[]): Checkpoint | null {
    if (active.length === 0) {
        process.stdout.write('No active checkpoints.\n');
        return null;
    }
    if (!selector) {
        if (active.length === 1) return active[0]!;
        process.stdout.write(`${active.length} active checkpoints — pick one:\n\n`);
        for (const [i, c] of active.entries()) {
            process.stdout.write(`[${i + 1}] ${laneOf(c.frontmatter).padEnd(20)} ${shortGoal(c.body)}\n`);
        }
        process.stdout.write('\nRe-run with a lane name or index, e.g. `resume <name>` or `resume 2`.\n');
        return null;
    }
    const n = parseInt(selector, 10);
    if (!Number.isNaN(n) && String(n) === selector) {
        if (n < 1 || n > active.length) {
            process.stdout.write(`Index ${n} out of range. Use \`list\` to see available checkpoints (1..${active.length}).\n`);
            return null;
        }
        return active[n - 1]!;
    }
    // Sanitize the selector so a raw branch name (e.g. "feat/x") matches its lane.
    const lane = sanitizeLaneName(selector);
    const found = active.find(c => laneOf(c.frontmatter) === lane);
    if (!found) {
        process.stdout.write(`No active checkpoint in lane "${lane}". Use \`list\` to see available lanes.\n`);
        return null;
    }
    return found;
}

function printOrientation(ckpt: Checkpoint): void {
    process.stdout.write('=== Checkpoint orientation ===\n');
    process.stdout.write(`File: ${ckpt.path}\n`);
    process.stdout.write(`Lane: ${laneOf(ckpt.frontmatter)}\n`);
    process.stdout.write(`Created: ${ckpt.frontmatter.created_at}\n`);
    if (ckpt.frontmatter.git_branch) process.stdout.write(`Git: ${ckpt.frontmatter.git_branch} @ ${ckpt.frontmatter.git_head ?? '?'}\n`);
    process.stdout.write('\n');
    process.stdout.write(ckpt.body + '\n');
    process.stdout.write('\n=== End checkpoint ===\n');
    // Auto-loop wake re-arming: if the block-reset wake time is still ahead,
    // the checkpoint being resumed manually (e.g. in-session) means whatever
    // wake one-shot was scheduled at save time may no longer exist or may fire
    // into a session that's already active — tell the resuming agent to
    // re-arm explicitly rather than assume the original schedule survived.
    const wakeAt = ckpt.frontmatter.wake_at;
    if (wakeAt && ckpt.frontmatter.wake_prompt) {
        const t = Date.parse(wakeAt);
        if (Number.isFinite(t) && t > Date.now()) {
            process.stdout.write(`\nWake scheduled for ${wakeAt} — if no CronCreate for it is confirmed pending (CronList), re-arm via CronCreate (one-shot) at that time with this prompt:\n${ckpt.frontmatter.wake_prompt}\n`);
        }
    }
}

/** Sanitize a branch name into a filesystem-safe worktree directory segment. */
function sanitizeForPath(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
}

function repoRoot(cwd: string): string | undefined {
    try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return undefined;
    }
}

/**
 * Handle `resume --worktree`: point the caller at a directory to re-enter.
 * Prefers the checkpoint's recorded worktree path if it still exists; else
 * tries to create one for its git branch; else reports why it couldn't.
 */
function handleWorktreeFlag(ckpt: Checkpoint, cwd: string): void {
    const wt = ckpt.frontmatter.worktree;
    if (wt && fs.existsSync(wt)) {
        process.stdout.write(`\nWorktree: ${wt}\n`);
        return;
    }
    const branch = ckpt.frontmatter.git_branch;
    if (!branch) {
        process.stdout.write('\nNo worktree or git branch recorded on this checkpoint — nothing to re-enter.\n');
        return;
    }
    const root = repoRoot(cwd);
    if (!root) {
        process.stdout.write(`\nCould not locate a git repo at ${cwd} to create a worktree for "${branch}".\n`);
        return;
    }
    const target = path.join(root, '.worktrees', sanitizeForPath(branch));
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        execFileSync('git', ['worktree', 'add', target, branch], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        process.stdout.write(`\nWorktree: ${target}\n`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already (checked out|used by worktree)/i.test(message)) {
            process.stdout.write(`\nBranch "${branch}" is already checked out elsewhere; git refused to create a new worktree.\n${message}\n`);
        } else {
            process.stdout.write(`\nCould not create a worktree for "${branch}": ${message}\n`);
        }
    }
}

export function verbPeek(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
    const active = listActive(cwd, cfg.checkpoint_dir_name);
    const ckpt = resolveTarget(args.positional[0], active);
    if (!ckpt) { process.exitCode = active.length === 0 ? 0 : 1; return; }
    printOrientation(ckpt);
}

export function verbResume(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
    const active = listActive(cwd, cfg.checkpoint_dir_name);
    const ckpt = resolveTarget(args.positional[0], active);
    if (!ckpt) { process.exitCode = active.length === 0 ? 0 : (args.positional[0] ? 1 : 0); return; }

    printOrientation(ckpt);

    const sessionId = typeof args.flags['session-id'] === 'string' ? args.flags['session-id'] : undefined;
    const moved = archiveCheckpoint(ckpt, 'resumed', cwd, cfg.checkpoint_dir_name, {
        resumed_at: new Date().toISOString(),
        ...(sessionId ? { resumed_by_session: sessionId } : {})
    });
    if (moved) {
        process.stdout.write(`\nCheckpoint marked resumed and moved to: ${moved}\n`);
    }

    if (args.flags.worktree === true) {
        handleWorktreeFlag(ckpt, cwd);
    }
}

export function verbDiscard(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
    const reason = typeof args.flags.reason === 'string' ? args.flags.reason : '(no reason given)';
    const active = listActive(cwd, cfg.checkpoint_dir_name);
    // Discard has always defaulted to the newest active (index 1) rather than
    // requiring a selector; preserve that when nothing is given.
    const selector = args.positional[0] ?? (active.length > 0 ? '1' : undefined);
    const ckpt = resolveTarget(selector, active);
    if (!ckpt) { process.exitCode = active.length === 0 ? 0 : 1; return; }
    const moved = archiveCheckpoint(ckpt, 'superseded', cwd, cfg.checkpoint_dir_name, { discard_reason: reason });
    process.stdout.write(moved ? `Discarded → ${moved}\n` : 'Discard failed.\n');
}

export function verbCleanup(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): void {
    const apply = args.flags.apply === true;
    const olderThanFlag = typeof args.flags['older-than'] === 'string' ? args.flags['older-than'] as string : null;
    const liveThresholdDays = olderThanFlag ? parseDays(olderThanFlag) : cfg.checkpoint.stale_after_days;
    const archiveThresholdDays = cfg.checkpoint.archive_keep_days;

    const live = listLive(cwd, cfg.checkpoint_dir_name);
    const arc = listArchive(cwd, cfg.checkpoint_dir_name);

    // listLive is sorted newest-first, so the first active seen per lane is
    // that lane's newest — never a stale candidate even past the threshold.
    const newestPerLane = new Set<string>();
    const liveStale = live.filter(c => {
        if (c.frontmatter.status !== 'active') return false;
        const lane = laneOf(c.frontmatter);
        if (!newestPerLane.has(lane)) {
            newestPerLane.add(lane);
            return false;
        }
        return ageDays(c) > liveThresholdDays;
    });
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

/** [G3] `handoffs list` / `handoffs write <agent_id>` / `handoffs archive <agent_id>`
 * — thin wrappers over agent-budget.ts so the model never does raw `mv` on
 * the handoff registry. */
function verbHandoffs(args: Args, cwd: string, cfg: ReturnType<typeof loadConfig>): Promise<void> | void {
    const sub = args.positional[0];
    if (sub === 'list') {
        const items = listHandoffs(cwd, cfg.checkpoint_dir_name);
        if (items.length === 0) {
            process.stdout.write('No pending handoffs.\n');
            return;
        }
        for (const h of items) {
            process.stdout.write(`${h.frontmatter.agent_id}  ${h.frontmatter.agent_type ?? '?'}  ${h.frontmatter.trigger}  ${h.frontmatter.created_at}  ${path.basename(h.path)}\n`);
        }
        return;
    }
    if (sub === 'write') {
        const agentId = args.positional[1];
        if (!agentId) {
            process.stdout.write('Usage: pacekeeper-checkpoint handoffs write <agent_id> [--body <text> | --body-file <path>] [--trigger <kind>] [--agent-type <type>]\n');
            process.exitCode = 1;
            return;
        }
        const agentType = typeof args.flags['agent-type'] === 'string' ? args.flags['agent-type'] : undefined;
        const trigger = typeof args.flags.trigger === 'string' ? args.flags.trigger : 'budget_pause';
        return (async () => {
            const bodyFromFlag = typeof args.flags.body === 'string' ? args.flags.body : null;
            const bodyFromFile = typeof args.flags['body-file'] === 'string' ? fs.readFileSync(args.flags['body-file'] as string, 'utf8') : null;
            let body = bodyFromFlag ?? bodyFromFile;
            if (body === null && !process.stdin.isTTY) {
                const stdin = await readAllStdin();
                if (stdin.trim() !== '') body = stdin;
            }
            if (body === null || body.trim() === '') {
                process.stdout.write('## Goal\n<what this agent was doing>\n\n## Done\n<completed so far>\n\n## Next\n<remaining work>\n\n## Files touched\n- <path>\n');
                process.exitCode = 2;
                return;
            }
            const written = writeHandoff({ cwd, checkpointDirName: cfg.checkpoint_dir_name, agentId, agentType, trigger, body });
            process.stdout.write(`Wrote handoff: ${written}\n`);
        })();
    }
    if (sub === 'archive') {
        const agentId = args.positional[1];
        if (!agentId) {
            process.stdout.write('Usage: pacekeeper-checkpoint handoffs archive <agent_id>\n');
            process.exitCode = 1;
            return;
        }
        const moved = archiveHandoff(cwd, cfg.checkpoint_dir_name, agentId);
        process.stdout.write(moved ? `Archived → ${moved}\n` : `No pending handoff for agent_id "${agentId}".\n`);
        return;
    }
    process.stdout.write('Usage: pacekeeper-checkpoint handoffs <list|write|archive> ...\n');
    process.exitCode = 1;
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
        'All verbs accept --cwd <path> to pin the project root explicitly. When',
        'omitted, the root is resolved from --transcript-path, then the git repo',
        'root, then the process cwd; transient dirs (/tmp, $HOME, /) are refused.',
        '',
        'Checkpoints are organized into named "lanes" — parallel active checkpoints',
        'that don\'t supersede each other. A lane defaults to the sanitized current',
        'git branch name (or "default" outside a repo / detached HEAD).',
        '',
        'Verbs:',
        '  save [--body <text> | --body-file <path>] [--trigger <kind>] [--name <slug>]',
        '       [--session-id <id>] [--transcript-path <path>] [--cwd <path>]',
        '       [--wake-at <iso>] [--wake-prompt <text>]',
        '       Write a new active checkpoint in the given lane (default: current',
        '       branch, sanitized). Only prior actives in the SAME lane are',
        '       superseded. Body may also be piped on stdin. If no body is',
        '       provided, emits a template and exits 2. --wake-at/--wake-prompt',
        '       record when + with what prompt the auto-loop scheduled a wake.',
        '',
        '  resume [name|N] [--session-id <id>] [--worktree]',
        '                        Show a checkpoint by lane name or list index, archive it as',
        '                        resumed. Bare `resume` resumes the sole active lane, or lists',
        '                        all active lanes and asks you to pick if there are several',
        '                        (nothing is archived in that case). --worktree prints (or',
        '                        creates) a worktree directory to re-enter afterward.',
        '  peek <name|N>         Print a checkpoint\'s body without archiving or mutating it.',
        '  list [--archived]     List live (or archived) checkpoints: index, lane, branch,',
        '                        worktree, age, and first Goal line.',
        '  discard [name|N] [--reason <text>]  Move an active checkpoint to archive without resuming.',
        '  cleanup [--older-than Nd] [--apply]',
        '                        Show stale live files + expired archive files, lane-aware —',
        '                        the newest checkpoint in each lane is never marked stale.',
        '                        Dry-run by default.',
        '',
        '  handoffs list         List pending subagent budget-pause handoffs.',
        '  handoffs write <agent_id> [--body <text> | --body-file <path>] [--trigger <kind>] [--agent-type <type>]',
        '                        Write (or overwrite) a handoff file for a paused subagent.',
        '  handoffs archive <agent_id>',
        '                        Move a handoff to handoffs/archive/ once its work is absorbed.',
        '',
        '  doctor [--network] [--transcript <path>]',
        '                        Check the plugin\'s environment: runtime, credentials,',
        '                        usage cache, config validity, window override, state dirs.',
        '',
        '  help                  Show this message.',
        ''
    ].join('\n'));
}

async function main(): Promise<void> {
    bootstrapConfigIfMissing();
    const cfg = loadConfig();
    const args = parseArgs(process.argv.slice(2));

    // `help` needs no project root; resolving it (and possibly throwing on an
    // unsafe dir) before printing usage would be unhelpful.
    if (args.verb === 'help' || args.verb === '--help' || args.verb === '-h') {
        verbHelp();
        return;
    }

    if (args.verb === 'doctor') {
        const checks = await runDoctor({ network: args.flags.network === true, transcript: typeof args.flags.transcript === 'string' ? args.flags.transcript : undefined });
        process.stdout.write(formatDoctorReport(checks) + '\n');
        process.exitCode = checks.some(c => c.severity === 'fail') ? 1 : 0;
        return;
    }

    // Anchor the checkpoint dir to the real project root — independent of the
    // shell/tmux/cd the CLI was launched from. Throws (caught below) if only a
    // transient dir like /tmp is available.
    const cwd = resolveProjectRoot({
        cwdFlag: typeof args.flags.cwd === 'string' ? args.flags.cwd : undefined,
        transcriptPath: typeof args.flags['transcript-path'] === 'string' ? args.flags['transcript-path'] : undefined,
        processCwd: process.cwd()
    });

    switch (args.verb) {
        case 'save': await verbSave(args, cwd, cfg); return;
        case 'resume': verbResume(args, cwd, cfg); return;
        case 'peek': verbPeek(args, cwd, cfg); return;
        case 'list': verbList(args, cwd, cfg); return;
        case 'discard': verbDiscard(args, cwd, cfg); return;
        case 'cleanup': verbCleanup(args, cwd, cfg); return;
        case 'handoffs': await verbHandoffs(args, cwd, cfg); return;
        default:
            process.stdout.write(`Unknown verb: ${args.verb}\n\n`);
            verbHelp();
            process.exitCode = 1;
    }
}

// Guarded so tests can import verb functions without triggering a live run.
if (import.meta.main) {
    main().catch((err) => {
        process.stderr.write(`pacekeeper-checkpoint error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
    });
}
