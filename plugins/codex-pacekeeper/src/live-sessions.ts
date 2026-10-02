/**
 * Existing Codex owner discovery.
 *
 * The package never starts an app server as a delivery fallback. It can only
 * use an owner record explicitly published by the running Codex installation,
 * then verifies that owner's PID and endpoint before sending a request. An
 * unreadable registry is unknown, not an empty set.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ACCOUNT_READ_METHOD,
  NATIVE_PROTOCOL_VERSION,
  QUEUE_ADD_METHOD,
  QUEUE_DELETE_METHOD,
  QUEUE_LIST_METHOD,
  RATE_LIMITS_READ_METHOD,
  THREAD_READ_METHOD,
  findExistingOwner,
  normalizeNativeCapabilities,
  parseThreadParentId,
  parseOwnerRecord,
  type ExistingOwnerRecord,
  type NativeClient,
  type NativeOwnerEndpoint,
  type OwnerLookup,
  type OwnerProbeRecord
} from './native';
import { clientForExistingOwner } from './native-transport';

export interface OwnerRegistry {
  owners: OwnerProbeRecord[];
  readable: boolean;
  file: string;
}

function codexHome(): string {
  return process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
}

export function ownerRegistryFile(): string {
  return process.env['CODEX_PACEKEEPER_OWNER_FILE']
    ?? path.join(codexHome(), 'pacekeeper', 'owners.json');
}

const NATIVE_CONTROL_METHODS = [
  ACCOUNT_READ_METHOD,
  RATE_LIMITS_READ_METHOD,
  QUEUE_ADD_METHOD,
  QUEUE_DELETE_METHOD,
  QUEUE_LIST_METHOD,
  THREAD_READ_METHOD,
  'thread/loaded/list'
] as const;

/** Resolve the documented app-server control socket without starting a server. */
export function nativeControlSocketPath(): string | null {
  const configured = process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'];
  const candidate = configured && configured.trim() !== ''
    ? configured
    : path.join(codexHome(), 'app-server-control', 'app-server-control.sock');
  if (!path.isAbsolute(candidate) || candidate.includes('\u0000')) return null;
  let real: string;
  try { real = fs.realpathSync(candidate); } catch { return null; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const reserved = uid === null ? null : path.join('/tmp', `codex-daemon-${uid}`);
  const home = path.resolve(codexHome());
  if (!real.startsWith(home + path.sep) && (reserved === null || !real.startsWith(reserved + path.sep))) return null;
  try { if (!fs.statSync(real).isSocket()) return null; } catch { return null; }
  return real;
}

export function nativeControlOwner(threadId: string, accountId: string | null, socketPath: string): NativeOwnerEndpoint {
  return {
    ownerId: 'codex-app-server-control',
    accountId,
    threadIds: [threadId],
    socketPath: `unix://${socketPath}`,
    methods: [...NATIVE_CONTROL_METHODS],
    protocolVersion: NATIVE_PROTOCOL_VERSION
  };
}

/**
 * Use the actual Codex control socket as a native owner when no explicit
 * registry publisher is present. The loaded-thread check prevents this path
 * from taking a thread through a second server or an unrelated endpoint.
 */
export async function discoverNativeControlClient(threadId: string, accountId: string | null): Promise<ReturnType<typeof clientForExistingOwner>> {
  if (threadId.trim() === '') return null;
  const socketPath = nativeControlSocketPath();
  if (socketPath === null) return null;
  const owner = nativeControlOwner(threadId, accountId, socketPath);
  const capabilities = normalizeNativeCapabilities({ version: owner.protocolVersion, methods: owner.methods });
  const client = clientForExistingOwner(owner, capabilities, 750);
  if (client === null) return null;
  try {
    const loaded = await client.listLoadedThreads();
    if (!loaded.includes(threadId)) return null;
    client.owner.threadIds = loaded;
    client.owner.loadedThreadsObservedAtMs = Date.now();
    if (accountId !== null) {
      const limits = await client.readRateLimits();
      // A null account id is an unavailable observation, not proof that this
      // endpoint belongs to the requested account.
      if (limits.accountId !== accountId) return null;
      client.owner.accountObservedAtMs = Date.now();
    }
    return client;
  } catch { return null; }
}

export interface VerifiedThreadParent {
  accountId: string;
  childThreadId: string;
  parentThreadId: string;
  observedAtMs: number;
}

/** Verify a child-to-parent edge against current loaded-thread and account
 * observations before callers persist or act on the relationship. */
export async function readVerifiedThreadParent(
  client: NativeClient,
  childThreadId: string,
  expectedAccountId: string | null
): Promise<VerifiedThreadParent | null> {
  try {
    const nowMs = Date.now();
    const loadedObservedAtMs = client.owner.loadedThreadsObservedAtMs;
    let loaded = client.owner.threadIds;
    if (loadedObservedAtMs === undefined || loadedObservedAtMs > nowMs || nowMs - loadedObservedAtMs > 5_000) {
      loaded = await client.listLoadedThreads();
      client.owner.threadIds = loaded;
      client.owner.loadedThreadsObservedAtMs = Date.now();
    }
    if (!loaded.includes(childThreadId)) return null;
    const accountObservedAtMs = client.owner.accountObservedAtMs;
    let accountId = client.owner.accountId;
    if (accountId === null || accountObservedAtMs === undefined || accountObservedAtMs > nowMs || nowMs - accountObservedAtMs > 5_000) {
      accountId = (await client.readRateLimits()).accountId;
      client.owner.accountId = accountId;
      client.owner.accountObservedAtMs = Date.now();
    }
    if (accountId === null || (expectedAccountId !== null && accountId !== expectedAccountId)) return null;
    const parentThreadId = parseThreadParentId(await client.readThread(childThreadId, false), childThreadId);
    if (parentThreadId === null || !loaded.includes(parentThreadId)) return null;
    return { accountId, childThreadId, parentThreadId, observedAtMs: Date.now() };
  } catch { return null; }
}

function parseRecords(value: unknown): OwnerProbeRecord[] | null {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
      ? value as OwnerProbeRecord[]
      : null;
  }
  if (typeof value === 'object' && value !== null) {
    const owners = (value as Record<string, unknown>)['owners'];
    if (Array.isArray(owners)) {
      return owners.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
        ? owners as OwnerProbeRecord[]
        : null;
    }
  }
  return null;
}

