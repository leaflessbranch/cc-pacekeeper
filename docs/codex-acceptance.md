# Codex acceptance ledger

This document records the implementation evidence for issue #19. It keeps
native facts, deterministic policy behavior, and unverified live outcomes
separate. The Codex package is opt-in and has its own state subtree; the
shipped Claude package remains at version 0.8.2 and is not rewritten here.

## Current implementation pass

This branch received the authorized F1-F11 repair pass on 2026-09-07.
Disposable local tests and typechecks ran after the repairs. Independent
review, live native actions, trusted profile changes and external acceptance
remain separate gates.

## Baseline

- Base: `2751789890e13f0c5ca0d33bb7097a7e45666d48`.
- Historical Claude verification report: `bun test --cwd plugins/cc-pacekeeper`
  in a child process with disposable HOME/config/cache: 342 passed, 0 failed.
- Historical Claude typecheck report: `bun run --cwd plugins/cc-pacekeeper typecheck`:
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

The repair transport now sends `initialize` with `experimentalApi: true`,
validates the native initialize shape, waits for the `initialized` notification,
and only then sends the business request. Its protocol fixture enforces that
ordering; the fixture uses no real owner or socket.

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
| 1 | Subscription authentication | partial | `account/read` mode parsing is implemented: API-key/Bedrock/unknown modes stay outside included automation, and available credits never imply paid spending. The pinned rate-limit schema does not establish included spending capacity: `spendControlReached: false` remains unknown until an authoritative included-capacity fact exists. Remaining: a real owner API-key negative case and a live paid-credit transition. |
| 2 | Quota acquisition | partial | Duration-based mapping tested in both native orderings; unknown buckets retained; the multi-bucket `rateLimitsByLimitId` map parsed; a malformed percentage stays null instead of reading as 0. Remaining: only the `codex` bucket id has ever been observed, so no model-family mapping is claimed. |
| 3 | Context meter | partial | Reads `last`, not lifetime `total`; a missing `modelContextWindow` yields an unknown percentage rather than inheriting Claude's 200k. Remaining: live comparison against a running thread. |
| 4 | Compact status injection | partial | `tick.ts` maps each supported event to the pure policy and uses event-specific output: `decision:block`/`reason` for Stop/SubagentStop, `continue:false`/`stopReason` for PreCompact, and `hookSpecificOutput.additionalContext` only where supported. Refresh records native observations through a selected existing owner when one is available. Native hook execution still needs live acceptance. |
| 5 | Threshold state machine | partial | Codex policy and parity tests cover inclusive ladders, escalation, debounce, reset identity and re-arm. Live native event comparison remains. |
| 6 | Debounce/idempotency | partial | Policy state is keyed by hashed account/thread/agent; ordinary re-emission, escalation, continuation and synthetic suppression run through the hook adapter. Live duplicate event streams remain. |
| 7 | Time/AFK awareness | partial | User/tool/synthetic timestamps are separate; synthetic turns do not write state. Independent presence sampling is wired, with live away/back observation pending. |
| 8 | Cross-session awareness | partial | `findLiveOwner` requires a readable owner registry, live PID, exact account/thread and a usable endpoint; unknown records fail closed. Service eligibility and refresh now consume those observed facts. A native owner registry producer remains an integration gate. |
| 9 | Model/window arbitrage | deferred | Existing Claude behavior is preserved; no Codex arbitrage. |
| 10 | Checkpoint lanes | partial | Owned subtree, exact-id CLI selection, verified persistence, ambiguous bare selection, and same-named Claude-lane isolation are implemented. Real project-root CLI acceptance remains. |
| 11 | Context auto-save | blocked | Confirmed unavailable, not merely unproved: `PreCompact` ignores plain stdout and can only prevent compaction via `continue: false`; it cannot cause a model-generated resumable save. Preventing compaction is not saving. |
| 12 | Five-hour renewal | partial | Reset-wake is a separate job identity carrying a reset generation, and a rolled-over window blocks automation until re-read. Remaining: live reset trace. |
| 13 | Near-reset bridge | pending | The service has a bounded reset-wake identity; a live reset/bridge trace remains required. |
| 14 | Resume consumption | partial | Exact-ID claim/read/ack preserves active content until acknowledgement, archives once, distinguishes consumed/superseded/discarded states, and protects owners. End-to-end live consumption remains. |
| 15 | Subagent budgets | partial | Spawn-relative estimate is explicitly shared-account, rollover rebases without negatives, and unreadable meters never pause on a guess. Native lifecycle wiring remains. |
| 16 | Subagent handoffs | partial | Absolute CLI contract, atomic owned handoff writes, list and archive verbs are wired; a live parent absorption trace remains. |
| 17 | Dispatch advisory | partial | `dispatchAdvice` never denies and the service validates complete owned job payloads. Native spawn-tool mapping remains. |
| 18 | Cache keepalive | blocked | Exact 30-minute job identity, existing-owner delivery, queue reconciliation and queue deletion are implemented. Unresolved submissions are never replayed, and `require_pending=false` skips only that gate. Strict no-tools and execution-time suppression are unavailable/unproved in the pinned protocol; the one-hour TTL is an accepted assumption. |
| 19 | Cache observability | partial | Last-turn context, observed cache read/write fields, full sanitized multi-bucket quota metadata and separate quota/context/auth/activity clocks are persisted without fabricating absent values; live diagnostics remain. |
| 20 | Presence detection | partial | Linux tmux/tty/SSH/logind probes, attachment/activity fusion, non-Linux unknown fallback, an independent sampler, persisted transition records and unreadable-SSH fail-closed behavior are implemented. A native proactive notification path and live away/back observation remain unavailable/unverified. |
| 21 | Away routing | deferred | Existing Claude routing is preserved; no Codex channel onboarding. |
| 22 | Worktree helper | partial | List/create and conservative cleanup refuse dirty, locked, live-owned or unknown-liveness worktrees and always protect the actual invoking checkout even when root resolution follows a linked worktree. Git fixture acceptance remains. |
| 23 | Security-scoped automation | partial | Job identity covers kind, account, thread and reset generation; queue payloads, IDs, checkpoint lanes and state roots are confined. Live owner authorization remains. |
| 24 | Diagnostics | partial | Doctor distinguishes owner, observed queue/schema, auth freshness, quota, executable, trust, permissions, crash, cache, presence-delivery and config observations; environment configuration booleans are not treated as receipts. Blocked/deferred rows remain explicit. Live hook-trust and native fact evidence remain. |
| 25 | Configuration | partial | Codex reads legacy values and `adapters.codex` overrides field-by-field, preserving valid siblings and never writing the Claude file. A live install override check remains. |
| 26 | Platform behavior | pending | CI runs Claude, Codex and parity suites on Linux and macOS and asserts the Claude package is unchanged. Local Linux checks are green after F1-F11; hosted macOS/CI evidence is still pending. |
| 27 | Documentation/release | partial | Opt-in manifest, hook wire, executable shims and both Codex skills exist; release publication and live install/trust evidence remain outside this authorization. |

