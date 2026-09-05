# Codex acceptance ledger

This document records the implementation evidence for issue #19. It keeps
native facts, deterministic policy behavior, and unverified live outcomes
separate. The Codex package is opt-in and has its own state subtree; the
shipped Claude package remains at version 0.8.2 and is not rewritten here.

## Baseline

- Base: `2751789890e13f0c5ca0d33bb7097a7e45666d48`.
- Claude verification: `bun test --cwd plugins/cc-pacekeeper`
  in a child process with disposable HOME/config/cache: 342 passed, 0 failed.
- Claude typecheck: `bun run --cwd plugins/cc-pacekeeper typecheck`:
  exit 0.
- The supplied `/tmp` worktree reproduces five existing path-safety fixture
  failures because the Claude tests intentionally reject project roots under
  `/tmp`; this is why the baseline was also run from the safe original
  checkout. No tracked Claude file was changed.

## Native boundary evidence

The acceptance target is Codex CLI 0.153.4. The generated local protocol
schema and the pinned release source establish `thread/queue/add` with
`threadId`, `input`, and a stable caller-provided `clientUserMessageId`.
Queue acceptance is tracked independently from turn completion.

### Verified against the pinned schema and source

Each of the following was checked directly, not inferred from a hook name.

| Assumption | Verdict | Where checked |
|---|---|---|
| `thread/queue/add` params are `threadId`, `input`, `clientUserMessageId` | confirmed | `ThreadQueueAddParams`, all three required |
| The add response carries a flat submission id | **refuted** | `ThreadQueueAddResponse` requires a nested `queuedSubmission` object holding `id`, `clientUserMessageId`, `input`. The pinned CLI reads `response.queued_submission.id`. |
| `turn/start/tools-disabled`, `turn/input/suppress`, `turn/compact/save-barrier` exist | **refuted** | None of the 155 `ClientRequest` methods matches. These names appear in no published version. |
| `TurnStartParams` exposes a tool-disable field | **refuted** | Its 24 properties include `outputSchema`, `sandboxPolicy` and `permissions`, but no `tools` or `tool_choice`. None of those three is a no-tools boundary. |
| Quota windows can be mapped by primary/secondary position | **refuted** | `RateLimitWindow` carries `windowDurationMins`; both orderings occur in real records, so mapping is by duration. |
| The rate-limit reply is a single snapshot | **refuted** | `GetAccountRateLimitsResponse` wraps a compatibility `rateLimits` view plus a `rateLimitsByLimitId` multi-bucket map, with `accountId`, `limitId`, `limitName` and `rateLimitReachedType`. |
| Current context can be read from native usage | confirmed | `ThreadTokenUsage` separates `last` from `total` and carries a nullable `modelContextWindow`. |
| Cache fields are observable | confirmed | `TokenUsageBreakdown` has `cachedInputTokens` (required) and `cacheWriteInputTokens` (optional, so absent is not zero). |
| Fixture method names are real | confirmed | All eight resolve; the queue family is broader than recorded (`reorder`, `start`, `update` also exist). |

### Blocked by a missing platform capability

These are not unfinished work. Two independent sources agree that the
capability does not exist, so the rows stay incomplete rather than being
satisfied by a weaker substitute.

- **Strict no-tools (row 18).** The protocol has no tool-disable field or
  method, and the official hooks documentation states there is no blanket
  no-tools mode: `PreToolUse` denies individual calls only. Coverage is also
  incomplete by design — hosted tools such as web search do not take the local
  function-tool hook path, and `write_stdin` on an existing exec session does
  not re-run `PreToolUse`. A deny-all hook is therefore not a boundary, and a
  prompt instructing no tools is not enforcement.
- **Pre-model suppression of a queued synthetic message (row 18).** No method
  removes or suppresses a queued submission before model work begins. A queued
  ping that loses a race with real user input cannot currently be withdrawn
  before it reaches the model.
- **A save barrier before compaction (row 11).** `PreCompact` ignores plain
  stdout; JSON stdout only supports the common fields, so a hook can prevent
  compaction via `continue: false` but cannot cause a model-generated
  resumable save. Preventing compaction is not the same as having saved.

