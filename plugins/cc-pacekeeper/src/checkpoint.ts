import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type CheckpointStatus = 'active' | 'resumed' | 'superseded' | 'stale';

export interface CheckpointFrontmatter {
    status: CheckpointStatus;
    created_at: string;
    /** Lane this checkpoint belongs to — see resolveLaneName(). */
    name?: string;
    session_id?: string;
    trigger?: string;
    meters?: Record<string, unknown>;
    project_root?: string;
    git_branch?: string;
    git_head?: string;
    /** Working directory of the linked worktree this was saved from, if any. */
    worktree?: string;
    files_touched?: string[];
    discard_reason?: string;
    /** True when this save changed the lane's Goal with --goal-changed (see laneGoalAnchor). */
    goal_changed?: boolean;
    resumed_at?: string;
    resumed_by_session?: string;
    /** ISO time the auto-loop scheduled a wake one-shot for (block reset + wake_delay_min). */
    wake_at?: string;
    /** Prompt text (starting with RESUME_MARKER) the wake one-shot should re-arm with. */
    wake_prompt?: string;
}

export interface Checkpoint {
    path: string;
    frontmatter: CheckpointFrontmatter;
    body: string;
    mtimeMs: number;
}

export interface CheckpointSaveInput {
    cwd: string;
    checkpointDirName: string;
    frontmatter: Omit<CheckpointFrontmatter, 'created_at' | 'status'> & {
        created_at?: string;
        status?: CheckpointStatus;
    };
    body: string;
}

function checkpointDir(cwd: string, checkpointDirName: string): string {
    return path.join(cwd, checkpointDirName);
}

function archiveDir(cwd: string, checkpointDirName: string): string {
    return path.join(checkpointDir(cwd, checkpointDirName), 'archive');
}

function isoTimestampForFilename(d: Date = new Date()): string {
    // 2026-06-17T15-42-11Z — colons replaced for filesystem safety.
    return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Tiny YAML emitter — covers the subset we use (strings, numbers, booleans,
 * arrays of strings, nested objects one level deep). We avoid pulling a full
 * YAML lib for this; the format is fully ours to produce.
 */
function emitYaml(obj: Record<string, unknown>, indent = ''): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) continue;
        if (value === null) {
            lines.push(`${indent}${key}: null`);
        } else if (typeof value === 'string') {
            // Quote if contains : or starts with special chars; otherwise emit bare.
            const needsQuoting = /[:#&*!|>%@`,{}[\]]/.test(value) || /^\s|\s$/.test(value);
            lines.push(`${indent}${key}: ${needsQuoting ? JSON.stringify(value) : value}`);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            lines.push(`${indent}${key}: ${String(value)}`);
        } else if (Array.isArray(value)) {
            if (value.length === 0) {
                lines.push(`${indent}${key}: []`);
            } else {
                lines.push(`${indent}${key}:`);
                for (const item of value) {
                    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
                        const s = typeof item === 'string'
                            ? (/[:#&*!|>%@`,{}[\]]/.test(item) ? JSON.stringify(item) : item)
                            : String(item);
                        lines.push(`${indent}  - ${s}`);
                    } else if (typeof item === 'object' && item !== null) {
                        lines.push(`${indent}  -`);
                        lines.push(emitYaml(item as Record<string, unknown>, indent + '    '));
                    }
                }
            }
        } else if (typeof value === 'object') {
            lines.push(`${indent}${key}:`);
            lines.push(emitYaml(value as Record<string, unknown>, indent + '  '));
        }
    }
    return lines.join('\n');
}

/**
 * Minimal YAML parser for the frontmatter shape we emit. NOT a general YAML
 * parser. Handles: scalars (string/number/boolean), arrays of scalars,
 * nested objects one level deep, double-quoted strings.
 */
