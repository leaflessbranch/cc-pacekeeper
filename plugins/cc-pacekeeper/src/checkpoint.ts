import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type CheckpointStatus = 'active' | 'resumed' | 'superseded' | 'stale';

export interface CheckpointFrontmatter {
    status: CheckpointStatus;
    created_at: string;
    session_id?: string;
    trigger?: string;
    meters?: Record<string, unknown>;
    project_root?: string;
    git_branch?: string;
    git_head?: string;
    files_touched?: string[];
    discard_reason?: string;
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
                out[key] = {};
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

    // Demote any existing active checkpoints to superseded.
    const supersededPaths: string[] = [];
    const existing = listLive(input.cwd, input.checkpointDirName);
    for (const ckpt of existing) {
        if (ckpt.frontmatter.status === 'active') {
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
        project_root: projectRoot,
        ...(gitBranch !== undefined ? { git_branch: gitBranch } : {}),
        ...(gitHead !== undefined ? { git_head: gitHead } : {})
    };

    let filename = `${isoTimestampForFilename(new Date(fm.created_at))}.md`;
    let target = path.join(dir, filename);
    let n = 1;
    while (fs.existsSync(target)) {
        filename = `${isoTimestampForFilename(new Date(fm.created_at))}-${n}.md`;
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
