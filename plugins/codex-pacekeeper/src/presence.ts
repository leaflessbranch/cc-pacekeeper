/**
 * Presence fusion.
 *
 * One asymmetry here is load-bearing: an unavailable probe never votes `afk`.
 * Degradation fails toward "assume present", because a false `afk` reroutes
 * output away from someone who is sitting there watching, while a false
 * "present" costs nothing worse than a message they see immediately.
 *
 * Presence also requires attachment PLUS recent activity, never a connection's
 * mere existence. A live socket lingers for minutes after a laptop closes,
 * which makes connection existence the most tempting signal and the one that
 * lies most often.
 *
 * This module is pure. Probing belongs to a caller; here the readings are
 * combined so the fusion rules can be tested without a machine to observe.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { CodexConfig } from './config';

export type Presence = 'online' | 'afk' | 'unknown';

export type ProbeResult =
  | { status: 'unavailable' }
  | { status: 'detached' }
  | { status: 'attached'; idleSeconds?: number };

export interface ProbeReadings {
  tmux: ProbeResult;
  tty: ProbeResult;
  ssh: ProbeResult;
  loginctl: ProbeResult;
}

export function fusePresence(readings: ProbeReadings, idleSeconds: number): Presence {
  const probes = Object.values(readings);

  let sawAttachedWithoutIdle = false;
  let sawUsableSignal = false;

  for (const probe of probes) {
    if (probe.status === 'unavailable') continue;
    sawUsableSignal = true;
    if (probe.status !== 'attached') continue;
    if (probe.idleSeconds === undefined) {
      // Attached, but we cannot tell whether anyone is actually there.
      sawAttachedWithoutIdle = true;
      continue;
    }
    // Any single probe showing recent activity settles it: someone is here.
    if (probe.idleSeconds <= idleSeconds) return 'online';
  }

  // No probe could speak: that is ignorance, not absence.
  if (!sawUsableSignal) return 'unknown';

  // Attached with no idle information cannot establish either state, and
  // guessing `afk` here would reroute output away from a present user.
  if (sawAttachedWithoutIdle) return 'unknown';

  // Every usable probe was either detached or idle beyond the window.
  return 'afk';
}

export type ProbeState = 'active' | 'idle' | 'unavailable';
export interface Signal {
  name: string;
  state: ProbeState;
  lastActivityMs?: number;
  detail?: string;
}

export interface PresenceResult {
  state: Presence;
  signals: Signal[];
  lastActivityMs: number | null;
}

function command(name: string, args: string[]): string | null {
  try {
    return execFileSync(name, args, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function unavailable(name: string, detail: string): Signal { return { name, state: 'unavailable', detail }; }

function classify(name: string, activityMs: number, nowMs: number, idleMs: number): Signal {
  return { name, state: nowMs - activityMs <= idleMs ? 'active' : 'idle', lastActivityMs: activityMs };
}

export function probeTmux(nowMs: number, idleMs: number): Signal {
  const output = command('tmux', ['list-clients', '-F', '#{client_activity}']);
  if (output === null) return unavailable('tmux', 'tmux is unavailable');
  if (output === '') return { name: 'tmux', state: 'idle', detail: 'no attached clients' };
  const times = output.split('\n').map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  return times.length === 0 ? unavailable('tmux', 'client activity was not parseable') : classify('tmux', Math.max(...times) * 1000, nowMs, idleMs);
}

export function probeTty(nowMs: number, idleMs: number, ttyPath?: string): Signal {
  const tty = ttyPath ?? command('tty', []);
  if (!tty || !tty.startsWith('/dev/')) return unavailable('tty', 'no controlling terminal');
  try { return classify('tty', fs.statSync(tty).atimeMs, nowMs, idleMs); } catch { return unavailable('tty', 'terminal could not be read'); }
}

export function parseWhoRemoteTtys(output: string): string[] {
  return output.split('\n').map((line) => {
    const match = /^\S+\s+(\S+)\s+.*\(([^)]+)\)\s*$/.exec(line);
    if (!match || !match[1] || !match[2]) return null;
    const origin = match[2];
    if (origin.startsWith(':') || origin.includes('tmux') || origin.includes(' ')) return null;
    return match[1];
  }).filter((value): value is string => value !== null);
}

export function probeSsh(nowMs: number, idleMs: number): Signal {
  const output = command('who', []);
  if (output === null) return unavailable('ssh', 'who is unavailable');
  const ttys = parseWhoRemoteTtys(output);
  if (ttys.length === 0) return { name: 'ssh', state: 'idle', detail: 'no remote logins' };
  let newest = 0;
  for (const tty of ttys) {
    try { newest = Math.max(newest, fs.statSync(path.join('/dev', tty)).atimeMs); } catch { /* ignore one tty */ }
  }
  return newest === 0 ? { name: 'ssh', state: 'idle', detail: 'remote tty activity unavailable' } : classify('ssh', newest, nowMs, idleMs);
}

