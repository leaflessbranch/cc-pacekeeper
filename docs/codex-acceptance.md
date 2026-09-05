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
| 4 | Compact status injection | pending | Event-specific hook encoding and concise status tests. |
| 5 | Threshold state machine | partial | The shipped Claude ladder is executed by the parity corpus against the EFFECTIVE config, including inclusive boundaries and stale-reset handling. Remaining: the Codex-side state machine itself. |
| 6 | Debounce/idempotency | pending | Per-account/thread/agent state and continuation guard. |
| 7 | Time/AFK awareness | pending | Synthetic events remain separate from user activity. |
| 8 | Cross-session awareness | pending | Known-account owner heartbeats only. |
| 9 | Model/window arbitrage | deferred | Existing Claude behavior is preserved; no Codex arbitrage. |
| 10 | Checkpoint lanes | pending | Codex-owned subtree, exact IDs, safe roots. |
| 11 | Context auto-save | blocked | Confirmed unavailable, not merely unproved: `PreCompact` ignores plain stdout and can only prevent compaction via `continue: false`; it cannot cause a model-generated resumable save. Preventing compaction is not saving. |
| 12 | Five-hour renewal | pending | Authoritative reset and exact-ID wake lifecycle. |
| 13 | Near-reset bridge | pending | Bounded wait decision; live wait evidence still required. |
| 14 | Resume consumption | pending | Durable claim/ack and archive verification. |
| 15 | Subagent budgets | pending | Spawn-relative shared-account estimate. |
| 16 | Subagent handoffs | pending | Parent absorption acknowledgement required. |
| 17 | Dispatch advisory | pending | Advisory-only native spawn mapping. |
| 18 | Cache keepalive | blocked | Confirmed unavailable: no protocol field or method disables tools, and the hooks documentation states there is no blanket no-tools mode while hosted web search and post-exec `write_stdin` bypass `PreToolUse` entirely. No method withdraws a queued submission before model work. The 30-minute cadence and one-hour TTL assumption stand; delivery is not the blocker, enforcement is. |
| 19 | Cache observability | partial | `cachedInputTokens` and the optional `cacheWriteInputTokens` are read, with absent distinguished from zero. Remaining: surfacing them in diagnostics. |
| 20 | Presence detection | pending | Linux fusion plus non-Linux fallback. |
| 21 | Away routing | deferred | Existing Claude routing is preserved; no Codex channel onboarding. |
| 22 | Worktree helper | pending | Safe list/create/cleanup and live-owner refusal. |
| 23 | Security-scoped automation | pending | Full owned payload and job-ID validation. |
| 24 | Diagnostics | pending | Distinct owner/schema/auth/cache/trust failures. |
| 25 | Configuration | partial | The frozen contract is the EFFECTIVE config, not package defaults, and the parity corpus proves the two differ on every meter (five-hour 50/80/90 vs 70/85/95; context 0/70/85 vs 60/75/90; weekly 50/95/98 vs 50/70/85; require_pending false; max_idle_hours 72). Remaining: the Codex `adapters.codex` override path. |
| 26 | Platform behavior | pending | Linux and macOS CI evidence required. |
| 27 | Documentation/release | pending | Opt-in install/trust/disable/uninstall and synchronized versions. |

Unknown or unsupported native behavior is retained as an explicit diagnostic
and does not authorize a retry, second owner, API fallback, or reset-credit
consumption.

## Status of this branch

No row is complete. Eight rows are `partial`: the native reading and
classification layer they depend on is implemented and tested, but no Codex
hook, scheduler, checkpoint store or CLI exists yet, so nothing runs
end-to-end. Two rows are `blocked` by capabilities the platform does not
provide, evidenced above. The rest are `pending`.

The Codex package currently contains one module, `src/native.ts`, plus its
tests. No claim of Codex support — general or partial — is warranted from
these tests: they exercise parsing and classification against recorded wire
shapes, using an injected transport. No message has been queued to a real
thread, no hook has executed, and neither platform has been exercised in CI.

Verification actually run on this branch, in child processes with disposable
HOME/config/cache directories:

- `plugins/cc-pacekeeper`: 342 pass, 0 fail (unchanged from base; the package
  is byte-identical to the base commit).
- `plugins/codex-pacekeeper`: 35 pass, 0 fail; typecheck exit 0. The
  checkpointed state did not typecheck; that is fixed.
- `tests/parity`: 25 pass, 0 fail; typecheck exit 0.

The parity assertions were mutation-checked: reintroducing the fabricated-zero
percentage, the flat queue-response id, or the default-true owner liveness each
turns the suite red, so the green result is not vacuous.