function parseYaml(yaml: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const lines = yaml.split('\n');
    let i = 0;
    const parseScalar = (raw: string): unknown => {
        const trimmed = raw.trim();
        if (trimmed === 'true') return true;
        if (trimmed === 'false') return false;
        if (trimmed === 'null') return null;
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
        }
        return trimmed;
    };
    while (i < lines.length) {
        const line = lines[i] ?? '';
        if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
        const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
        if (!m) { i++; continue; }
        const [, key = '', rest = ''] = m;
        if (rest.trim() === '') {
            // Object or array follows on indented lines
            const childLines: string[] = [];
            let j = i + 1;
            const isArrayItem = (l: string): boolean => /^\s+-\s/.test(l);
            let mode: 'object' | 'array' | null = null;
            while (j < lines.length) {
                const l = lines[j] ?? '';
                if (l.trim() === '') { j++; continue; }
                if (!/^\s/.test(l)) break;
                if (mode === null) mode = isArrayItem(l) ? 'array' : 'object';
                childLines.push(l);
                j++;
            }
            if (mode === 'array') {
                const arr: unknown[] = [];
                for (const cl of childLines) {
                    const am = /^\s+-\s+(.*)$/.exec(cl);
                    if (am) arr.push(parseScalar(am[1] ?? ''));
                }
                out[key] = arr;
            } else if (mode === 'object') {
                const dedented = childLines.map(l => l.replace(/^\s{2}/, '')).join('\n');
                out[key] = parseYaml(dedented);
            } else {
                // `key:` with nothing after it and no indented children is an
                // empty scalar. (`{}` here made `session_id?: string` a lie for
                // blank values and broke `=== undefined` guards downstream.)
                out[key] = '';
            }
            i = j;
        } else {
            out[key] = parseScalar(rest);
            i++;
        }
    }
    return out;
}

function buildFile(fm: CheckpointFrontmatter, body: string): string {
    return `---\n${emitYaml(fm as unknown as Record<string, unknown>)}\n---\n\n${body.trimEnd()}\n`;
}

const DEFAULT_LANE = 'default';

/**
 * Sanitize a raw name (branch or explicit --name) into a lane slug: lowercase,
 * any run of non [a-z0-9] chars collapsed to a single '-', leading/trailing
 * '-' trimmed. Falls back to DEFAULT_LANE if that leaves nothing usable.
 */
export function sanitizeLaneName(raw: string): string {
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || DEFAULT_LANE;
}

/**
 * Resolve the lane name for a save: explicit --name wins, else the current
 * git branch (sanitized), else DEFAULT_LANE (detached HEAD or non-repo).
 */
export function resolveLaneName(explicitName: string | undefined, cwd: string): string {
    if (explicitName) return sanitizeLaneName(explicitName);
    const branch = gitInfo(cwd).branch;
    if (branch && branch !== 'HEAD') return sanitizeLaneName(branch);
    return DEFAULT_LANE;
}

/**
 * Lane for a checkpoint that may predate the `name` field: use frontmatter
 * `name` if present, else derive from `git_branch`, else DEFAULT_LANE. Never
 * throws — legacy files without either field just land in the default lane.
 */
export function laneOf(fm: CheckpointFrontmatter): string {
    if (fm.name) return sanitizeLaneName(fm.name);
    if (fm.git_branch) return sanitizeLaneName(fm.git_branch);
    return DEFAULT_LANE;
}

function gitInfo(cwd: string): { branch?: string; head?: string } {
    const exec = (args: string[]): string | undefined => {
        try {
            return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
            return undefined;
        }
    };
    return {
        branch: exec(['rev-parse', '--abbrev-ref', 'HEAD']),
        head: exec(['rev-parse', '--short', 'HEAD'])
    };
}

