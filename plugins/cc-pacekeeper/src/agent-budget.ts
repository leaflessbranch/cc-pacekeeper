import * as fs from 'fs';
import * as path from 'path';
import type { Config } from './config';
import type { Snapshot } from './thresholds';
import { formatStatusLine } from './thresholds';

/**
 * Subagent budget-pause protocol + handoff file registry.
 *
 * Subagent trees (up to ~5 layers deep) burn the 5h block invisibly — they
 * never see meters, so exhaustion kills in-flight work with no recovery path
 * beyond grepping transcripts. This module gives spawned agents a contract:
 * work until an effective-pause threshold, then write a handoff file and
 * return `PAUSED-BUDGET` instead of running the block (or their own context)
 * to zero.
 *
 * The files ARE the registry — mirrors listActive()/archiveCheckpoint() in
 * checkpoint.ts. No separate index to go stale.
 */

export const RESUME_MARKER = '[pacekeeper-resume]';

/**
 * Absolute path to the checkpoint CLI for embedding in subagent-facing text.
 * The `pacekeeper-checkpoint` PATH shim is not visible inside a subagent's
 * Bash (verified live in a headless session), so a contract that names the
 * bare command sends the agent hunting the filesystem for it — which the
 * permission classifier then denies as suspicious. Hooks always run with
 * CLAUDE_PLUGIN_ROOT set; fall back to the bare name only outside hooks.
 */
export function checkpointCliPath(): string {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    return root ? path.join(root, 'bin', 'pacekeeper-checkpoint') : 'pacekeeper-checkpoint';
}

export interface HandoffFrontmatter {
    agent_id: string;
    agent_type?: string;
    created_at: string;
    trigger: string;
}

export interface Handoff {
    path: string;
    frontmatter: HandoffFrontmatter;
    body: string;
    mtimeMs: number;
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function handoffsDir(cwd: string, checkpointDirName: string): string {
    return path.join(cwd, checkpointDirName, 'handoffs');
}

function handoffsArchiveDir(cwd: string, checkpointDirName: string): string {
    return path.join(handoffsDir(cwd, checkpointDirName), 'archive');
}

function handoffPath(cwd: string, checkpointDirName: string, agentId: string): string {
    return path.join(handoffsDir(cwd, checkpointDirName), `${agentId}.md`);
}

/** Tiny frontmatter emitter matching checkpoint.ts's scalar-only subset used here. */
function emitFrontmatter(fm: HandoffFrontmatter): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(fm)) {
        if (value === undefined) continue;
        const needsQuoting = typeof value === 'string' && (/[:#&*!|>%@`,{}[\]]/.test(value) || /^\s|\s$/.test(value));
        lines.push(`${key}: ${needsQuoting ? JSON.stringify(value) : String(value)}`);
    }
    return lines.join('\n');
}

function parseFrontmatterScalars(yaml: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of yaml.split('\n')) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
        if (!m) continue;
        const [, key = '', rest = ''] = m;
        const trimmed = rest.trim();
        out[key] = trimmed.startsWith('"') && trimmed.endsWith('"')
            ? (() => { try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); } })()
            : trimmed;
    }
    return out;
}

export interface WriteHandoffInput {
    cwd: string;
    checkpointDirName: string;
    agentId: string;
    agentType?: string;
    trigger: string;
    body: string;
}

/** Write (or overwrite) a handoff file for a paused agent. */
export function writeHandoff(input: WriteHandoffInput): string {
    const dir = handoffsDir(input.cwd, input.checkpointDirName);
    ensureDir(dir);
    const fm: HandoffFrontmatter = {
        agent_id: input.agentId,
        ...(input.agentType ? { agent_type: input.agentType } : {}),
        created_at: new Date().toISOString(),
        trigger: input.trigger
    };
    const target = handoffPath(input.cwd, input.checkpointDirName, input.agentId);
    fs.writeFileSync(target, `---\n${emitFrontmatter(fm)}\n---\n\n${input.body.trimEnd()}\n`);
    return target;
}

function readHandoff(filePath: string): Handoff | null {
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    if (!m) return null;
    const scalars = parseFrontmatterScalars(m[1] ?? '');
    if (!scalars.agent_id || !scalars.created_at) return null;
    const fm: HandoffFrontmatter = {
        agent_id: scalars.agent_id,
        created_at: scalars.created_at,
        trigger: scalars.trigger ?? 'unknown',
        ...(scalars.agent_type ? { agent_type: scalars.agent_type } : {})
    };
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    return { path: filePath, frontmatter: fm, body: (m[2] ?? '').trim(), mtimeMs };
}

