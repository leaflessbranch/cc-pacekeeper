# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0]

Runs-for-every-user release: portability + self-diagnosis.

### Added
- **macOS support**: OAuth credentials are now also read from the macOS
  Keychain (service `Claude Code-credentials`) — 5h/weekly meters previously
  never worked on macOS. First access may show a Keychain prompt for `bun`;
  choose "Always Allow".
- **Self-diagnosis**: when usage meters are unavailable, the reason is
  injected once per session instead of silently omitting them. New
  `pacekeeper-checkpoint doctor [--network]` verb checks runtime,
  credentials, caches, config validity, and the context-window override.
- **Graceful degradation**: hook shims no-op cleanly (with an install hint)
  when Bun is missing instead of erroring on every event.

### Fixed
- **Model tracking**: shared model-family table (opus/sonnet/haiku/fable/
  mythos) behind the weekly arbitrage nudge; `ANTHROPIC_API_KEY` fallback
  for per-model context-window fetches; sidechain transcript rows no longer
  skew ctx%; model-info entries re-verified after 30 days; usage cache
  token-hash checked at SessionStart so a switched account doesn't show the
  previous account's meters.

## [0.4.4]

### Fixed
- **Subagent burn attribution resets on block rollover.** `agentBurnPct` was
  a session-lifetime sum, so `agents ~N%` kept describing the previous block
  (observed live: "agents ~54%" at 5h 3%). The accumulator is now keyed to
  the block and restarts on rollover; display is gated on the key matching.
- **Legacy checkpoint nudge silenced after the auto-renewal fires.** Once the
  auto directive saved this block's checkpoint, the ask-style "consider
  saving" warn/critical nudges for the 5h meter (tick and end-of-turn) were
  contradictory noise; they are now suppressed for the rest of the block.