export function saveCheckpoint(input: CheckpointSaveInput): { path: string; supersededPaths: string[] } {
    const dir = checkpointDir(input.cwd, input.checkpointDirName);
    ensureDir(dir);

    const lane = resolveLaneName(input.frontmatter.name, input.cwd);

    // Demote prior actives in THIS lane only to superseded — other lanes untouched.
    const supersededPaths: string[] = [];
    const existing = listLive(input.cwd, input.checkpointDirName);
    for (const ckpt of existing) {
        if (ckpt.frontmatter.status === 'active' && laneOf(ckpt.frontmatter) === lane) {
            const moved = archiveCheckpoint(ckpt, 'superseded', input.cwd, input.checkpointDirName);
            if (moved) supersededPaths.push(moved);
        }
    }

    const git = gitInfo(input.cwd);
    const status: CheckpointStatus = input.frontmatter.status ?? 'active';
    const createdAt: string = input.frontmatter.created_at ?? new Date().toISOString();
    const projectRoot: string = input.frontmatter.project_root ?? input.cwd;
    const gitBranch = input.frontmatter.git_branch ?? git.branch;
    const gitHead = input.frontmatter.git_head ?? git.head;

    const fm: CheckpointFrontmatter = {
        ...input.frontmatter,
        status,
        created_at: createdAt,
        name: lane,
        project_root: projectRoot,
        ...(gitBranch !== undefined ? { git_branch: gitBranch } : {}),
        ...(gitHead !== undefined ? { git_head: gitHead } : {})
    };

    let filename = `${lane}-${isoTimestampForFilename(new Date(fm.created_at))}.md`;
    let target = path.join(dir, filename);
    let n = 1;
    while (fs.existsSync(target)) {
        filename = `${lane}-${isoTimestampForFilename(new Date(fm.created_at))}-${n}.md`;
        target = path.join(dir, filename);
        n++;
    }
    fs.writeFileSync(target, buildFile(fm, input.body));
    return { path: target, supersededPaths };
}

export function readCheckpoint(filePath: string): Checkpoint | null {
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    if (!m) return null;
    const fmObj = parseYaml(m[1] ?? '');
    const fm = fmObj as unknown as CheckpointFrontmatter;
    if (!fm.status || !fm.created_at) return null;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    return { path: filePath, frontmatter: fm, body: (m[2] ?? '').trim(), mtimeMs };
}

