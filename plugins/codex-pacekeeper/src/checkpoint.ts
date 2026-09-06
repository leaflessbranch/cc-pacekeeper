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

function isPathSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !path.isAbsolute(value)
    && !value.includes('/')
    && !value.includes('\\');
}

/**
 * Resolve the existing prefix of a path and reject a symlink anywhere below
 * the project root. `realpath(projectRoot)` alone is insufficient: mkdir and
 * rename follow a symlink in a configured destination, which can redirect a
 * perfectly ordinary lane write into the other harness's directory.
 */
function assertConfined(root: string, target: string): void {
  const rootResolved = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootResolved);
  } catch {
    rootReal = rootResolved;
  }
  const absolute = path.resolve(target);
  if (absolute !== rootReal && !absolute.startsWith(rootReal + path.sep)) {
    throw new Error('checkpoint destination escapes the project root');
  }

  const components = path.relative(rootResolved, absolute).split(path.sep).filter(Boolean);
  let cursor = rootResolved;
  for (const component of components) {
    cursor = path.join(cursor, component);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error('checkpoint destination contains a symlink');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('contains a symlink')) throw error;
      // A missing suffix is safe at this instant; the caller re-checks before
      // every operation and refuses if it is later replaced with a symlink.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error('checkpoint destination cannot be inspected');
    }
  }

  const existing = realOrResolve(absolute);
  if (existing !== rootReal && !existing.startsWith(rootReal + path.sep)) {
    throw new Error('checkpoint destination escapes the project root');
  }
}

function safeScalar(value: string, name: string): string {
  if (value.includes('\n') || value.includes('\r') || [...value].some((char) => char.charCodeAt(0) < 0x20)) {
    throw new Error(`${name} contains a control character`);
  }
  return value;
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
  /** Source-control/worktree provenance for cold recovery. */
  branch?: string;
  worktree?: string;
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
  branch?: string;
  worktree?: string;
  resetGeneration?: number;
}

export interface CheckpointClaim {
  status: 'claimed' | 'already-claimed';
  id: string;
  lane: string;
  body: string;
  token: string;
}

export type ClaimResult =
  | CheckpointClaim
  | { status: 'not-found' | 'already-consumed' | 'not-claimed' };

export type ResumeResult =
  | { status: 'resumed'; id: string; lane: string; body: string }
  | { status: 'not-found' | 'already-consumed' }
  | { status: 'ambiguous'; lanes: string[] };

export interface CleanupResult {
  stale: string[];
  expired: string[];
  applied: boolean;
}