Unknown or unsupported native behavior is retained as an explicit diagnostic
and does not authorize a retry, second owner, API fallback, automated spending,
or reset-credit consumption. In particular, the pinned `spendControlReached:
false` observation is not treated as proof of included capacity.

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
| Codex | `plugins/codex-pacekeeper` | 217 pass, 0 fail; typecheck exit 0 after F1-F11 repairs |
| Parity | `tests/parity` | 41 pass, 0 fail; typecheck exit 0 after F1-F11 repairs |

The Claude package is byte-identical to the base commit; `git diff
2751789..HEAD -- plugins/cc-pacekeeper/` is empty, and CI now enforces this.

The parity assertions were mutation-checked: reintroducing the fabricated-zero
percentage, the flat queue-response id, or the default-true owner liveness each
turns the suite red, so the green result is not vacuous.

The current local suite results above are disposable behavioral/type checks,
not independent review or live/native acceptance. Parent review and live
acceptance remain pending.

### A note on the parity harness

`tests/parity/harness.ts` imports the shipped Claude runtime directly. That is
deliberate — the corpus exists to compare against what actually ships, not
against a restatement of it — but it has a real cost: the parity suite needs
the Claude package's dependencies installed, so it does not demonstrate that
the Codex package works standalone. The separate `codex` CI job covers that
case, installing and running `plugins/codex-pacekeeper` on its own with no
sibling checkout. Neither production package imports this harness.