export function probeLoginctl(nowMs: number, idleMs: number): Signal {
  const output = command('loginctl', ['show-session', 'self', '-p', 'IdleHint', '-p', 'IdleSinceHint']);
  if (output === null) return unavailable('loginctl', 'logind is unavailable');
  const fields = new Map<string, string>();
  for (const line of output.split('\n')) { const index = line.indexOf('='); if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1).trim()); }
  if (fields.get('IdleHint') === 'no') return { name: 'loginctl', state: 'active', lastActivityMs: nowMs };
  const since = Number(fields.get('IdleSinceHint') ?? 0);
  return Number.isFinite(since) && since > 0 ? classify('loginctl', since / 1000, nowMs, idleMs) : unavailable('loginctl', 'IdleSinceHint was unavailable');
}

export function probeAll(config: CodexConfig, nowMs: number): Signal[] {
  if (config.presence.enabled !== true) return [unavailable('presence', 'presence sampling is disabled')];
  if (process.platform !== 'linux') return [unavailable('platform', `${process.platform}: probes are Linux-only`)];
  const idleMs = config.presence.idle_minutes * 60_000;
  const signals: Signal[] = [];
  if (config.presence.probes.tmux) signals.push(probeTmux(nowMs, idleMs));
  if (config.presence.probes.tty) signals.push(probeTty(nowMs, idleMs));
  if (config.presence.probes.ssh) signals.push(probeSsh(nowMs, idleMs));
  if (config.presence.probes.loginctl) signals.push(probeLoginctl(nowMs, idleMs));
  return signals;
}

export interface PresenceSample {
  state: Presence;
  signals: Signal[];
  lastActivityMs: number | null;
  checkedAtMs: number;
}

function cacheRoot(cacheHome?: string): string {
  return path.resolve(cacheHome ?? process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'cc-pacekeeper', 'codex');
}

export function presenceStateFile(cacheHome?: string): string { return path.join(cacheRoot(cacheHome), 'presence-state.json'); }

function assertNoSymlinkPath(target: string): void {
  const absolute = path.resolve(target);
  let cursor = path.parse(absolute).root;
  for (const component of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Codex presence state contains a symlink');
    } catch (error) {
      if (error instanceof Error && error.message.includes('contains a symlink')) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error('Codex presence state cannot be inspected');
    }
  }
}

function fuseSignals(signals: Signal[], hookGapMs: number | null, idleMs: number): Presence {
  if (signals.length === 0) return 'unknown';
  if (hookGapMs !== null && hookGapMs <= idleMs) return 'online';
  if (signals.some((signal) => signal.state === 'active')) return 'online';
  if (signals.every((signal) => signal.state === 'unavailable')) return 'unknown';
  return 'afk';
}

/** Fuse raw probe signals while retaining evidence for diagnostics. */
export function fuse(signals: Signal[], hookGapMs: number | null, idleMs: number): PresenceResult {
  const lastActivityMs = signals.reduce<number | null>((current, signal) => signal.lastActivityMs === undefined ? current : current === null ? signal.lastActivityMs : Math.max(current, signal.lastActivityMs), null);
  return { state: fuseSignals(signals, hookGapMs, idleMs), signals, lastActivityMs };
}

export function samplePresence(config: CodexConfig, nowMs = Date.now(), hookGapMs: number | null = null, cacheHome?: string): PresenceSample {
  const signals = probeAll(config, nowMs);
  const fused = fuse(signals, hookGapMs, config.presence.idle_minutes * 60_000);
  const sample = { state: fused.state, signals, lastActivityMs: fused.lastActivityMs, checkedAtMs: nowMs };
  const file = presenceStateFile(cacheHome);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    assertNoSymlinkPath(path.dirname(file));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assertNoSymlinkPath(path.dirname(file));
    fs.writeFileSync(temp, JSON.stringify(sample), { encoding: 'utf8', mode: 0o600 });
    assertNoSymlinkPath(path.dirname(file));
    fs.renameSync(temp, file);
  } catch {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    /* diagnostics can report unknown state; hooks stay usable */
  }
  return sample;
}

const PresenceSampleSchema = z.object({
  state: z.enum(['online', 'afk', 'unknown']),
  signals: z.array(z.object({ name: z.string(), state: z.enum(['active', 'idle', 'unavailable']), lastActivityMs: z.number().optional(), detail: z.string().optional() })),
  lastActivityMs: z.number().nullable(),
  checkedAtMs: z.number()
});

export function readPresenceState(cacheHome?: string): PresenceSample | null {
  try {
    const parsed = PresenceSampleSchema.safeParse(JSON.parse(fs.readFileSync(presenceStateFile(cacheHome), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