export function readOwnerRegistry(file: string = ownerRegistryFile()): OwnerRegistry {
  try {
    const parsed = parseRecords(JSON.parse(fs.readFileSync(file, 'utf8')));
    // A syntactically readable registry with one malformed owner is still an
    // unknown occupancy state. Dropping that row would let cleanup treat a
    // live or corrupted entry as vacant.
    if (parsed === null || parsed.some((record) => parseOwnerRecord(record) === null)) {
      return { owners: [], readable: false, file };
    }
    return { owners: parsed, readable: true, file };
  } catch {
    return { owners: [], readable: false, file };
  }
}

/** Process liveness is a gate, never a complete app-server health proof. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Require a usable endpoint as well as a live process before delivery. */
export function ownerHasEndpoint(owner: ExistingOwnerRecord): boolean {
  if (owner.socketPath === undefined || owner.socketPath.trim() === '') return false;
  if (owner.socketPath.startsWith('unix://')) {
    const socket = owner.socketPath.slice('unix://'.length).trim();
    return path.isAbsolute(socket) && !socket.includes('\u0000');
  }
  if (!/^wss?:\/\/[^\s]+$/.test(owner.socketPath)) return false;
  try {
    const host = new URL(owner.socketPath).hostname.toLowerCase();
    // An owner registry is local process state. Refuse remote WebSocket hosts
    // so a compromised/stale registry cannot turn a pacing hook into a
    // credential or prompt transport to an unrelated service.
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch { return false; }
}

export interface LiveOwnerLookup {
  status: OwnerLookup['status'];
  owner?: ExistingOwnerRecord;
  reason?: string;
  registryReadable: boolean;
}

export function findLiveOwner(
  threadId: string,
  accountId: string | null,
  file: string = ownerRegistryFile()
): LiveOwnerLookup {
  const registry = readOwnerRegistry(file);
  if (!registry.readable) return { status: 'unknown', reason: 'owner registry was not readable', registryReadable: false };
  const lookup = findExistingOwner({
    records: registry.owners,
    threadId,
    accountId,
    isAlive: pidIsAlive
  });
  if (lookup.status !== 'found') return { ...lookup, registryReadable: true };
  if (!ownerHasEndpoint(lookup.owner)) {
    return { status: 'unknown', reason: 'live owner has no usable native endpoint', registryReadable: true };
  }
  return { status: 'found', owner: lookup.owner, registryReadable: true };
}

/** Return sanitized owner rows for doctor and worktree diagnostics. */
export function listLiveOwners(file: string = ownerRegistryFile()): ExistingOwnerRecord[] | null {
  const registry = readOwnerRegistry(file);
  if (!registry.readable) return null;
  return registry.owners
    .map(parseOwnerRecord)
    .filter((owner): owner is ExistingOwnerRecord => owner !== null)
    .filter((owner) => pidIsAlive(owner.pid));
}

export interface LiveClaudeSession {
  pid: number;
  cwd?: string;
}

function claudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
}

/** Read the installed Claude session registry defensively for worktree safety. */
export function listLiveClaudeSessions(dir: string = path.join(claudeConfigDir(), 'sessions')): LiveClaudeSession[] | null {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const sessions: LiveClaudeSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      raw = parsed as Record<string, unknown>;
    } catch { return null; }
    const pid = finiteSessionPid(raw['pid']);
    if (pid === null) return null;
    if (!pidIsAlive(pid)) continue;
    const cwd = typeof raw['cwd'] === 'string' && raw['cwd'].trim() !== '' ? raw['cwd'] : undefined;
    sessions.push({ pid, ...(cwd ? { cwd } : {}) });
  }
  return sessions;
}

function finiteSessionPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Resolve a binary without invoking a shell; useful for read-only doctor. */
export function findCodexExecutable(): string | null {
  const configured = process.env['CODEX_BIN'];
  if (configured !== undefined && configured.trim() !== '') return configured;
  try {
    return execFileSync('which', ['codex'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}
