# cc-pacekeeper v0.2 design

Five features extending the v0.1 tick/checkpoint core: time & AFK awareness, cross-session budget awareness, checkpoint × worktree integration, worktree lifecycle helpers, and AFK cache keepalive with block-reset bridging.

All doc claims below were verified against the Claude Code docs (worktrees, hooks, scheduled-tasks, prompt-caching pages) on 2026-07-04.

## 1. Time & AFK awareness

Extend the existing `pacekeeper-tick` injected line — no new hooks:

```
[pacekeeper] Fri 2026-07-04 18:42 IST · session 2h13m · idle 47m · ctx 19% · 5h 93% (2h29m) · week 42%
```

- Timestamp: local date, time, timezone abbreviation from the machine's locale. Personalized per user/timezone automatically; eliminates in-session `date` executions and date confusion.
- `state.json` gains `sessionStartedAt` and `lastEventAt`; each tick updates `lastEventAt` and derives `session <elapsed>` and `idle <gap>`.
- `idle Xm` is printed only when the gap since the last event exceeds `time.idleThresholdMin` (default 10) — normal back-and-forth adds no tokens.
- AFK tracking: when a tick observes a gap above threshold, it records an AFK episode (`awayFrom`/`awayTo`) in state and surfaces "user was away 3h12m, back now" once on return, so Claude can re-orient (stale assumptions, changed files, expired short-term plans).

## 2. Cross-session budget awareness

Parallel sessions (worktrees or otherwise) share the same account-level 5h and weekly budgets. Claude in each session should know it is not the only consumer.

- Each tick writes a heartbeat: `~/.claude/pacekeeper/sessions/<session_id>.json` with `cwd`, `model`, `lastSeenAt`.
- A session is *live* if its heartbeat is under 2 minutes old (ticks fire at minimum on every prompt and tool call). Stale heartbeats are deleted opportunistically on each tick.
- When more than one session is live, the tick line appends: `· 3 live sessions sharing budget`.
- Purely local; no API calls. `session_id` and `cwd` come from standard hook input fields.

## 3. Checkpoint × worktree integration

Claude Code worktrees live at `.claude/worktrees/<name>/` on branch `worktree-<name>`; the `EnterWorktree` tool switches into them mid-session.

- **Anchoring:** in a worktree, `git rev-parse --show-toplevel` returns the worktree root. `resolve-root.ts` gains worktree detection (`git rev-parse --git-common-dir` → main repo root) and anchors `.claude-checkpoints/` to the **main repo root**, so all worktrees share one checkpoint directory and a checkpoint saved in a dying worktree session is visible from anywhere.
- **Provenance:** checkpoint frontmatter records `worktree` (path) and `branch` when saved from a worktree.
- **Resume:** the checkpoint skill's `resume` flow checks provenance. If the recorded branch still exists, it instructs Claude to `EnterWorktree` back into that worktree (recreating it from the branch if the directory was removed) before resuming work.

## 4. Worktree lifecycle helpers

A thin `worktree` skill in the plugin (same pattern as the checkpoint skill). Claude Code does the heavy lifting natively (`EnterWorktree`, `--worktree`, `git worktree`); the skill's value is wiring worktrees to checkpoints and heartbeats:

- `list` — worktrees with branch, dirty/clean state, and whether a live pacekeeper heartbeat maps to each.
- `new [name]` — create/enter via `EnterWorktree`; reminds about `.worktreeinclude` for gitignored env files.
- `cleanup` — remove merged/abandoned worktrees, respecting Claude Code's rules (never auto-remove dirty trees; `git worktree remove --force` only on explicit user confirmation).

Note: project-scope plugins auto-load in worktrees of the same repo (Claude Code ≥ 2.1.200), so pacekeeper itself works inside every worktree without reinstall.

## 5. AFK cache keepalive + block-reset bridging

**Verified mechanics (prompt-caching + scheduled-tasks docs):**

- On a Claude subscription, Claude Code requests the **1-hour cache TTL** automatically. Every cache-hitting request resets the timer. TTL drops to 5 minutes only on API billing or when the account has overflowed onto pay-as-you-go usage credits.
- Scheduled tasks (`CronCreate` one-shots / self-scheduled wakeups) fire **between turns in the same open session** while Claude is idle. A fire is a normal turn on the same conversation: it reads the cached prefix (billed at ~10% of input rate; on subscription, a small nibble of plan limits) and resets the TTL. No daemon, no `claude -p`, no transcript forking.
- Limitation (accepted): tasks only fire while the session/terminal stays open. If the machine sleeps or the session closes, the cache lapses and the first prompt back is simply slower.

**Keepalive flow:**

1. Tick detects the user has gone idle (per §1 AFK tracking).
2. Tick injects an instruction: schedule a **one-shot** keepalive wakeup ~50 minutes out (one-shots at a non-`:00`/`:30` minute avoid recurring-task jitter; margin kept under the 60-minute TTL) with a trivial prompt: respond in one word, reschedule the next one-shot if the user is still away.
3. On user return (next real prompt), the pending keepalive is cancelled (`CronDelete`) and the tick notes the AFK episode.

No context-size threshold and no cap on consecutive keepalives: the session keeps itself warm indefinitely while open. The only auto-disable: **usage credits / API billing detected** (TTL is 5 minutes there; sub-5-minute pinging is never economical). Pacekeeper already reads limit/credit state, so this is a tick-side check.

**Block-reset bridging (5h meter):**

When the 5h block is at/near its warning threshold **and** the next block reset is less than ~1 hour away (pacekeeper already computes time-to-reset), do **not** push a checkpoint. Instead:

- Schedule a single one-shot wakeup for **reset + ~2 minutes**. The 1-hour TTL carries the cache across the gap unaided; the post-reset fire refreshes it before expiry.
- Timing after the reset matters: a fully exhausted block rejects requests until reset, so a fire during the dying block could error.
- On fire, meters read fresh, threshold warnings clear automatically, and the session continues with a warm cache — no checkpoint/resume ceremony.
- Checkpoint remains the fallback when reset is further than the TTL horizon or the user is ending work.

**Weekly meters:** no bridge exists — a 1-hour TTL cannot span days, and chaining keepalives against an exhausted weekly meter is self-defeating. Two behaviors instead:

- **Model-family arbitrage:** weekly limits are tracked per family (all-models, Sonnet, Opus). When one family is nearly exhausted but another has headroom, the tick nudges Claude to surface a model-switch suggestion (e.g. "Opus weekly nearly gone; Sonnet has 60% left"). Caveat surfaced with it: each model has its own cache, so switching costs one full uncached turn — usually worth it against a multi-day wait.
- Otherwise, weekly exhaustion stays checkpoint territory.

## Config additions (`config.ts` pattern)

```
time.idleThresholdMin      default 10
sessions.heartbeat         default true
keepalive.enabled          default true (auto-off on usage credits / API billing)
keepalive.intervalMin      default 50
bridge.enabled             default true
bridge.maxWaitMin          default 60
```

## Build order

1. §1 time/AFK (state + tick line) → verify: unit tests on gap/elapsed derivation; manual tick output.
2. §2 heartbeats → verify: two concurrent sessions see each other; stale sweep works.
3. §3 checkpoint × worktree → verify: resolve-root tests for worktree vs main checkout; save/resume round-trip from a worktree.
4. §4 worktree skill → verify: smoke-run list/new/cleanup.
5. §5 keepalive + bridge → verify: injected instruction appears under simulated idle/near-reset state; live AFK test of a scheduled fire resetting the cache (observe `cache_read_input_tokens`).

Each lands as its own small change to main with a patch version bump (project convention).
