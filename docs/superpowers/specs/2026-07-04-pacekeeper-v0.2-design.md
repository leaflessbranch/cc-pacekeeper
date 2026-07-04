# cc-pacekeeper v0.2 design

Five features extending the v0.1 tick/checkpoint core: time & AFK awareness, cross-session budget awareness, checkpoint × worktree integration, worktree lifecycle helpers, and AFK cache keepalive with block-reset bridging.

Doc claims verified against the Claude Code docs (worktrees, hooks, scheduled-tasks, prompt-caching, plugins-reference pages) on 2026-07-04. Design resolutions below reflect a full grilling pass on the same date.

## Prior art

- Timestamp injection exists as standalone plugins (claude-code-message-timestamps, claude-code-timestamps) and an open upstream feature request. Differentiator here is integration: one injected line carries time + meters + AFK episodes, with idle-gating to control token cost.
- A cache-keepalive plugin exists (Stop-hook `decision: "block"` pinging before a 5-minute TTL). It cannot span long AFK gaps (Stop hooks only run at turn boundaries); the scheduled-task approach below can.
- No prior art found for: injecting usage meters into the model's context (v0.1 core), cross-session budget awareness, block-reset bridging, or model-family arbitrage.
- Community reports claim the default cache TTL has changed without notice in the past. All TTL-dependent timing is therefore config, not constants.

## 1. Time & AFK awareness

Inject a compact status line via the existing `pacekeeper-tick` hook — no new hooks:

```
[pacekeeper] Fri 2026-07-04 18:42 IST · session 2h13m · idle 47m · ctx 19% · 5h 93% (2h29m) · week 42%
```

- **Cadence (grilled):** every `UserPromptSubmit` unconditionally (v0.1 injects only at notify+; this is a deliberate behavior change — the steady clock is the feature). On `PreToolUse`, inject only when ≥ `time.toolTickMin` (default 5) minutes have passed since the last injected timestamp, so long tool loops (log digging, builds) get fresh time context without per-call bloat. `Stop`/`SessionStart` behavior unchanged.
- Timestamp: local date, time, timezone from the machine locale. Personalized per user/timezone automatically; eliminates in-session `date` executions and stale-date confusion.
- `state.json` gains `sessionStartedAt` and `lastEventAt`; ticks derive `session <elapsed>` and `idle <gap>`. `idle` is shown only when the gap exceeds `time.idleThresholdMin` (default 10).
- AFK episodes: a gap above threshold is recorded (`awayFrom`/`awayTo`) and surfaced once on return ("user was away 3h12m") so Claude re-orients.
- No manual `<system-reminder>` wrapping needed: the harness wraps hook `additionalContext` in system-reminder tags client-side, on all billing types.

## 2. Cross-session budget awareness

Parallel sessions share the account-level 5h and weekly budgets; Claude should know it is one of N consumers.

- **Mechanism (grilled):** read Claude Code's native live-session registry at `~/.claude/sessions/<pid>.json` (fields: `pid`, `sessionId`, `cwd`, `status`, `updatedAt`). Liveness is definitive: the entry's `pid` is checked against `/proc`. No pacekeeper-side heartbeat files; pure reader.
- When more than one session is live, the tick line appends: `· 3 live sessions sharing budget`.
- **Risk:** the registry is an undocumented internal format. Parse zod-safe; on schema mismatch degrade to omitting the session count (never crash the tick).

## 3. Checkpoint × worktree integration

Claude Code worktrees live at `.claude/worktrees/<name>/` on branch `worktree-<name>`; the `EnterWorktree` tool switches into them mid-session.

- **Anchoring:** `resolve-root.ts`'s `gitToplevel()` gains worktree detection: resolve `git rev-parse --git-common-dir`, and when it points outside the toplevel (i.e. we are in a linked worktree), anchor to the main repo root (dirname of the common `.git` dir). All worktrees then share one `.claude-checkpoints/`, so a checkpoint saved in a dying worktree session is visible from anywhere.
- **Provenance:** checkpoint frontmatter records `worktree` (path) and `branch` when saved from a worktree.
- **Resume:** if the recorded branch still exists, the checkpoint skill instructs Claude to `EnterWorktree` back into it (recreating from the branch if the directory was removed) before resuming.

## 4. Worktree lifecycle helpers

A thin `worktree` skill (same pattern as the checkpoint skill). Claude Code does the heavy lifting natively; the skill wires worktrees to checkpoints and live sessions:

- `list` — worktrees with branch, dirty/clean state, and whether a live session (per §2 registry) has its cwd there.
- `new [name]` — create/enter via `EnterWorktree`; reminds about `.worktreeinclude` for gitignored env files.
- `cleanup` — remove merged/abandoned worktrees, respecting Claude Code's rules (never auto-remove dirty trees; `--force` only on explicit user confirmation).

Note: project-scope plugins auto-load in worktrees of the same repo (Claude Code ≥ 2.1.200), so pacekeeper works inside every worktree without reinstall.

