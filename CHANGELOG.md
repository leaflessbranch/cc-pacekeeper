# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3]

### Changed
- **Keepalive no longer churns the context on every turn.** The `Stop` hook used
  to emit the "schedule a keepalive" directive at every turn-end (there is no
  idle signal at `Stop` time), and every real prompt emitted a matching cancel —
  spamming context during active work. Redesigned: `Stop` now just ensures a
  chain exists *idempotently* (emits at most once per interval), the cancel path
  is gone, and the decision to continue or stop moves to **ping-fire time**,
  where `now − lastEventAt` is a real idle measurement. A ping replies and either
  reschedules (still idle) or stops (active again). Fixes the freshness window
  (was 10m regardless of a 30m interval, so pings always read as stale).

## [0.2.2]

### Fixed
- **Keepalive pings counted as user activity.** A keepalive ping arrives as a
  `UserPromptSubmit`, so the tick treated it as the user returning: it overwrote
  the idle-start time, surfaced a bogus "you were away" line, and emitted a
  cancel directive that fought the ping's own reschedule instruction. Pings
  carrying the `[pacekeeper-keepalive]` marker are now transparent to idle
  tracking — the tick short-circuits before touching session state and emits
  nothing, so the real idle-start (the last `Stop`) is preserved.

## [0.2.1]

### Fixed
- **AFK cache keepalive never scheduled.** The `Stop` hook — the only hook that
  fires when the session goes idle — did not invoke the keepalive logic, so the
  "schedule a keepalive one-shot" directive was never emitted (`UserPromptSubmit`
  only ever *cancels*). The keepalive appeared to "not fire" because nothing
  scheduled it. `Stop` now emits the schedule directive when idle.
- **Invalid local config silently discarded the entire config.** A single
  out-of-range value made schema validation fail and fall back to *all* defaults
  with no warning. `loadConfig` now logs the offending key(s) to stderr before
  falling back, so a one-value typo is visible.
- **Time-dependent test.** A threshold test hardcoded a wall-clock time and
  consulted the real clock indirectly, so it failed when run after that time of
  day. `computeSnapshot` now accepts an injectable `now`.

### Changed
- Keepalive `interval_min` default lowered from 50 to 30 minutes (more margin
  under the 1-hour subscription prompt-cache TTL).
- Pinned `@types/bun` from `latest` to a fixed version for reproducible installs.

### Added
- Demo GIF in the README showing the escalation, checkpoint, multi-session, and
  AFK-return behaviours.

## [0.2.0]

### Added
- Time & AFK awareness in the pacekeeper heartbeat.
- Cross-session budget awareness (surfaces when multiple live sessions share the
  same usage budget).
- Worktree-aware checkpoint anchoring and provenance.
- Worktree lifecycle skill.
- AFK cache keepalive, the 5-hour block-reset bridge, and weekly model-family
  arbitrage nudges.

## [0.1.1]

### Fixed
- Model-aware context window sizing.
- Dropped stale rate-limit readings.
- Populate the model-window cache on every tick; fixed a broken background
  refresh.
- Anchor checkpoints to the project root, never a transient directory.

## [0.1.0]

### Added
- Initial release: plugin scaffolding, hooks, the checkpoint skill, and tests.
- Injects context %, 5-hour block %, and weekly usage into Claude's context so
  it can self-pace, warn at thresholds, and offer resumable checkpoints.
