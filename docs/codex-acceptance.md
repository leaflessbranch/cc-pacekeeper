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
Queue acceptance is tracked independently from turn completion. The native
schema does not expose a tool-disable field on `TurnStartParams`, and hook
coverage has bypasses for specialized tools; strict no-tools enforcement and
pre-model suppression therefore remain evidence gates until a supported,
tested control is found. The package must report those limitations instead
of claiming them from a prompt instruction or a deny-all hook.

## Capability ledger

| # | Capability | Status | Evidence or remaining gate |
|---:|---|---|---|
| 1 | Subscription authentication | pending | Native account/plan normalization and unsupported-auth diagnostics. |
| 2 | Quota acquisition | pending | Duration-based bucket normalization with unknown-bucket retention. |
| 3 | Context meter | pending | Current-turn token usage plus native model window only. |
| 4 | Compact status injection | pending | Event-specific hook encoding and concise status tests. |
| 5 | Threshold state machine | pending | Deterministic parity scenarios and reset re-arm. |
| 6 | Debounce/idempotency | pending | Per-account/thread/agent state and continuation guard. |
| 7 | Time/AFK awareness | pending | Synthetic events remain separate from user activity. |
| 8 | Cross-session awareness | pending | Known-account owner heartbeats only. |
| 9 | Model/window arbitrage | deferred | Existing Claude behavior is preserved; no Codex arbitrage. |
| 10 | Checkpoint lanes | pending | Codex-owned subtree, exact IDs, safe roots. |
| 11 | Context auto-save | blocked pending native gate | A persisted save barrier before compaction has not been proved through Codex hooks. |
| 12 | Five-hour renewal | pending | Authoritative reset and exact-ID wake lifecycle. |
| 13 | Near-reset bridge | pending | Bounded wait decision; live wait evidence still required. |
| 14 | Resume consumption | pending | Durable claim/ack and archive verification. |
| 15 | Subagent budgets | pending | Spawn-relative shared-account estimate. |
| 16 | Subagent handoffs | pending | Parent absorption acknowledgement required. |
| 17 | Dispatch advisory | pending | Advisory-only native spawn mapping. |
| 18 | Cache keepalive | blocked pending native gates | One-hour TTL is accepted; exact pong/no-tools/pre-model execution remains unproved. |
| 19 | Cache observability | pending | Preserve native cached/uncached fields without fabricating values. |
| 20 | Presence detection | pending | Linux fusion plus non-Linux fallback. |
| 21 | Away routing | deferred | Existing Claude routing is preserved; no Codex channel onboarding. |
| 22 | Worktree helper | pending | Safe list/create/cleanup and live-owner refusal. |
| 23 | Security-scoped automation | pending | Full owned payload and job-ID validation. |
| 24 | Diagnostics | pending | Distinct owner/schema/auth/cache/trust failures. |
| 25 | Configuration | pending | Defaults, legacy inheritance, and `adapters.codex` overrides. |
| 26 | Platform behavior | pending | Linux and macOS CI evidence required. |
| 27 | Documentation/release | pending | Opt-in install/trust/disable/uninstall and synchronized versions. |

Unknown or unsupported native behavior is retained as an explicit diagnostic
and does not authorize a retry, second owner, API fallback, or reset-credit
consumption.
