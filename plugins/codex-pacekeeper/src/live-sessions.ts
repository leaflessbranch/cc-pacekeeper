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
  findExistingOwner,
  parseOwnerRecord,
  type ExistingOwnerRecord,
  type OwnerLookup,
  type OwnerProbeRecord
} from './native';

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

function parseRecords(value: unknown): OwnerProbeRecord[] | null {
  if (Array.isArray(value)) return value.filter((item): item is OwnerProbeRecord => typeof item === 'object' && item !== null);
  if (typeof value === 'object' && value !== null) {
    const owners = (value as Record<string, unknown>)['owners'];
    if (Array.isArray(owners)) return owners.filter((item): item is OwnerProbeRecord => typeof item === 'object' && item !== null);
  }
  return null;
}

export function readOwnerRegistry(file: string = ownerRegistryFile()): OwnerRegistry {
  try {
    const parsed = parseRecords(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { owners: parsed ?? [], readable: parsed !== null, file };
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