function frontmatterValue(raw: string, key: string): string | null {
  const match = new RegExp(`^${key}: (.*)$`, 'm').exec(raw);
  const value = match?.[1]?.trim();
  if (value === undefined) return null;
  if (value.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(value);
      return typeof decoded === 'string' ? decoded : value;
    } catch {
      return value;
    }
  }
  return value;
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
  private readonly claimsDir: string;
  private readonly projectRoot: string;

  public constructor(
    projectRoot: string,
    private readonly config: CodexConfig,
    options: CheckpointOptions = {}
  ) {
    const unsafe = options.isUnsafeRoot ?? isUnsafeCheckpointRoot;
    if (unsafe(projectRoot)) {
      throw new Error(`refusing to write checkpoints into an unsafe root: ${projectRoot}`);
    }
    if (!isPathSegment(config.checkpoint_dir_name)) {
      throw new Error('checkpoint directory name must be a single relative path segment');
    }
    if (!isPathSegment(config.checkpoint_subdir)) {
      throw new Error('checkpoint subdir must be a single relative path segment');
    }
    this.projectRoot = realOrResolve(projectRoot);
    assertConfined(this.projectRoot, this.projectRoot);
    const base = path.join(this.projectRoot, config.checkpoint_dir_name, config.checkpoint_subdir);
    this.activeDir = base;
    this.archiveDir = path.join(base, 'archive');
    this.claimsDir = path.join(base, 'claims');
    this.assertSafeDestinations();
  }

  private assertSafeDestinations(): void {
    assertConfined(this.projectRoot, path.join(this.projectRoot, this.config.checkpoint_dir_name));
    assertConfined(this.projectRoot, this.activeDir);
    assertConfined(this.projectRoot, this.archiveDir);
    assertConfined(this.projectRoot, this.claimsDir);
  }

  private ensureDirectory(dir: string): void {
    this.assertSafeDestinations();
    fs.mkdirSync(dir, { recursive: true });
    this.assertSafeDestinations();
  }

  private claimFile(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('checkpoint id is not a safe identifier');
    return path.join(this.claimsDir, `${id}.json`);
  }

  private readClaim(id: string): { id: string; lane: string; file: string; token: string; bodyHash: string; claimedAtMs: number } | null {
    try {
      const file = this.claimFile(id);
      if (fs.lstatSync(file).isSymbolicLink()) return null;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (raw.id !== id || typeof raw.lane !== 'string' || typeof raw.file !== 'string' || typeof raw.token !== 'string' || typeof raw.bodyHash !== 'string') return null;
      return {
        id,
        lane: raw.lane,
        file: raw.file,
        token: raw.token,
        bodyHash: raw.bodyHash,
        claimedAtMs: typeof raw.claimedAtMs === 'number' ? raw.claimedAtMs : 0
      };
    } catch {
      return null;
    }
  }

  private writeClaim(value: { id: string; lane: string; file: string; token: string; bodyHash: string; claimedAtMs: number }): boolean {
    this.ensureDirectory(this.claimsDir);
    const file = this.claimFile(value.id);
    try {
      const handle = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(handle, JSON.stringify(value), 'utf8'); }
      finally { fs.closeSync(handle); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  private archiveDestination(entry: CheckpointEntry): string {
    this.ensureDirectory(this.archiveDir);
    let destination = path.join(this.archiveDir, `${entry.lane}-${entry.id}.md`);
    let suffix = 1;
    while (fs.existsSync(destination)) {
      destination = path.join(this.archiveDir, `${entry.lane}-${entry.id}-${suffix}.md`);
      suffix += 1;
    }
    return destination;
  }

  public save(input: SaveInput): SavedCheckpoint {
    const lane = sanitizeLane(input.lane);
    // The id is unique per save, so a superseded checkpoint and its replacement
    // are never confused after a crash.
    const id = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16);
    const savedAtMs = Date.now();
    safeScalar(input.owner.threadId, 'threadId');
    if (input.owner.accountId !== null) safeScalar(input.owner.accountId, 'accountId');
    if (input.owner.agentId !== undefined) safeScalar(input.owner.agentId, 'agentId');
    if (input.branch !== undefined) safeScalar(input.branch, 'branch');
    if (input.worktree !== undefined) safeScalar(input.worktree, 'worktree');
    if (input.resetGeneration !== undefined && (!Number.isInteger(input.resetGeneration) || input.resetGeneration < 0)) {
      throw new Error('resetGeneration must be a non-negative integer');
    }
    this.ensureDirectory(this.activeDir);

    const frontmatter = [
      '---',
      'harness: codex',
      `id: ${id}`,
      `lane: ${lane}`,
      `thread: ${JSON.stringify(input.owner.threadId)}`,
      `account: ${JSON.stringify(input.owner.accountId ?? 'unknown')}`,
      ...(input.owner.agentId !== undefined ? [`agent: ${JSON.stringify(input.owner.agentId)}`] : []),
      ...(input.branch !== undefined ? [`branch: ${JSON.stringify(input.branch)}`] : []),
      ...(input.worktree !== undefined ? [`worktree: ${JSON.stringify(input.worktree)}`] : []),
      ...(input.resetGeneration !== undefined ? [`reset_generation: ${input.resetGeneration}`] : []),
      `saved_at_ms: ${savedAtMs}`,
      '---',
      ''
    ].join('\n');

    const file = path.join(this.activeDir, `${lane}.md`);
    const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temp, frontmatter + input.body, 'utf8');
      // Publish the replacement only after the previous lane has a recoverable
      // archive entry. The selected id in a claim is therefore never rebound
      // to the mutable lane filename by a concurrent save.
      const previous = this.readDir(this.activeDir).find((entry) => entry.lane === lane);
      if (previous !== undefined) {
        const destination = this.archiveDestination(previous);
        fs.renameSync(previous.file, destination);
        try { fs.unlinkSync(this.claimFile(previous.id)); } catch { /* no claim */ }
      }
      this.assertSafeDestinations();
      fs.renameSync(temp, file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }

    // Verify the persisted content before reporting success: a hook directive
    // is not a saved checkpoint, and neither is an unread write.
    const persisted = fs.readFileSync(file, 'utf8');
    if (!persisted.includes(`id: ${id}`) || !persisted.includes(input.body)) {
      throw new Error('checkpoint did not persist as written');
    }
    return { id, lane, file };
  }

  private readDir(dir: string): CheckpointEntry[] {
    this.assertSafeDestinations();
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
        if (fs.lstatSync(file).isSymbolicLink()) continue;
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const id = frontmatterValue(raw, 'id');
      const lane = frontmatterValue(raw, 'lane');
      if (id === null || lane === null) continue;
      const account = frontmatterValue(raw, 'account');
      const agentId = frontmatterValue(raw, 'agent');
      const branch = frontmatterValue(raw, 'branch');
      const worktree = frontmatterValue(raw, 'worktree');
      const resetGenerationValue = frontmatterValue(raw, 'reset_generation');
      const resetGeneration = resetGenerationValue === null ? undefined : Number(resetGenerationValue);
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
        body: raw.replace(/^---\n[\s\S]*?\n---\n/, ''),
        ...(branch !== null ? { branch } : {}),
        ...(worktree !== null ? { worktree } : {}),
        ...(resetGeneration !== undefined && Number.isInteger(resetGeneration) && resetGeneration >= 0 ? { resetGeneration } : {})
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

  public peek(id: string): CheckpointEntry | null {
    this.assertSafeDestinations();
    return this.list().find((entry) => entry.id === id) ?? this.listArchived().find((entry) => entry.id === id) ?? null;
  }

  /** Move one exact active checkpoint to the archive without consuming it. */
  public discard(id: string): ResumeResult {
    this.assertSafeDestinations();
    const entry = this.list().find((candidate) => candidate.id === id);
    if (entry === undefined) {
      return this.listArchived().some((candidate) => candidate.id === id)
        ? { status: 'already-consumed' }
        : { status: 'not-found' };
    }
    // A consumer may have already received the claimed bytes. Discarding the
    // file under it would turn a recoverable in-flight operation into a lost
    // handoff, so leave the claim and active file untouched.
    if (this.readClaim(id) !== null) return { status: 'not-found' };
    const destination = this.archiveDestination(entry);
    this.assertSafeDestinations();
    fs.renameSync(entry.file, destination);
    try { fs.unlinkSync(this.claimFile(id)); } catch { /* no claim */ }
    return { status: 'resumed', id: entry.id, lane: entry.lane, body: entry.body };
  }

  /** Dry-run by default; apply only when the caller explicitly requests it. */
  public cleanup(nowMs: number, staleAfterDays: number, archiveKeepDays: number, apply = false): CleanupResult {
    this.assertSafeDestinations();
    const age = (entry: CheckpointEntry): number => Math.max(0, nowMs - entry.savedAtMs) / 86_400_000;
    const active = this.list();
    const newestByLane = new Map<string, string>();
    for (const entry of active) {
      const current = newestByLane.get(entry.lane);
      const currentEntry = current ? active.find((candidate) => candidate.id === current) : undefined;
      if (currentEntry === undefined || entry.savedAtMs > currentEntry.savedAtMs) newestByLane.set(entry.lane, entry.id);
    }
    const staleEntries = active.filter((entry) => newestByLane.get(entry.lane) !== entry.id && age(entry) > staleAfterDays && this.readClaim(entry.id) === null);
    const expiredEntries = this.listArchived().filter((entry) => age(entry) > archiveKeepDays);
    if (apply) {
      for (const entry of staleEntries) {
        const destination = this.archiveDestination(entry);
        fs.renameSync(entry.file, destination);
      }
      for (const entry of expiredEntries) {
        try { fs.unlinkSync(entry.file); } catch { /* best effort */ }
      }
    }
    return { stale: staleEntries.map((entry) => entry.id), expired: expiredEntries.map((entry) => entry.id), applied: apply };
  }

  /**
   * Claim an exact checkpoint id without consuming it. A durable claim lets a
   * consumer crash and retry the same content instead of losing the work at a
   * rename boundary or creating a duplicate resume attempt.
   */
  public claim(id: string): ClaimResult {
    this.assertSafeDestinations();
    const entry = this.list().find((candidate) => candidate.id === id);
    if (entry === undefined) {
      const consumed = this.listArchived().some((candidate) => candidate.id === id);
      if (consumed) { try { fs.unlinkSync(this.claimFile(id)); } catch { /* already reconciled */ } }
      return consumed ? { status: 'already-consumed' } : { status: 'not-found' };
    }
    const existing = this.readClaim(id);
    if (existing !== null) {
      if (existing.file !== entry.file || existing.bodyHash !== createHash('sha256').update(entry.body).digest('hex')) {
        return { status: 'not-claimed' };
      }
      return { status: 'already-claimed', id, lane: entry.lane, body: entry.body, token: existing.token };
    }
    const token = randomUUID();
    const written = this.writeClaim({
      id,
      lane: entry.lane,
      file: entry.file,
      token,
      bodyHash: createHash('sha256').update(entry.body).digest('hex'),
      claimedAtMs: Date.now()
    });
    if (!written) {
      const concurrent = this.readClaim(id);
      if (concurrent?.file === entry.file && concurrent.bodyHash === createHash('sha256').update(entry.body).digest('hex')) {
        return { status: 'already-claimed', id, lane: entry.lane, body: entry.body, token: concurrent.token };
      }
      return { status: 'not-claimed' };
    }
    return { status: 'claimed', id, lane: entry.lane, body: entry.body, token };
  }

  /** Acknowledge successful consumption and archive exactly the claimed file. */
  public acknowledge(id: string, token: string): ResumeResult {
    this.assertSafeDestinations();
    const claim = this.readClaim(id);
    if (claim === null || claim.token !== token) return { status: 'not-found' };
    const entry = this.list().find((candidate) => candidate.id === id && candidate.file === claim.file);
    if (entry === undefined) {
      const consumed = this.listArchived().some((candidate) => candidate.id === id);
      if (consumed) { try { fs.unlinkSync(this.claimFile(id)); } catch { /* already reconciled */ } }
      return consumed ? { status: 'already-consumed' } : { status: 'not-found' };
    }
    const currentHash = createHash('sha256').update(entry.body).digest('hex');
    if (currentHash !== claim.bodyHash) return { status: 'not-found' };
    const destination = this.archiveDestination(entry);
    // Rename the exact selected file only after validating its id and body hash.
    this.assertSafeDestinations();
    fs.renameSync(entry.file, destination);
    try { fs.unlinkSync(this.claimFile(id)); } catch { /* archive is the durable acknowledgement */ }
    return { status: 'resumed', id: entry.id, lane: entry.lane, body: entry.body };
  }

  /** Inspect a durable claim after a crash without creating a new attempt. */
  public reconcile(id: string): ClaimResult {
    this.assertSafeDestinations();
    const claim = this.readClaim(id);
    if (claim === null) {
      return this.listArchived().some((candidate) => candidate.id === id)
        ? { status: 'already-consumed' }
        : { status: 'not-found' };
    }
    const entry = this.list().find((candidate) => candidate.id === id && candidate.file === claim.file);
    if (entry === undefined) {
      if (this.listArchived().some((candidate) => candidate.id === id)) {
        try { fs.unlinkSync(this.claimFile(id)); } catch { /* best effort */ }
        return { status: 'already-consumed' };
      }
      return { status: 'not-claimed' };
    }
    return { status: 'already-claimed', id, lane: entry.lane, body: entry.body, token: claim.token };
  }

  /**
   * Compatibility helper for the CLI: a synchronous consumer can claim and
   * immediately acknowledge. Asynchronous services use claim/acknowledge
   * separately and retain the active file during the consumer's work.
   */
  public resume(id: string): ResumeResult {
    const claim = this.claim(id);
    if (claim.status === 'not-found') return { status: 'not-found' };
    if (claim.status === 'already-consumed') return { status: 'already-consumed' };
    if (claim.status === 'not-claimed') return { status: 'not-found' };
    if (!('id' in claim) || !('token' in claim)) return { status: 'not-found' };
    return this.acknowledge(claim.id, claim.token);
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