Sources: the generated 0.153.4 schema, the pinned release source
(`session_queue_commands.rs`), and <https://learn.chatgpt.com/docs/hooks>.

## Capability ledger

| # | Capability | Status | Evidence or remaining gate |
|---:|---|---|---|
| 1 | Subscription authentication | partial | Capacity classification implemented and tested: unknown/paid/unsupported never read as included, and available credits never imply paid spending. Remaining: a real API-key negative case and a live paid-credit transition. |
| 2 | Quota acquisition | partial | Duration-based mapping tested in both native orderings; unknown buckets retained; the multi-bucket `rateLimitsByLimitId` map parsed; a malformed percentage stays null instead of reading as 0. Remaining: only the `codex` bucket id has ever been observed, so no model-family mapping is claimed. |
| 3 | Context meter | partial | Reads `last`, not lifetime `total`; a missing `modelContextWindow` yields an unknown percentage rather than inheriting Claude's 200k. Remaining: live comparison against a running thread. |
| 4 | Compact status injection | partial | Per-event encoding implemented in policy.decide: events that cannot carry context never inject, and a Stop under an active continuation does not re-enter. Remaining: the hook wiring that would deliver it. |
| 5 | Threshold state machine | partial | The shipped Claude ladder is executed by the parity corpus against the EFFECTIVE config, including inclusive boundaries and stale-reset handling. Remaining: the Codex-side state machine itself. |
| 6 | Debounce/idempotency | partial | Ordinary re-emission after the debounce window, immediate escalation, no injection on a level drop, and state keyed by hashed account/thread/agent. Remaining: wiring to real events. |
| 7 | Time/AFK awareness | partial | A synthetic turn suppresses policy output and does not advance the user-activity anchor, so a ping cannot masquerade as presence. Remaining: idle accounting against real event streams. |
| 8 | Cross-session awareness | partial | findExistingOwner counts only live, known-account owners and refuses to assume liveness. Remaining: the heartbeat source that supplies those records. |
| 9 | Model/window arbitrage | deferred | Existing Claude behavior is preserved; no Codex arbitrage. |
| 10 | Checkpoint lanes | partial | Owned subtree, exact-id selection, verified persistence, ambiguous bare resume consuming nothing, and a regression test proving a same-named Claude lane is untouched. Remaining: the CLI surface. |
| 11 | Context auto-save | blocked | Confirmed unavailable, not merely unproved: `PreCompact` ignores plain stdout and can only prevent compaction via `continue: false`; it cannot cause a model-generated resumable save. Preventing compaction is not saving. |
| 12 | Five-hour renewal | partial | Reset-wake is a separate job identity carrying a reset generation, and a rolled-over window blocks automation until re-read. Remaining: live reset trace. |
| 13 | Near-reset bridge | pending | Bounded wait decision; live wait evidence still required. |
| 14 | Resume consumption | partial | Resume archives rather than deletes, a replayed id reports already-consumed, and reconcile() matches an interrupted attempt by stable submission id without inventing a new one. Remaining: end-to-end run. |
| 15 | Subagent budgets | partial | Spawn-relative estimate explicitly labelled shared-account, reset rollover rebases instead of going negative, and an unreadable meter never pauses on a guess. Remaining: native lifecycle wiring. |
| 16 | Subagent handoffs | pending | Contract text and pause marker exist; the handoff write path and parent absorption are not implemented. |
| 17 | Dispatch advisory | partial | dispatchAdvice never denies; its deny field is typed as the literal false so an advisory cannot become a denial without a type change. Remaining: the native spawn-tool mapping. |
| 18 | Cache keepalive | blocked | Confirmed unavailable: no protocol field or method disables tools, and the hooks documentation states there is no blanket no-tools mode while hosted web search and post-exec `write_stdin` bypass `PreToolUse` entirely. No method withdraws a queued submission before model work. The 30-minute cadence and one-hour TTL assumption stand; delivery is not the blocker, enforcement is. |
| 19 | Cache observability | partial | `cachedInputTokens` and the optional `cacheWriteInputTokens` are read, with absent distinguished from zero. Remaining: surfacing them in diagnostics. |
| 20 | Presence detection | partial | Fusion ported with the asymmetry intact: an unavailable probe never votes afk, and attachment requires recent activity. Remaining: the probes themselves and a live away/back observation. |
| 21 | Away routing | deferred | Existing Claude routing is preserved; no Codex channel onboarding. |
| 22 | Worktree helper | pending | Skill documents the refusal rules; no implementation yet. |
| 23 | Security-scoped automation | partial | Job identity covers kind, account and thread so one job cannot cancel another; ids and lanes are sanitized against traversal. Remaining: the scheduling surface that would need authorizing. |
| 24 | Diagnostics | partial | Distinct owner/queue/auth/quota/config failures, blocked rows never reported ok, deferred rows shown as deferred, and no identifiers in the output. Remaining: hook-trust and executable checks. |
| 25 | Configuration | partial | The frozen contract is the EFFECTIVE config, not package defaults, and the parity corpus proves the two differ on every meter (five-hour 50/80/90 vs 70/85/95; context 0/70/85 vs 60/75/90; weekly 50/95/98 vs 50/70/85; require_pending false; max_idle_hours 72). Remaining: the Codex `adapters.codex` override path. |
| 26 | Platform behavior | pending | CI now runs Claude, Codex and parity suites on Linux and macOS, plus a job asserting the Claude package is unchanged. No run has occurred on this branch: unproven until CI executes. |
| 27 | Documentation/release | pending | Both skills written. No plugin manifest, hook wiring, shims or install path exists, so the package is not installable. |

