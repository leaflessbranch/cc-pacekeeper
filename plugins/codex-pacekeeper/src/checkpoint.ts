/**
 * Codex-owned checkpoints.
 *
 * The two harnesses share a project's checkpoint directory, so Codex writes
 * only inside its own subtree and never a loose file in the shared root. A
 * Claude lane of the same name is therefore invisible here: it cannot be read,
 * superseded or archived by any operation in this module.
 *
 * Selection is always by exact checkpoint id. "Latest" is not a selector —
 * after a crash the latest file may be one that was already consumed, and
 * replaying it would redo finished work.
 */
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CodexConfig } from './config';

export interface CheckpointOwner {
  accountId: string | null;
  threadId: string;
  agentId?: string;
}

function realOrResolve(target: string): string {
  const resolved = path.resolve(target);
  let base = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(base)) {
    const parent = path.dirname(base);
    if (parent === base) return resolved;
    missing.unshift(path.basename(base));
    base = parent;
  }
  try {
    return path.join(fs.realpathSync(base), ...missing);
  } catch {
    return resolved;
  }
}

/**
 * Refuse roots that are transient or too broad to be a project. This mirrors
 * the shipped Claude rule deliberately: a checkpoint written to a tmp root
 * disappears exactly when it is needed most.
 */
export function isUnsafeCheckpointRoot(dir: string): boolean {
  const resolved = realOrResolve(dir);
  for (const tmp of [os.tmpdir(), '/tmp'].map(realOrResolve)) {
    if (resolved === tmp || resolved.startsWith(tmp + path.sep)) return true;
  }
  return [os.homedir(), path.parse(resolved).root].map(realOrResolve).includes(resolved);
}

/** Reduce a branch or lane name to a single safe path segment. */
export function sanitizeLane(lane: string): string {
  const cleaned = lane.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned === '' ? 'default' : cleaned;
}

export interface SaveInput {
  lane: string;
  owner: CheckpointOwner;
  body: string;
  /** Reset generation this checkpoint belongs to, when it is for a wake. */
  resetGeneration?: number;
}

export interface SavedCheckpoint {
  id: string;
  lane: string;
  file: string;
}

export interface CheckpointEntry {
  id: string;
  lane: string;
  file: string;
  owner: CheckpointOwner;
  savedAtMs: number;
  body: string;
}

export type ResumeResult =
  | { status: 'resumed'; id: string; lane: string; body: string }
  | { status: 'not-found' | 'already-consumed' }
  | { status: 'ambiguous'; lanes: string[] };

function frontmatterValue(raw: string, key: string): string | null {
  const match = new RegExp(`^${key}: (.*)$`, 'm').exec(raw);
  return match?.[1]?.trim() ?? null;
}

export interface CheckpointOptions {
  /**
   * Root-safety predicate. Production always uses the default, which refuses
   * transient and over-broad roots. It is injectable ONLY so a test suite whose
   * own checkout lives in a transient directory can supply an equivalent
   * predicate for its fixtures; overriding it in production would defeat the
   * rule this module exists to enforce.
   */
  isUnsafeRoot?: (dir: string) => boolean;
}

export class CodexCheckpoints {
  private readonly activeDir: string;
  private readonly archiveDir: string;

  public constructor(
    projectRoot: string,
    private readonly config: CodexConfig,
    options: CheckpointOptions = {}
  ) {
    const unsafe = options.isUnsafeRoot ?? isUnsafeCheckpointRoot;
    if (unsafe(projectRoot)) {
      throw new Error(`refusing to write checkpoints into an unsafe root: ${projectRoot}`);
    }
    const base = path.join(projectRoot, config.checkpoint_dir_name, config.checkpoint_subdir);
    this.activeDir = base;
    this.archiveDir = path.join(base, 'archive');
  }

  public save(input: SaveInput): SavedCheckpoint {
    const lane = sanitizeLane(input.lane);
    // The id is unique per save, so a superseded checkpoint and its replacement
    // are never confused after a crash.
    const id = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16);
    const savedAtMs = Date.now();
    fs.mkdirSync(this.activeDir, { recursive: true });

    const frontmatter = [
      '---',
      'harness: codex',
      `id: ${id}`,
      `lane: ${lane}`,
      `thread: ${input.owner.threadId}`,
      `account: ${input.owner.accountId ?? 'unknown'}`,
      ...(input.owner.agentId !== undefined ? [`agent: ${input.owner.agentId}`] : []),
      ...(input.resetGeneration !== undefined ? [`reset_generation: ${input.resetGeneration}`] : []),
      `saved_at_ms: ${savedAtMs}`,
      '---',
      ''
    ].join('\n');

    const file = path.join(this.activeDir, `${lane}.md`);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, frontmatter + input.body, 'utf8');
    fs.renameSync(temp, file);

    // Verify the persisted content before reporting success: a hook directive
    // is not a saved checkpoint, and neither is an unread write.
    const persisted = fs.readFileSync(file, 'utf8');
    if (!persisted.includes(`id: ${id}`) || !persisted.includes(input.body)) {
      throw new Error('checkpoint did not persist as written');
    }
    return { id, lane, file };
  }

  private readDir(dir: string): CheckpointEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const entries: CheckpointEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(dir, name);
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const id = frontmatterValue(raw, 'id');
      const lane = frontmatterValue(raw, 'lane');
      if (id === null || lane === null) continue;
      const account = frontmatterValue(raw, 'account');
      const agentId = frontmatterValue(raw, 'agent');
      entries.push({
        id,
        lane,
        file,
        owner: {
          accountId: account === 'unknown' ? null : account,
          threadId: frontmatterValue(raw, 'thread') ?? '',
          ...(agentId !== null ? { agentId } : {})
        },
        savedAtMs: Number(frontmatterValue(raw, 'saved_at_ms') ?? 0),
        body: raw.replace(/^---\n[\s\S]*?\n---\n/, '')
      });
    }
    return entries;
  }

  public list(): CheckpointEntry[] {
    return this.readDir(this.activeDir);
  }

  public listArchived(): CheckpointEntry[] {
    return this.readDir(this.archiveDir);
  }

  /** Consume one checkpoint by exact id, archiving it so it cannot replay. */
  public resume(id: string): ResumeResult {
    const entry = this.list().find((candidate) => candidate.id === id);
    if (entry === undefined) {
      const archived = this.listArchived().some((candidate) => candidate.id === id);
      return archived ? { status: 'already-consumed' } : { status: 'not-found' };
    }
    fs.mkdirSync(this.archiveDir, { recursive: true });
    // Archive before reporting success: content is preserved for a consumer
    // that fails after this point, rather than deleted on its behalf.
    fs.renameSync(entry.file, path.join(this.archiveDir, `${entry.lane}-${entry.id}.md`));
    return { status: 'resumed', id: entry.id, lane: entry.lane, body: entry.body };
  }

  /**
   * Resume by lane. With no lane given and more than one active, this reports
   * ambiguity and consumes nothing rather than guessing at "latest".
   */
  public resumeLane(lane: string | undefined): ResumeResult {
    const active = this.list();
    if (lane !== undefined) {
      const wanted = sanitizeLane(lane);
      const entry = active.find((candidate) => candidate.lane === wanted);
      return entry === undefined ? { status: 'not-found' } : this.resume(entry.id);
    }
    if (active.length === 0) return { status: 'not-found' };
    if (active.length > 1) {
      return { status: 'ambiguous', lanes: active.map((entry) => entry.lane).sort() };
    }
    const only = active[0];
    if (only === undefined) return { status: 'not-found' };
    return this.resume(only.id);
  }
}
