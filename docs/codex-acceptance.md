# Codex acceptance ledger

This ledger records the Codex parity implementation, the native evidence that
is available, and the gates that still need live or hosted verification. The
Codex package is opt in and keeps its state, configuration reads, checkpoints,
and jobs separate from the Claude package.

## Current pass

The user resumed the saved checkpoint on 2026-10-02. The local completion
pass repaired the confirmed review findings and reran independent validation.
See [the review record](codex-review-2026-10-02.md) for evidence and the
remaining production/native/live gates. This branch is experimental; complete
Codex parity and release readiness are not established.

The implementation targets the installed Codex CLI 0.160.0 contract. The
branch began at `45fb37edd8ad27fd38c4e11c4c3b7390f0fbf0bf`; the Claude package
is compared with main at `e043d1d12ea17b48a4c1912a534ec5ab431dc5e3`.

The generated 0.160.0 schema and current native sources were checked before
the adapter was changed. The native Unix control socket is a WebSocket over a
Unix stream. A disposable, empty-profile server accepted the WebSocket
handshake and completed `initialize`/`initialized`, `thread/loaded/list`, and
`account/read`; no account-authenticated turn or model execution was used.
The production transport validates `Sec-WebSocket-Accept`, bounds frames and
messages, preserves ping payload bytes, and only uses the raw newline socket
adapter in injected protocol fixtures.

The current schema's `GetAccountRateLimitsResponse.ordinaryUsageAllowed` is
the authoritative included-usage permission. It is accepted only when the
active account identity and freshness are established. `false` and `null`
close automation and do not get inferred from percentages, reset times,
credits, or upsell fields. Quota windows remain duration-mapped and unknown
buckets are retained.

## Native contract and explicit blockers

| Contract | Result | Evidence |
|---|---|---|
| Queue add accepts `threadId`, `input`, and `clientUserMessageId` | confirmed | Generated 0.160.0 request schema and `NativeClient.queueExistingThread`. |
| Queue add returns a nested `queuedSubmission` | confirmed | Generated response schema and parser; a flat id is rejected. |
| `account/read` establishes account mode and authentication state without retaining credentials | confirmed | Parsed account adapter keeps mode, plan, and booleans only. |
| `ordinaryUsageAllowed` establishes included capacity | confirmed | Current schema description calls it backend permission for the active account; tests cover true, false, null, and revocation. |
| Five-hour and weekly windows are identified by duration | confirmed | Both native positions are parsed by `windowDurationMins`; malformed values remain unknown. |
| Current-turn context and cache fields are observable | partial | The installed 0.160.0 rollout source persists `TokenCount`; the bounded `transcript_path` observer reads `last_token_usage`, nullable `model_context_window`, and cache fields, preserves the native record timestamp, validates the first `SessionMeta` thread id, and invalidates at compaction/turn boundaries. A live hook/turn comparison remains. |
| Native Unix control transport is newline JSON | refuted | Current Unix socket upgrades to WebSocket; the production adapter implements the upgrade and frames. |
| Blanket strict no-tools control exists | refuted | `TurnStartParams` has no tool-disable field and no native method provides the required boundary. |
| Atomic pre-model suppression exists for queued synthetic input | refuted | `thread/queue/delete` is available, but the protocol does not prove deletion wins the execution race. |
| A hook can create a model-generated save barrier before compaction | refuted | Hook output can block compaction, but does not create a resumable model turn. |
| Native spawn mapping is available to the hook adapter | partial | The native ThreadItem union exposes spawn-related variants and the hook schema exposes `tool_name`/`tool_input`; guarded local mappings cover known values, but a live hook payload trace is still required before treating the mapping as universal. |

Rows 11 and 18 therefore retain explicit platform blockers. Hosted tools and
existing exec sessions also do not share a blanket local tool hook boundary.
The service never treats a prompt instruction, fixture boolean, queue delete,
or capacity percentage as a substitute for those semantics.

