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
| `account/read` identifies the account mode without returning credentials | confirmed | `GetAccountResponse` carries `chatgpt`, `apiKey` and `amazonBedrock` account variants plus `requiresOpenaiAuth`; the adapter retains only mode, plan and boolean observations. |
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
- **Pre-model suppression of a queued synthetic message (row 18).** The
  pinned interface does expose `thread/queue/delete`, and the package can
  request deletion of an exact queued id. The interface does not prove that a
  deletion wins an execution race before model work begins, so this remains an
  explicit blocker rather than a claim of atomic suppression.
- **A save barrier before compaction (row 11).** `PreCompact` ignores plain
  stdout; JSON stdout only supports the common fields, so a hook can prevent
  compaction via `continue: false` but cannot cause a model-generated
  resumable save. Preventing compaction is not the same as having saved.

Sources: the generated 0.153.4 schema, the pinned release source
(`session_queue_commands.rs`), and <https://learn.chatgpt.com/docs/hooks>.

## Capability ledger

| # | Capability | Status | Evidence or remaining gate |
|---:|---|---|---|
| 1 | Subscription authentication | partial | `account/read` mode parsing and capacity classification are implemented and tested: ChatGPT subscriptions can be observed, API-key/Bedrock/unknown modes stay outside included automation, and available credits never imply paid spending. Remaining: a real owner API-key negative case and a live paid-credit transition. |
| 2 | Quota acquisition | partial | Duration-based mapping tested in both native orderings; unknown buckets retained; the multi-bucket `rateLimitsByLimitId` map parsed; a malformed percentage stays null instead of reading as 0. Remaining: only the `codex` bucket id has ever been observed, so no model-family mapping is claimed. |
| 3 | Context meter | partial | Reads `last`, not lifetime `total`; a missing `modelContextWindow` yields an unknown percentage rather than inheriting Claude's 200k. Remaining: live comparison against a running thread. |
| 4 | Compact status injection | partial | `tick.ts` maps each supported event to the pure policy and encodes `hookSpecificOutput.additionalContext`; silent lifecycle events stay silent. Native hook execution still needs live acceptance. |
| 5 | Threshold state machine | partial | Codex policy and parity tests cover inclusive ladders, escalation, debounce, reset identity and re-arm. Live native event comparison remains. |
| 6 | Debounce/idempotency | partial | Policy state is keyed by hashed account/thread/agent; ordinary re-emission, escalation, continuation and synthetic suppression run through the hook adapter. Live duplicate event streams remain. |
| 7 | Time/AFK awareness | partial | User/tool/synthetic timestamps are separate; synthetic turns do not write state. Independent presence sampling is wired, with live away/back observation pending. |
| 8 | Cross-session awareness | partial | `findLiveOwner` requires a readable owner registry, live PID, exact account/thread and a usable endpoint; unknown records fail closed. A native owner registry producer remains an integration gate. |
| 9 | Model/window arbitrage | deferred | Existing Claude behavior is preserved; no Codex arbitrage. |
| 10 | Checkpoint lanes | partial | Owned subtree, exact-id CLI selection, verified persistence, ambiguous bare selection, and same-named Claude-lane isolation are implemented. Real project-root CLI acceptance remains. |
| 11 | Context auto-save | blocked | Confirmed unavailable, not merely unproved: `PreCompact` ignores plain stdout and can only prevent compaction via `continue: false`; it cannot cause a model-generated resumable save. Preventing compaction is not saving. |
| 12 | Five-hour renewal | partial | Reset-wake is a separate job identity carrying a reset generation, and a rolled-over window blocks automation until re-read. Remaining: live reset trace. |
| 13 | Near-reset bridge | pending | The service has a bounded reset-wake identity; a live reset/bridge trace remains required. |
| 14 | Resume consumption | partial | Exact-ID claim/ack preserves active content until acknowledgement, archives once, and reconciles by stable submission id. End-to-end live consumption remains. |
| 15 | Subagent budgets | partial | Spawn-relative estimate is explicitly shared-account, rollover rebases without negatives, and unreadable meters never pause on a guess. Native lifecycle wiring remains. |
| 16 | Subagent handoffs | partial | Absolute CLI contract, atomic owned handoff writes, list and archive verbs are wired; a live parent absorption trace remains. |
| 17 | Dispatch advisory | partial | `dispatchAdvice` never denies and the service validates complete owned job payloads. Native spawn-tool mapping remains. |
| 18 | Cache keepalive | blocked | Exact 30-minute job identity, existing-owner delivery, queue reconciliation and queue deletion are implemented. Strict no-tools and execution-time suppression are unavailable/unproved in the pinned protocol; the one-hour TTL is an accepted assumption. |
| 19 | Cache observability | partial | Last-turn context and observed cache read/write fields are normalized and persisted without fabricating absent values; live diagnostics remain. |
| 20 | Presence detection | partial | Linux tmux/tty/SSH/logind probes, attachment/activity fusion, non-Linux unknown fallback and an independent sampler are implemented. A live away/back observation remains. |
| 21 | Away routing | deferred | Existing Claude routing is preserved; no Codex channel onboarding. |
| 22 | Worktree helper | partial | List/create and conservative cleanup refuse dirty, locked, live-owned or unknown-liveness worktrees. Git fixture acceptance remains. |
| 23 | Security-scoped automation | partial | Job identity covers kind, account, thread and reset generation; queue payloads, IDs, checkpoint lanes and state roots are confined. Live owner authorization remains. |
| 24 | Diagnostics | partial | Doctor distinguishes owner, queue, auth, quota, executable, trust, permissions, crash, cache and config observations; blocked/deferred rows remain explicit. Live hook-trust evidence remains. |
| 25 | Configuration | partial | Codex reads legacy values and `adapters.codex` overrides field-by-field, preserving valid siblings and never writing the Claude file. A live install override check remains. |
| 26 | Platform behavior | pending | CI runs Claude, Codex and parity suites on Linux and macOS and asserts the Claude package is unchanged. This branch has not received hosted CI results. |
| 27 | Documentation/release | partial | Opt-in manifest, hook wire, executable shims and both Codex skills exist; release publication and live install/trust evidence remain outside this authorization. |

Unknown or unsupported native behavior is retained as an explicit diagnostic
and does not authorize a retry, second owner, API fallback, or reset-credit
consumption.

## Status of this branch

No row is complete. The package now has an opt-in manifest and hook wire,
executable shims, bounded native transport, owner discovery, fact assembly,
an event adapter, isolated state, checkpoints, durable jobs, subagent
handoffs, presence sampling, worktree helpers and diagnostics. End-to-end
native execution and platform/live gates still need independent acceptance.

Specifically, and this bounds every claim above:

- No message has been queued to a real thread. Delivery is exercised through
  injected transports and a bounded transport fixture, which proves parsing
  and state transitions but not that a real Codex owner accepts or executes it.
- Hook input/output is exercised through the package shim with disposable
  state, but no live Codex installation has trusted and fired this manifest.
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
| Codex | `plugins/codex-pacekeeper` | 203 pass, 0 fail; typecheck exit 0 |
| Parity | `tests/parity` | 40 pass, 0 fail; typecheck exit 0 |

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