Unknown or unsupported native behavior is retained as an explicit diagnostic
and does not authorize a retry, second owner, API fallback, or reset-credit
consumption.

## Status of this branch

No row is complete. The package now has a config loader, isolated state store,
fact assembly, a pure policy function, checkpoints, a job lifecycle, subagent
budgets, presence fusion and diagnostics. What it does NOT have is any wiring
to the harness: there is no plugin manifest, no hook declarations, no
entrypoint shims, and no transport that talks to a running Codex server. So
nothing has run end-to-end.

Specifically, and this bounds every claim above:

- No message has been queued to a real thread. Delivery is exercised only
  through an injected transport, which proves the parsing and state machine,
  not that Codex accepts or executes anything.
- No hook has ever fired. Event handling is tested as a pure function.
- Neither platform has been exercised in CI. The workflow jobs were added on
  this branch and have not run.
- Rows 11 and 18 are blocked by capabilities the platform does not provide.
  They are not awaiting more effort.

No claim of Codex support, general or partial, is warranted from these tests.

## Verification

All suites run in child processes with disposable HOME/config/cache
directories. The directory each ran in matters and is stated, because the
Claude suite's path-safety tests deliberately reject roots under /tmp:

| Suite | Directory | Result |
|---|---|---|
| Claude | the original checkout (a safe root) | 342 pass, 0 fail; typecheck exit 0 |
| Claude | the /tmp worktree | five resolveProjectRoot tests fail BY DESIGN, because production refuses transient roots |
| Codex | `plugins/codex-pacekeeper` | 161 pass, 0 fail; typecheck exit 0 |
| Parity | `tests/parity` | 25 pass, 0 fail; typecheck exit 0 |

The Claude package is byte-identical to the base commit; `git diff
2751789..HEAD -- plugins/cc-pacekeeper/` is empty, and CI now enforces this.

The parity assertions were mutation-checked: reintroducing the fabricated-zero
percentage, the flat queue-response id, or the default-true owner liveness each
turns the suite red, so the green result is not vacuous.

### A note on the parity harness

`tests/parity/harness.ts` imports the shipped Claude runtime directly. That is
deliberate — the corpus exists to compare against what actually ships, not
against a restatement of it — but it has a real cost: the parity suite needs
the Claude package's dependencies installed, so it does not demonstrate that
the Codex package works standalone. The separate `codex` CI job covers that
case, installing and running `plugins/codex-pacekeeper` on its own with no
sibling checkout. Neither production package imports this harness.