## Capability ledger

| # | Capability | Status | Evidence and remaining gate |
|---:|---|---|---|
| 1 | Subscription authentication | partial | Account mode parsing, active-account matching, auth freshness, and API-key/Bedrock fail-closed paths are implemented. Live authenticated and logout traces remain. |
| 2 | Quota acquisition | partial | Duration mapping, multi-bucket parsing, unknown bucket retention, invalid percentage handling, and authoritative permission transitions are tested. A live comparison of all account buckets remains. |
| 3 | Context meter | partial | The bounded `transcript_path` observer consumes persisted native `TokenCount` records, uses `last_token_usage` and nullable model-window/cache fields, preserves original timestamps, validates the canonical first `SessionMeta`, and invalidates usage across compaction/turn boundaries. Claude's fallback window is not used; a running-thread comparison remains. |
| 4 | Compact status injection | partial | Event-specific `systemMessage`, `hookSpecificOutput`, and Stop/SubagentStop `decision:block` output are tested. Native hook trust and firing remain live gates. |
| 5 | Threshold state machine | partial | Inclusive ladders, escalation, debounce, rollover reset, and context re-arm are covered by Codex and parity tests. A live native event trace remains. |
| 6 | Debounce and idempotency | partial | Hashed account/thread/agent state, continuation suppression, synthetic suppression, duplicate lifecycle handling, and stable job IDs are implemented. Native hooks expose turn ids, but no pre-completion production producer binds them to owned submissions; synthetic dispatch remains closed. Duplicate live event delivery remains. |
| 7 | Time and AFK awareness | partial | User, tool, synthetic, session, and pending-work clocks are separate; independent presence sampling persists transitions. Live away/back behavior remains. |
| 8 | Cross-session awareness | partial | Owner registry parsing is strict, malformed rows are unknown, native control-socket discovery verifies loaded threads, and account mismatches withhold jobs. A native owner producer and live multi-session trace remain. |
| 9 | Model/window arbitrage | deferred | Explicitly deferred; native model switching and bucket recommendations are not duplicated. |
| 10 | Checkpoint lanes | partial | Codex-owned roots, exact IDs, atomic writes, provenance, claim/ack/archive, ambiguous selection, and Claude-lane isolation are tested. Real project-root CLI acceptance remains. |
| 11 | Context auto-save | blocked | The examined hook/native boundary cannot produce a model-generated save barrier before compaction. The adapter reports that limitation and never claims a save from hook output. |
| 12 | Five-hour renewal | blocked | The public `schedule-reset` entrypoint verifies the saved checkpoint generation and records its project root. Execution consumes native owner-timeline quota and a fresh next-window identity. Native pre-model cancellation is unsupported; automatic save-to-wake integration and a live reset trace remain. |
| 13 | Near-reset bridge | blocked | The public scheduler bounds the wait and preserves owner/thread. Production delivery remains blocked by missing native pre-model cancellation; automatic lifecycle integration and a live bridge trace remain. |
| 14 | Resume consumption | partial | Exact-ID claim, owner-bound acknowledgement, archive corruption checks, replay idempotency, crash recovery, and native turn correlation are implemented. A live CLI consumption trace remains. |
| 15 | Subagent budgets | partial | Shared-account spawn-relative estimates, fresh reset-identity anchor rebasing, and unknown-meter fail-closed behavior are tested. Native lifecycle acceptance remains. |
| 16 | Subagent handoffs | partial | Absolute CLI contracts, atomic Codex-subtree writes, list/archive verbs, and a root-consistent child stop notice independent of meter debounce are implemented. Account/parent ownership, a durable parent receipt producer, and native parent absorption remain unproved. |
| 17 | Dispatch advisory | partial | Known hook `tool_name` values are mapped conservatively and advice never denies ordinary spawning; unknown values fail closed. A live specialized spawn trace remains. |
| 18 | Cache keepalive | blocked | Durable 30-minute identities, existing-owner delivery, fresh quota/auth refresh, pending-work production, queue reconciliation, cancellation intent, and strict completion parsing are implemented. Production dispatch remains blocked because strict no-tools and atomic pre-model suppression are unavailable. |
| 19 | Cache observability | partial | Context, cache read/write, multi-bucket quota, ordinary permission, auth, activity, and freshness clocks are persisted without fabricating absent values. Live diagnostics remain. |
| 20 | Presence detection | blocked | Linux probes, an independent sampler, canonical cache containment, transition persistence, and unavailable-probe fail-closed behavior are implemented. Native proactive notification and live away/back traces remain unavailable, so the full capability stays blocked. |
| 21 | Away routing | deferred | Explicitly deferred; existing Claude routing is preserved and no Codex channel is added. |
| 22 | Worktree helper | partial | List/create/cleanup refuse dirty, locked, live-owned, malformed, or unknown-liveness rows; child-directory owners map to their worktree and the main checkout is protected. Hosted Git acceptance remains. |
| 23 | Security-scoped automation | partial | Jobs, queues, checkpoints, state roots, archive receipts, account/thread ownership, and reset generations are validated. Live owner authorization remains. |
| 24 | Diagnostics | partial | Doctor and service diagnostics distinguish auth, quota, owner, queue/schema, stale facts, trust, executable, permissions, crash, cache, presence delivery, and unsupported native controls. Live hook-trust evidence remains. |
| 25 | Configuration | partial | Legacy config is read as input, Codex overrides are field-preserving, Claude config is never written, and invalid fields diagnose independently. A live install override check remains. |
| 26 | Platform behavior | pending | Linux and macOS jobs cover Claude, Codex, parity, and the branch-scoped Claude-preservation check. Hosted CI evidence remains. |
| 27 | Documentation and release | partial | Opt-in manifest, native hook file, executable shims, skills, and a Codex-only `.agents/plugins/marketplace.json` route are shipped. A disposable shipped-route marketplace/add/read/disable/remove smoke passed; trusted live publication remains outside this local pass. |

