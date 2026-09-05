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