## 5. AFK cache keepalive + block-reset bridging

**Verified mechanics:**

- On a Claude subscription, Claude Code requests the 1-hour cache TTL automatically; every cache-hitting request resets the timer. TTL drops to 5 minutes on API billing or when drawing on pay-as-you-go usage credits.
- Scheduled tasks (`CronCreate` one-shots) fire between turns in the same open session while Claude is idle. A fire is a normal turn: it reads the cached prefix (~10% of input rate) and resets the TTL. No daemon, no transcript forking.
- Limitation (accepted): tasks fire only while the session/terminal stays open. Machine sleeps → cache lapses → first prompt back is slower. Nothing breaks.

**Rolling one-shot keepalive (grilled):**

1. The per-prompt tick line, when `state.json`'s keepalive schedule is stale (> ~10 min), appends one compact directive: replace the pending keepalive one-shot with a new one `keepalive.intervalMin` (default 50, config because TTL is volatile) minutes out. The one-shot's prompt carries its own continuation logic: reply in one word; if the user is still idle, schedule the next one-shot. Marker string `[pacekeeper-keepalive]` in the prompt text.
2. **Verification, not trust (grilled):** the tick already parses the transcript; it scans for the most recent `CronCreate` tool_use carrying the marker (and any later `CronDelete` of that ID). That is ground truth for whether a keepalive is pending. If an instruction wasn't followed, the next tick re-instructs. Self-healing; worst case (last instruction before AFK ignored) the cache lapses.
3. On user return, the tick notes the AFK episode and directs Claude to cancel the pending one-shot.
4. Fires only during genuine absence — no junk turns while the user is active.

No context-size gate and no cap on consecutive keepalives. Auto-disable only when usage credits / API billing is detected (5-minute TTL makes pinging uneconomical); pacekeeper already reads credit state.

**Unattended permissions (grilled):** a scheduled fire's permission prompt offers only "Allow once" (upstream limitation), so manual approval can't sustain the chain. Pacekeeper ships a narrowly-scoped auto-approve hook:

- `PreToolUse` on `CronCreate`: emit `permissionDecision: "allow"` only when the task prompt contains `[pacekeeper-keepalive]`.
- `PreToolUse` on `CronDelete`: allow only when the target ID matches the pending keepalive task reconstructed from the transcript scan.
- All other cron usage goes through normal permissions. Behavior disclosed in README; disabled together with `keepalive.enabled`. Fallback if approval still fails: Claude replies its one word and lets the chain lapse gracefully — never stalls the session on a prompt nobody will answer.

**Block-reset bridging (5h meter, grilled):**

When the 5h block is at/near threshold and the next reset is < `bridge.maxWaitMin` (default 60) away:

- Do not push a checkpoint. Claude keeps working normally; the directive changes to "reset in Xm — bridge wakeup scheduled as safety net."
- Schedule a single one-shot for reset + ~2 minutes (after, not before: an exhausted block rejects requests until reset). If work stalls on exhaustion mid-task, the post-reset fire resumes it with a warm cache; in-flight tool state from a hard-failed turn is lost, conversation and cache survive.
- On fire, meters read fresh and warnings clear. Checkpoint remains the fallback when reset is beyond the TTL horizon or the user is wrapping up.

**Weekly meters — no bridge exists** (a ~1h TTL cannot span days). Instead:

- **Model-family arbitrage (grilled):** nudge only when *all three* hold: current model's family weekly meter ≥ warn, all-models meter < warn (otherwise nothing to arbitrage into), and the target family < notify. Same debounce machinery as other meters. Strictly advisory — the user decides; the nudge discloses that a model switch costs one full uncached re-read (per-model cache).
- Otherwise, weekly exhaustion stays checkpoint territory.

## Config additions (`config.ts` pattern)

```
time.idleThresholdMin      default 10
time.toolTickMin           default 5
keepalive.enabled          default true (auto-off on usage credits / API billing; also disables the auto-approve hook)
keepalive.intervalMin      default 50   (assumed-TTL-derived; TTL has changed upstream without notice)
bridge.enabled             default true
bridge.maxWaitMin          default 60
```

(§2 needs no config: registry reading is free and degrades silently.)

## Build order

1. §1 time/AFK (state + tick line) → verify: unit tests on gap/elapsed derivation and PreToolUse drift gating; manual tick output.
2. §2 session registry → verify: two concurrent sessions see each other; dead-pid entries excluded; malformed registry degrades silently.
3. §3 checkpoint × worktree → verify: resolve-root tests for linked worktree vs main checkout; save/resume round-trip from a worktree.
4. §4 worktree skill → verify: smoke-run list/new/cleanup.
5. §5 keepalive + bridge → verify: transcript-scan unit tests (marker create/delete reconstruction); auto-approve hook fires only on marker; live AFK test observing `cache_read_input_tokens` across a fire.

Each lands as its own small change on this branch with a patch version bump (project convention), merged to main when the branch soaks clean.