Unknown or unsupported native behavior remains a diagnostic and closes the
operation. The package does not use an API fallback, start a second server for
a live thread, spend paid or unknown credits, infer capacity from reset times,
or send external messages.

## Verification

Every local command below uses child-process HOME, Claude config, Codex home,
XDG config, and XDG cache overrides. No real profile, credential, raw
transcript, live model turn, or normal-session queue was used.

Fresh independent validation ran after the local repairs in isolated process
environments. The review record identifies the tested code and retained logs:

| Suite | Command | Evidence |
|---|---|---|
| Codex | `bun test` in `plugins/codex-pacekeeper` | 266 passed, 0 failed; current independent evidence in the review record |
| Codex typecheck | `bun run typecheck` in `plugins/codex-pacekeeper` | Exit 0; current independent evidence in the review record |
| Claude | `bun test` in `plugins/cc-pacekeeper` | 418 passed, 0 failed; current independent evidence in the review record |
| Claude typecheck | `bun run typecheck` in `plugins/cc-pacekeeper` | Exit 0; current independent evidence in the review record |
| Parity | `bun test` in `tests/parity` | 41 passed, 0 failed; current independent evidence in the review record |
| Parity typecheck | `bun run typecheck` in `tests/parity` | Exit 0; current independent evidence in the review record |

The actual native disposable smoke also covered WebSocket handshake and
bootstrap methods, and the disposable package smoke covered marketplace add,
plugin add, plugin metadata, hook declarations, disable configuration, and
plugin removal. Those smoke tests did not authenticate or execute a model turn.

The Claude package is checked byte-for-byte against the current main reference;
the workflow's `claude-unchanged` job is scoped to this parity branch so the
preservation check cannot freeze unrelated future Claude work.