function listDirHandoffs(dir: string): Handoff[] {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const out: Handoff[] = [];
    for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const h = readHandoff(path.join(dir, e.name));
        if (h) out.push(h);
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** List pending (not yet archived) handoffs, newest first. */
export function listHandoffs(cwd: string, checkpointDirName: string): Handoff[] {
    return listDirHandoffs(handoffsDir(cwd, checkpointDirName));
}

/** Whether a pending handoff exists for a given agent id. */
export function hasHandoff(cwd: string, checkpointDirName: string, agentId: string): boolean {
    return fs.existsSync(handoffPath(cwd, checkpointDirName, agentId));
}

/**
 * Move a handoff into handoffs/archive/ once its work has been absorbed
 * (re-dispatched or explicitly dropped). Returns the new path, or null if no
 * pending handoff exists for that agent id or the move failed.
 */
export function archiveHandoff(cwd: string, checkpointDirName: string, agentId: string): string | null {
    const src = handoffPath(cwd, checkpointDirName, agentId);
    if (!fs.existsSync(src)) return null;
    const arc = handoffsArchiveDir(cwd, checkpointDirName);
    ensureDir(arc);
    let dest = path.join(arc, `${agentId}.md`);
    let n = 1;
    while (fs.existsSync(dest)) {
        dest = path.join(arc, `${agentId}-${n}.md`);
        n++;
    }
    try {
        fs.renameSync(src, dest);
        return dest;
    } catch {
        return null;
    }
}

/**
 * [G2] Spawn-relative pause point: an agent spawned late in the block (e.g. at
 * 80%) still gets working room, instead of a dead-on-arrival spawn at a fixed
 * threshold it's already past. Capped at five_hour_pct so it never exceeds the
 * point the main loop itself treats as block-exhausted.
 */
export function effectivePause(cfg: Config, blockPctAtStart: number): number {
    const raw = Math.max(cfg.auto.subagent_pause_pct, blockPctAtStart + 5);
    return Math.min(raw, cfg.auto.five_hour_pct);
}

/**
 * SubagentStart injection: the budget contract for a freshly spawned agent.
 * Bakes in the concrete effective-pause number (see effectivePause) so the
 * agent doesn't have to compute it, and carries the [G1] cascade clause so a
 * paused child's remaining work is recorded rather than silently re-attempted.
 */
export function formatSubagentContract(
    snap: Snapshot,
    cfg: Config,
    agentId: string,
    agentType: string | undefined,
    blockPctAtStart: number
): string {
    const pause = effectivePause(cfg, blockPctAtStart);
    const status = formatStatusLine(snap);
    return [
        status,
        '',
        `[pacekeeper] Budget contract for this subagent (agent_id ${agentId}${agentType ? `, type ${agentType}` : ''}):`,
        `Pause at ${pause.toFixed(0)}% of the 5-hour block (spawned at ~${blockPctAtStart.toFixed(0)}%), or immediately if any meter reaches critical.`,
        `At that point: finish the current small step (do not start a new one), then write a handoff file via ` +
            `\`${checkpointCliPath()} handoffs write ${agentId} --agent-type <your type>\` (use that exact path — do not search the filesystem for the command; ` +
            `pipe ONLY the body on stdin, sections Goal/Done/Next/Files touched — frontmatter is added automatically, do not write your own), ` +
            `and return immediately with the literal text ` +
            `PAUSED-BUDGET ${agentId} as (or in) your final message.`,
        `If you dispatch child agents, they receive their own contract automatically — do not relay this text to them.`,
        `Cascade clause: if a child agent returns PAUSED-BUDGET, do not re-dispatch it or attempt its work yourself — ` +
            `record it in your own handoff's Next section, finish only trivial remaining steps, then pause too ` +
            `(write your own handoff, return PAUSED-BUDGET).`
    ].join('\n');
}

/**
 * Escalation directive shown on later subagent ticks once the pause point (or
 * a critical meter) has actually been reached — replaces the main-thread
 * checkpoint directive inside a subagent, since subagents can't save
 * checkpoints or ask the user.
 */
export function formatPauseDirective(snap: Snapshot, agentId: string, pausePct: number): string {
    const status = formatStatusLine(snap);
    return [
        status,
        '',
        `🛑 Subagent budget pause point reached (${pausePct.toFixed(0)}%). Finish only the current small step, ` +
            `then write a handoff via \`${checkpointCliPath()} handoffs write ${agentId}\` (use that exact path — ` +
            `do not search the filesystem for the command) and return ` +
            `PAUSED-BUDGET ${agentId} as your final message. Do not start new work.`
    ].join('\n');
}