function listDirCheckpoints(dir: string): Checkpoint[] {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const out: Checkpoint[] = [];
    for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const ckpt = readCheckpoint(path.join(dir, e.name));
        if (ckpt) out.push(ckpt);
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function listLive(cwd: string, checkpointDirName: string): Checkpoint[] {
    return listDirCheckpoints(checkpointDir(cwd, checkpointDirName));
}

export function listArchive(cwd: string, checkpointDirName: string): Checkpoint[] {
    return listDirCheckpoints(archiveDir(cwd, checkpointDirName));
}

export function listActive(cwd: string, checkpointDirName: string): Checkpoint[] {
    return listLive(cwd, checkpointDirName).filter(c => c.frontmatter.status === 'active');
}

/**
 * Newest checkpoint created — or resumed — at or after `sinceMs` BY
 * `sessionId`, live or archived, any status. Used to re-orient after an
 * in-session compaction: a checkpoint that was already resumed (archived)
 * this session is still the best record of the goal — status is about the
 * registry, not about relevance. Recency counts `resumed_at` as well as
 * `created_at` (the same rule as laneGoalAnchor): yesterday's checkpoint
 * picked up this morning is this session's record, and goal lock refuses to
 * re-save it under a paraphrased goal, so nothing newer may exist.
 * A checkpoint stamped with another session's id is skipped
 * (concurrent sessions share a project); one saved without `--session-id`
 * cannot be attributed away, so it is kept. An explicitly discarded
 * checkpoint is never "the record".
 */
export function newestSince(
    cwd: string,
    checkpointDirName: string,
    sinceMs: number,
    sessionId: string
): Checkpoint | null {
    const stamp = (c: Checkpoint): number => Math.max(
        Date.parse(c.frontmatter.created_at) || 0,
        c.frontmatter.resumed_at ? (Date.parse(c.frontmatter.resumed_at) || 0) : 0
    );
    // Every checkpoint saved while the skill named a nonexistent env var got a
    // blank `session_id:` line, and any `--session-id ""` still would. Blank
    // means unstamped, not someone else's.
    const mine = (c: Checkpoint): boolean => {
        const sid = c.frontmatter.session_id;
        return typeof sid !== 'string' || sid === '' || sid === sessionId;
    };
    const candidates = [...listLive(cwd, checkpointDirName), ...listArchive(cwd, checkpointDirName)]
        .filter(c => stamp(c) > 0 && stamp(c) >= sinceMs && c.frontmatter.discard_reason === undefined)
        .sort((a, b) => stamp(b) - stamp(a));
    // This session's own save wins; with none, the newest candidate is still
    // better than nothing — `claude --continue` can hand the Bash tool the
    // startup id while the hooks report the resumed one, and a stamp mismatch
    // must not cost the session its orientation.
    return candidates.find(mine) ?? candidates[0] ?? null;
}

/** Full text of the `## Goal` section (trimmed), or null if absent or empty. */
export function goalSection(body: string): string | null {
    const m = /(^|\n)## Goal[ \t]*\n([\s\S]*?)(?=\n## |\n*$)/.exec(body);
    const goal = (m?.[2] ?? '').trim();
    return goal === '' ? null : goal;
}

/** Whitespace-insensitive form for comparing goals: re-wrapping is not a change. */
export function normalizeGoal(goal: string): string {
    return goal.replace(/\s+/g, ' ').trim();
}

/**
 * The lane's goal anchor: the newest checkpoint in `lane`, live or archived,
 * whose status is active or resumed, that has a Goal section, and that was
 * created or resumed within `maxAgeDays`. Superseded and stale ones never
 * anchor (superseded = replaced by a newer save; stale = the lane went quiet).
 * Recency counts resumed_at as well as created_at: an old checkpoint picked
 * up today is today's goal. Null means the lane has no goal to carry forward.
 */
export function laneGoalAnchor(
    cwd: string,
    checkpointDirName: string,
    lane: string,
    maxAgeDays: number,
    now: number = Date.now()
): Checkpoint | null {
    const stamp = (c: Checkpoint): number => Math.max(
        Date.parse(c.frontmatter.created_at) || 0,
        c.frontmatter.resumed_at ? (Date.parse(c.frontmatter.resumed_at) || 0) : 0
    );
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    return [...listLive(cwd, checkpointDirName), ...listArchive(cwd, checkpointDirName)]
        .filter(c => laneOf(c.frontmatter) === lane)
        .filter(c => c.frontmatter.status === 'active' || c.frontmatter.status === 'resumed')
        .filter(c => goalSection(c.body) !== null)
        .filter(c => stamp(c) > 0 && now - stamp(c) <= maxAgeMs)
        .sort((a, b) => stamp(b) - stamp(a))[0] ?? null;
}

/**
 * Move a checkpoint into archive/, updating its status frontmatter.
 * Returns the new path, or null on failure.
 */
export function archiveCheckpoint(
    ckpt: Checkpoint,
    newStatus: Exclude<CheckpointStatus, 'active'>,
    cwd: string,
    checkpointDirName: string,
    extraFrontmatter?: Record<string, unknown>
): string | null {
    const arc = archiveDir(cwd, checkpointDirName);
    ensureDir(arc);
    const updated: CheckpointFrontmatter = {
        ...ckpt.frontmatter,
        ...extraFrontmatter,
        status: newStatus
    };
    let dest = path.join(arc, path.basename(ckpt.path));
    let n = 1;
    while (fs.existsSync(dest)) {
        const base = path.basename(ckpt.path, '.md');
        dest = path.join(arc, `${base}-${n}.md`);
        n++;
    }
    try {
        fs.writeFileSync(dest, buildFile(updated, ckpt.body));
        fs.unlinkSync(ckpt.path);
        return dest;
    } catch {
        return null;
    }
}

export function ageDays(ckpt: Checkpoint, now: Date = new Date()): number {
    const created = Date.parse(ckpt.frontmatter.created_at);
    if (Number.isNaN(created)) return 0;
    return (now.getTime() - created) / (24 * 60 * 60 * 1000);
}
