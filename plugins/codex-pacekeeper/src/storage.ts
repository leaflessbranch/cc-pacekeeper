/**
 * Isolated Codex state.
 *
 * Everything lives under a `codex/` subtree so no Claude scan can reach it and
 * no Codex write can disturb Claude state. State is keyed by a hash of the
 * account, thread and agent rather than by the raw identifiers: a session id
 * does not uniquely identify a thread, the same thread id can appear under two
 * accounts, and raw ids are untrusted strings that must never become path
 * segments.
 *
 * Writes are atomic (write a temp file, then rename) so a crash leaves either
 * the old record or the new one, never a truncated file. Reads never throw:
 * an unreadable record is indistinguishable from an absent one to a caller,
 * and both mean "no usable state", which is the safe default everywhere here.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface StateIdentity {
  /** `null` when the account could not be established. */
  accountId: string | null;
  threadId: string;
  agentId?: string;
}

/**
 * A filesystem-safe key for one identity. Distinct identities produce distinct
 * keys, and no input can produce a traversal or a collision across scopes,
 * because the parts are length-prefixed before hashing.
 */
export function identityKey(identity: StateIdentity): string {
  const parts = [
    identity.accountId ?? '\u0000unknown-account',
    identity.threadId,
    identity.agentId ?? '\u0000no-agent'
  ];
  const canonical = parts.map((part) => `${part.length}:${part}`).join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
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

/** Refuse symlinked state directories that could redirect Codex writes. */
function assertContained(root: string, target: string): void {
  const rootResolved = path.resolve(root);
  const rootReal = realOrResolve(rootResolved);
  const absolute = path.resolve(target);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    throw new Error('Codex state path escapes its cache root');
  }
  let cursor = rootResolved;
  for (const component of path.relative(rootResolved, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Codex state path contains a symlink');
    } catch (error) {
      if (error instanceof Error && error.message.includes('contains a symlink')) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error('Codex state path cannot be inspected');
    }
  }
  const existing = realOrResolve(absolute);
  if (existing !== rootReal && !existing.startsWith(rootReal + path.sep)) {
    throw new Error('Codex state path escapes its cache root');
  }
}

function defaultCacheHome(): string {
  return process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache');
}

/** Record kinds the store holds. Named so a typo cannot invent a new file. */
export type RecordKind = 'timeline' | 'debounce' | 'job' | 'presence' | 'owner' | 'crash' | 'account' | 'service';
const KINDS: readonly RecordKind[] = ['timeline', 'debounce', 'job', 'presence', 'owner', 'crash', 'account', 'service'];

/** The one machine-wide record of the newest native account/quota observation. */
export const ACCOUNT_IDENTITY: StateIdentity = { accountId: null, threadId: 'native-account' };

const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class CodexStore {
  public readonly root: string;
  private readonly cacheRoot: string;

  public constructor(cacheHome: string = defaultCacheHome()) {
    // Canonicalize the cache root before checking descendants. macOS exposes
    // legitimate system aliases (for example /var -> /private/var); rejecting
    // every ancestor symlink makes an otherwise safe cache unusable. The
    // canonical root is then treated as the trust boundary and all paths
    // created below it remain subject to assertContained's symlink checks.
    this.cacheRoot = realOrResolve(cacheHome);
    this.root = path.join(this.cacheRoot, 'cc-pacekeeper', 'codex');
    this.assertSafe();
  }

  private assertSafe(): void {
    assertContained(this.cacheRoot, path.join(this.cacheRoot, 'cc-pacekeeper'));
    assertContained(this.cacheRoot, this.root);
  }

  public pathFor(identity: StateIdentity, kind: RecordKind): string {
    if (!KINDS.includes(kind)) throw new Error('unknown Codex state record kind');
    const file = path.join(this.root, kind, `${identityKey(identity)}.json`);
    assertContained(this.cacheRoot, file);
    return file;
  }

  public read(identity: StateIdentity, kind: RecordKind): unknown {
    try {
      this.assertSafe();
      const file = this.pathFor(identity, kind);
      if (fs.lstatSync(file).isSymbolicLink()) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Absent, unreadable or corrupt all mean the same thing to a caller.
      return null;
    }
  }

  public write(identity: StateIdentity, kind: RecordKind, value: unknown): void {
    this.assertSafe();
    const file = this.pathFor(identity, kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.assertSafe();
    // The temp name is unique per write so concurrent writers cannot clobber
    // one another's partial file; rename then publishes one of them whole.
    const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
      fs.renameSync(temp, file);
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The temp file may never have been created; nothing to clean up.
      }
      throw error;
    }
  }

  /**
   * Read-merge-write one record under a per-record lock. Hooks for the same
   * thread can run concurrently (Codex starts every matching handler at
   * once), and an atomic rename alone only prevents torn files, not a lost
   * update when two writers merge from the same stale read.
   */
  public update<T extends Record<string, unknown>>(identity: StateIdentity, kind: RecordKind, merge: (prior: Record<string, unknown>) => T): T {
    const file = this.pathFor(identity, kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.assertSafe();
    const lock = `${file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;
    while (!held) {
      try {
        fs.closeSync(fs.openSync(lock, 'wx', 0o600));
        held = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let stale = false;
        try { stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
        if (stale) { try { fs.unlinkSync(lock); } catch { /* another waiter took it */ } continue; }
        // A hook must never hang on state: past the wait, proceed unlocked.
        if (Date.now() >= deadline) break;
        sleepSync(10);
      }
    }
    try {
      const prior = this.read(identity, kind);
      const next = merge(typeof prior === 'object' && prior !== null && !Array.isArray(prior) ? prior as Record<string, unknown> : {});
      this.write(identity, kind, next);
      return next;
    } finally {
      if (held) { try { fs.unlinkSync(lock); } catch { /* already released */ } }
    }
  }

  /**
   * Delete records of `kind` not modified within `maxAgeMs`, except those
   * `keep` claims. The hot path never lists directories, so this runs only
   * from the background service.
   */
  public prune(kind: RecordKind, maxAgeMs: number, nowMs: number, keep: (value: unknown) => boolean = () => false): number {
    let removed = 0;
    try {
      this.assertSafe();
      const dir = path.join(this.root, kind);
      assertContained(this.cacheRoot, dir);
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          const stat = fs.lstatSync(file);
          if (nowMs - stat.mtimeMs <= maxAgeMs) continue;
          if (name.endsWith('.json')) {
            let value: unknown = null;
            try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* corrupt records are prunable */ }
            if (keep(value)) continue;
          }
          fs.unlinkSync(file);
          removed += 1;
        } catch { /* raced with a writer */ }
      }
    } catch { /* nothing to prune */ }
    return removed;
  }

  public remove(identity: StateIdentity, kind: RecordKind): void {
    try {
      this.assertSafe();
      fs.unlinkSync(this.pathFor(identity, kind));
    } catch {
      // Already gone.
    }
  }

  /** Read all records of one known kind for service reconciliation. */
  public list(kind: RecordKind): unknown[] {
    if (!KINDS.includes(kind)) return [];
    try {
      this.assertSafe();
      const dir = path.join(this.root, kind);
      assertContained(this.cacheRoot, dir);
      return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          try {
            const file = path.join(dir, name);
            if (fs.lstatSync(file).isSymbolicLink()) return null;
            return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
          } catch { return null; }
        })
        .filter((value): value is unknown => value !== null);
    } catch { return []; }
  }
}
