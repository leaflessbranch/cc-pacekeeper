# Codex acceptance ledger

What the opt-in Codex package (`plugins/codex-pacekeeper/`) implements against
the 27-row parity table in issue #19, what the evidence is, and what still
needs a live Codex session. The Claude package is the reference: where Codex
can do what Claude does, it does it the same way; where it cannot, the row says
why.

Target: Codex CLI **0.160.0**. Every native fact below was read from the
`openai/codex` source at tag `rust-v0.160.0`; the method table and hook stdin
schemas are pinned in
`plugins/codex-pacekeeper/src/__tests__/fixtures/native-0.160.0/protocol.json`,
and a test fails if a method or hook field the package relies on disappears.

## Native facts that shape the design

| Fact | Source | Consequence |
|---|---|---|
| Every hook's `session_id` is the **root** thread id of the agent tree; a child's hooks add `agent_id`, which is the **child's own thread id**. No hook carries `thread_id` or `account_id`. | `core/src/hook_runtime.rs` (`subagent_hook_context` uses `sess.thread_id()`; `Session::session_id` is "the identity shared by the root thread and all descendant threads") | A hook's thread is `agent_id ?? session_id`; `agent_id` being absent is how main-thread behavior is selected, exactly as in Claude. |
| A hook's `transcript_path` is the rollout of the thread the hook runs in (SubagentStop also gets `agent_transcript_path` for the child). The rollout's first line is `session_meta` with `id`, `parent_thread_id` and `creator_account_id`. | `core/src/hook_runtime.rs`, `protocol/src/protocol.rs` (`SessionMeta`) | SubagentStart learns the child's parent from the child's own rollout — no socket call, no race with other hooks. |
| Every model response appends a `token_count` event carrying `info` (current-turn token usage, context window) **and** `rate_limits` (the default `codex` bucket: five-hour and weekly windows with `window_minutes` and `resets_at`). It is persisted to the rollout. | `core/src/session/mod.rs` (`send_token_count_event`), `rollout/src/policy.rs` | The hook reads context and quota from the rollout tail, as Claude reads its transcript. After a compaction Codex sends a fresh estimate, so only a compaction newer than the last count invalidates context — a turn start does not. |
| Tool shells get `CODEX_THREAD_ID` (and `CODEX_SESSION_ID`). There is no account variable. | `protocol/src/shell_environment.rs`, `core/src/exec_env.rs` | The checkpoint CLI defaults its thread id from the environment; the account comes from the native read, the account record or the rollout metadata. |
| Hook handlers for one event run concurrently. | `hooks/src/engine/dispatcher.rs` (`FuturesUnordered`) | Tick never depends on another hook's output, and per-record writes go through a lock. |
| `Stop`/`SubagentStop` can only answer `decision: block` + `reason` (re-opens the turn; for SubagentStop, the *child's*). `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `SubagentStart` take `additionalContext`. `PreCompact`/`PostCompact` cannot reach the model. | `hooks/schema/generated/*.command.output.schema.json` | Stop speaks only for the directives Claude also continues a turn for; compaction is handled at context-critical and on `SessionStart(source: compact)`, as in Claude. |
| `thread/queue/add` enqueues a user message; when the thread is idle the queue extension starts it at once, otherwise when the current turn ends. | `ext/queue/src/service.rs` (`enqueue` → `wake_if_loaded` → `dispatch_if_idle`) | This is Codex's equivalent of a Claude cron firing into an idle session: keepalive pings and reset wakes are queued messages. |
| No turn option disables tools, and `thread/queue/delete` does not prove it wins a race with execution. | `app-server-protocol` v2 `TurnStartParams`, queue processor | Neither does Claude's cron keepalive. Both packages instruct the model (reply `pong`, no tools) and record a non-exact reply instead of treating it as fatal. |

## Capability ledger

Status: **implemented** = built and covered by automated tests (Codex unit
tests, the fake-control-socket end-to-end test, and the parity suite);
**live gate** = still needs a trace in a real authenticated Codex session;
**deferred** = out of Codex scope, with the reason.

| # | Capability | Status | Notes |
|---:|---|---|---|
| 1 | Subscription authentication | implemented · live gate | `account/read` and `ordinaryUsageAllowed` classify capacity; API-key/unsupported accounts get a one-time SessionStart note and no automation. Logout/account-switch traces are live gates. |
| 2 | Quota acquisition | implemented | From the rollout's `token_count.rate_limits` on every response, plus the detached native `account/rateLimits/read` (multi-bucket, account id). Windows map by duration; unknown buckets are kept. |
| 3 | Context meter | implemented | Rollout `last_token_usage` over `model_context_window`; survives turns; unknown right after a compaction until Codex's next count. |
| 4 | Compact status injection | implemented | Claude's line: wall time · session age · idle · ctx · 5h (reset) · week, plus child burn (`agents ~N%`). Every prompt; tool calls every `time.tool_tick_min`. |
| 5 | Threshold state machine | implemented | Same ladder and defaults; parity tests run both packages' level functions on the same inputs. |
| 6 | Debounce / idempotency | implemented | Escalation bypasses debounce; same level re-emits after `debounce_seconds`; the end-of-turn reminder fires once per level per block. Stop never re-opens a turn for a notify-level meter (review #2). |
| 7 | Time and AFK awareness | implemented | Session age, idle segment, one-time "You were away" line; keepalive pings are transparent to the idle clock. |
| 8 | Cross-session awareness | pending | Claude's "N live sessions sharing budget" segment is not ported. Worktree cleanup does use live Codex sessions (row 22). |
| 9 | Model/window arbitrage | deferred | Codex exposes no per-model-family weekly bucket to arbitrage between. |
| 10 | Checkpoint lanes | implemented | Claude semantics: any session in the project may save to or resume a lane (review #1); `resume` prints and archives in one step; goal lock with `--goal-changed`; save without a body prints the template. Codex lanes stay isolated from Claude's. |
| 11 | Context auto-save | implemented | At context critical, the next prompt, tool call or turn end carries "save now, do not ask" with the exact command, once per climb; re-armed by compaction. `SessionStart(source: compact)` re-injects this session's checkpoint. |
| 12 | Five-hour renewal | implemented · live gate | At `auto.five_hour_pct`, once per block, the directive says save now; the save registers a one-shot wake for reset + `wake_delay_min` (any reset within the block, not only the bridge window). The service delivers `[pacekeeper-resume] <id>` after verifying a fresh post-reset window; the hook injects Claude's resume orientation. A real reset cycle is a live gate. |
| 13 | Near-reset bridge | implemented | The "wait it out" directive under the same conditions as Claude (parity test). |
| 14 | Resume consumption | implemented | `resume` archives; replaying an id reports already consumed; a crash between claim and archive is recovered by the next resume. The wake completes only when its checkpoint id reaches the archive. |
| 15 | Subagent budgets | implemented | Spawn-relative pause point identical to Claude's (parity test); child tick line and pause directive; spawn anchor rebases on a new block. |
| 16 | Subagent handoffs | implemented · live-verified | Keyed by `agent_id` (the child thread), with child and parent recorded as provenance (review #3). The parent is shown each of its children's handoffs once on its next prompt or tool call; `handoffs archive` after re-dispatch. Traced live on 0.164.0 (see below). |
| 17 | Dispatch advisory | implemented | Advises (never denies) before `spawn_agent` at 5h warn+. |
| 18 | Cache keepalive | implemented · live gate | Need-based (pending checkpoint or handoff), one job per thread, first ping one full idle interval after the last real hook event, suppressed by the hook if the user was active moments ago, 12-hour idle ceiling, included capacity only. The service queues `[pacekeeper-keepalive] ping`; the hook adds the reply-`pong`-no-tools guidance; the completed turn is read back and a non-exact reply or tool call is recorded for `doctor`. Delivery, the `pong` readback and doctor's last-ping report are traced live on 0.164.0; the cache-TTL question is open (see below). |
| 19 | Cache observability | implemented | Cached-input tokens from the rollout; `doctor` reports them and the last ping's reply. |
| 20 | Presence detection | pending | The Linux probe fusion runs in the background service, but Codex has no plugin monitor to deliver presence changes, so nothing acts on it yet. |
| 21 | Away routing | deferred | Depends on a delivery path Codex does not offer (row 20); no channel is requested or stored. |
| 22 | Worktree helper | implemented | list / new / cleanup; dirty, locked or occupied worktrees are refused; occupancy from live Codex sessions (hooks ran within two hours, not ended) and Claude's session registry. |
| 23 | Security-scoped automation | implemented | Jobs are bound to account and thread; delivery re-verifies the account on the live control socket and never starts a server; state paths are hashed and symlink-checked. |
| 24 | Diagnostics | implemented | `pacekeeper-checkpoint doctor` / `pacekeeper-doctor`: rollout readings, control socket, thread hosted, queue support, auth, quota age, keepalive service, last ping, hook trust, crash breadcrumbs. |
| 25 | Configuration | implemented | Same schema and defaults; the Claude config is read as input and never written; `adapters.codex` overrides. |
| 26 | Platform behavior | implemented · live gate | Linux and macOS CI for all three suites. A native macOS Codex session is a live gate. |
| 27 | Documentation and release | implemented | README, skills, this ledger, changelog; opt-in Codex marketplace entry. |

## Background service

Codex has no in-session cron for the model, so keepalive and reset wake are
delivered by `pacekeeper-service watch`. A turn end with pending work (or a
save that registers a wake) launches it detached; it is a singleton (lock file
plus heartbeat), exits after about a minute with nothing to deliver, and prunes
records older than its retention windows. Hooks never list state directories.

## Live gates

These need an authenticated Codex session and are not claimed by the offline
suites:

1. The cache-TTL question from issue #19: whether 30-minute pings keep a
   thread's prefix warm, and whether it would have gone cold without them.
2. A real five-hour reset: save at the auto threshold, wake delivered after the
   reset, checkpoint resumed and archived, no duplicate wake.
3. A spawned child reaching its pause point, writing a handoff, and the parent
   absorbing and archiving it.
4. Logout, account switch and an API-key session.
5. The same on macOS.

The previous pass's authenticated Linux run (PR #21 comment of 2026-10-02)
confirmed installation and hook trust, subscription and quota reads, context
and cache figures matching the rollout, real parent/child execution, and the
checkpoint CLI. Its one failure — child ownership never persisted — is the
`agent_id`/`session_id` mix-up fixed in this pass.

## Live acceptance on Codex 0.164.0 (Linux, 2026-10-26)

An authenticated ChatGPT Plus session in the TUI, the plugin enabled through a
disposable project's `.codex/config.toml`, hooks trusted at the prompt.

| Check | Result |
|---|---|
| Install, hook trust, status line on every prompt | pass |
| Control socket, loaded-thread check, queue methods (experimental in 0.164, opted into at `initialize`) | pass, after the symlink fix below |
| Model-driven `save` through the skill, inside the workspace-write sandbox | pass; the wake is registered by the Stop hook (fix below) |
| Child pause: contract injected, `PAUSED-BUDGET <agent_id>` returned, handoff written from the sandbox | pass |
| Parent absorb: shown the handoff once as a developer message at its next tool call, `handoffs archive`, not shown again | pass |
| Keepalive: `[pacekeeper-keepalive] ping` queued into the idle TUI thread, answered `pong` with no tools, read back as verified, successor scheduled, `doctor` reports the last ping | pass, after the timeout fix below |
| Cache warmth | inconclusive: a ping 30 minutes after the last turn read only the shared system prefix from cache (12,032 of 26,134 input tokens); a later turn 69 minutes after the previous one, with no ping between, read 25,984 of 26,153. OpenAI's cache is not a fixed TTL here, so two samples settle neither question in gate 1. |

Defects the live run found, each fixed with a regression test:

- **The control socket is a symlink.** 0.164 publishes
  `app-server-control.sock` as a symlink into `/tmp/codex-daemon-<uid>/`; the
  entry was refused, so keepalive, the wake and the account read never ran.
- **The sandbox blocks the CLI's state writes.** The model's `save` runs inside
  the workspace-write sandbox, where `~/.cache` is read-only, so every wake
  registration failed with `EROFS`. The Stop hook (unsandboxed) now registers
  it from the saved checkpoint, only when the checkpoint's account and reset
  match what the hook observed itself.
- **Discovery timed out on the backend read.** `account/rateLimits/read` takes
  about 0.8-1.1s live and discovery allowed 750ms, so with a known account it
  reported no owner, capacity read as unknown, and every keepalive after the
  first was cancelled. The detached refresh lost its quota read the same way.
- **doctor never saw a ping.** A keepalive id is stable per thread, so the
  successor overwrote the completed record; the successor now carries it.
- `SessionEnd` and `Interrupt` hook timeouts exceeded Codex's 3s cap.

Operational notes:

- Any `-c` override runs Codex in embedded mode without the shared background
  server, so a session started with one has no control socket for keepalive
  or the wake.
- Reinstalling the plugin asks for hook trust again, and a running
  `pacekeeper-service watch` keeps executing the old snapshot until it exits.
- A child whose first tool calls precede its first `token_count`, with no
  fresh account record, has no five-hour reading and therefore no pause
  decision; this is the designed fail-closed path.

## Verification

| Suite | Command | Result |
|---|---|---|
| Codex | `bun test` in `plugins/codex-pacekeeper` | 308 pass |
| Codex typecheck | `bun run typecheck` in `plugins/codex-pacekeeper` | clean |
| Parity | `bun test` in `tests/parity` (after `bun install` in both plugins) | 45 pass |
| Parity typecheck | `bun run typecheck` in `tests/parity` | clean |
| Claude | `bun test` in `plugins/cc-pacekeeper` | 418 pass, package unchanged |