- **5h meter no longer vanishes after rollover (roadmap #9).** When the
  cached reset time is past but no fresh data has landed, the line now shows
  `5h rolled over (was N%, awaiting fresh data)` instead of dropping the
  field for however long the fetch lags. The stale reading is display-only:
  auto-renewal, subagent pause points, and burn deltas all ignore it.

## [0.4.3]

### Fixed
- **Auto-renewal no longer re-fires on resetsAt jitter.** The once-per-block
  idempotency compared the exact resetsAt ISO string, but the usage API
  jitters the same block's reset time at sub-second precision between
  fetches — observed live as six duplicate directives in one block. The key
  is now resetsAt rounded to the minute.

## [0.4.2]

### Fixed
- **No more doubled frontmatter in handoff files.** The budget contract now
  tells the pausing agent to pipe only the body sections on stdin (and pass
  `--agent-type`) — the CLI adds frontmatter itself, but the old wording
  ("frontmatter agent_id/…") led agents to write their own frontmatter into
  the body, producing files with two frontmatter blocks (observed live).

## [0.4.1]

### Fixed
- **Subagent handoff writes actually work.** The budget contract and pause
  directive now embed the absolute path to the checkpoint CLI
  (`$CLAUDE_PLUGIN_ROOT/bin/pacekeeper-checkpoint`) instead of the bare
  `pacekeeper-checkpoint` shim name: the PATH shim is not visible inside a
  subagent's Bash (verified live), so a pausing agent could not write its
  handoff — and the bare name sent it filesystem-hunting for the binary,
  which the permission classifier denies. The text now also says "do not
  search the filesystem for the command".

## [0.4.0]

### Added
- **Budget-aware subagent trees.** Hook state is now keyed per agent
  (`session:agent_id`), so subagents at any nesting depth get their own meter
  ticks instead of being starved by the main thread's debounce. On
  `SubagentStart` each spawned agent receives a budget contract with a
  spawn-relative pause point (`min(max(subagent_pause_pct, spawn%+5),
  five_hour_pct)` — an agent spawned late in the block still gets working
  room): at that point it finishes the current small step, writes a handoff
  file, and returns `PAUSED-BUDGET <agent_id>`. A cascade clause makes a
  parent record (not re-attempt) a paused child's work. Subagent `PreToolUse`
  gets a compact `5h X% · pause at P%` tick line.
- **Handoff registry.** Paused-agent handoffs live in
  `.claude-checkpoints/handoffs/<agent_id>.md` (files are the registry). New
  CLI verbs: `handoffs list`, `handoffs write <agent_id>`,
  `handoffs archive <agent_id>` — never raw `mv`. The SessionStart banner and
  auto-wake orientation list pending handoffs; `SubagentStop` notes when the
  finishing agent left one.
- **Burn accounting.** `SubagentStop` accumulates each agent's 5h-block burn
  delta into the main session; the heartbeat line shows `agents ~N%`
  (approximate — parallel deltas overlap).
- **Autonomous block renewal (full auto).** When the 5h block crosses
  `auto.five_hour_pct` (default 85), the tick fires once per block: save a
  checkpoint NOW without asking (with `--wake-at`/`--wake-prompt`), schedule a
  one-shot `[pacekeeper-resume]` cron at reset + `auto.wake_delay_min`, and
  keep to small steps until renewal. The directive opens with a precedence
  line so it beats the keepalive "single word" instruction when fired from a
  keepalive turn, and it takes precedence over the bridge directive.
  Resume-marker `CronCreate` is auto-approved on the main thread only.
- **Auto-wake orientation.** A `[pacekeeper-resume]` prompt is a real work
  trigger (never suppressed): it injects fresh meters, active lanes, pending
  handoffs, and instructions to `resume` the checkpoint (consuming/archiving
  it even in-session) and re-dispatch + archive handoffs.
- **Context auto-save with crossing-based re-arm.** At ctx critical the tick
  directs an immediate no-asking checkpoint save, once per climb: it re-arms
  only after a later tick sees ctx back below warn (compaction happened). When
  5h and ctx would both fire on one tick, a single combined directive is
  emitted (one save covers both; only the 5h path arms a wake).
- **Dispatch advisory.** `PreToolUse` on `Agent`/`Task` at 5h warn+ adds a
  one-line caution (advisory only — never denies).
- Checkpoint frontmatter gains optional `wake_at`/`wake_prompt`; `resume`
  prints re-arm guidance when `wake_at` is still in the future.
- Config: new `auto` block (`enabled`, `five_hour_pct`, `subagent_pause_pct`,
  `wake_delay_min`), upgraded into existing configs automatically.
- Hooks: `SubagentStart` + `SubagentStop` wired to the tick.

### Changed
- `scanKeepaliveState` generalized to `scanMarkerCreates(transcript, marker)`
  (keepalive keeps a thin wrapper; behavior unchanged) so the resume marker
  reuses the same create→result→delete correlation.

### Known limitations
- `transcript_path` inside subagent hook calls was runtime-verified to be the
  *parent's* transcript (same session file), so subagent tick lines and the
  contract deliberately omit any per-agent context-window clause.
- `PreCompact` supports only `decision:"block"` — the existing
  `precompact.ts` `additionalContext` injection is not delivered by the
  harness. It is left in place; the ctx auto-save on normal ticks (above) is
  the effective replacement.

## [0.3.0]

### Added
- **Named, lane-aware checkpoints.** Checkpoints are organized into parallel
  "lanes" keyed by a name — defaulting to the sanitized current git branch
  (`save --name <slug>` overrides). Saving supersedes only the prior active
  checkpoint in the *same* lane; other lanes stay active, so multiple efforts
  (including across git worktrees) keep independent resumable checkpoints.
  Legacy checkpoints without a `name` derive their lane from `git_branch`.
- `resume`, `peek`, and `discard` accept a lane name or a numeric index;
  selectors are sanitized, so raw branch names match their lane. Bare `resume`
  with multiple active lanes lists them and asks — nothing is archived until a
  specific lane is chosen.
- `peek <name|N>` — print a lane's body without archiving or mutating it.
- `resume --worktree` — re-enters the checkpoint's recorded worktree, or
  creates one for its `git_branch` under `.worktrees/` at the repo root.
- Resuming stamps `resumed_at` and (with `--session-id`) `resumed_by_session`
  into the archived frontmatter.
- `cleanup` is lane-aware: the newest active per lane is never marked stale.
- The SessionStart banner lists each active lane (name · branch · age · goal)
  when several exist, instead of "newest + N additional".

## [0.2.6]

### Fixed
- **Keepalive jobs no longer accumulate across `/clear`.** Recurring keepalive
  cron jobs live in the CLI process and survive `/clear`, while the
  transcript-based pending scan and the per-session directive debounce both
  reset — so orphaned jobs kept firing alongside a freshly armed one (observed
  live as three overlapping schedules). The schedule directive now instructs a
  CronList-first check: skip creation when a marker job already exists, and
  delete extras, making dedupe self-healing regardless of hook-side state.
- Directive steers cron syntax to fixed minute marks: a `*/N` minute step
  fires at minutes 0/29/58, not every N minutes (observed live as a
  `*/29 * * * *` job).

## [0.2.5]

### Fixed
- **Give-up teardown now sticks.** After the `max_idle_hours` give-up deleted
  the recurring keepalive job, the teardown turn's own `Stop` saw no pending
  job and immediately re-emitted the schedule directive, looping
  schedule → give-up → reschedule for as long as the user stayed away
  (caught in live validation of 0.2.4). The `Stop` branch now skips the
  directive while `keepalive.idleSince` shows idleness past `max_idle_hours`;
  the next real prompt clears the anchor and re-enables keepalive.
- Give-up guidance renders minutes instead of "idle over 0 hours" when the
  idle window is under an hour.

## [0.2.4]

### Changed
- **Keepalive schedules one recurring job per session instead of a one-shot
  chain.** The old design rescheduled a fresh one-shot from each ping; if
  Claude ignored the reschedule instruction the chain silently died, and if it
  ignored the *original* schedule directive, `Stop` re-emitted it every single
  turn forever. Claude now schedules a single `recurring: true` CronCreate once
  per session — nothing to reschedule, nothing to re-emit.
- **Pings are blocked hook-side while the user is active — zero context
  cost.** `pingGate` replaces `pingContinuation`: instead of asking Claude to
  decide (and spend a turn on) whether to continue, the hook itself returns a
  `block` decision when the idle gap is under threshold, so an active-user ping
  never reaches the model at all.
- **Directive emission is debounced hook-side.** The `Stop` branch now tracks
  `lastKeepaliveDirectiveAt` and only re-emits the schedule directive once per
  `interval_min`, so an ignored directive no longer costs context on every
  turn.

### Added
- `keepalive.max_idle_hours` config (default `12`): once a ping measures idle
  time beyond this, the guidance tells Claude to tear down the recurring job
  via `CronDelete` instead of continuing to ping indefinitely. Total idle is
  anchored to a persisted `idleSince` (cleared by the next real prompt) — each
  ping turn's own `Stop` bumps `lastEventAt`, so the raw gap alone could never
  accumulate past one interval.

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
