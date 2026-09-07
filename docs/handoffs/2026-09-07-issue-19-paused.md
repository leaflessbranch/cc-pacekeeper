# Issue 19 paused repair handoff

## Controlling state

The implementation worker was interrupted at the user's request. This is a
local WIP checkpoint, not implementation approval. Resume work only after an
explicit instruction in the new session. Independent review, further repairs,
verification, publication and live acceptance are paused.

The user requested that current work be committed locally with a handoff. The
commit containing this document is that checkpoint; obtain its exact revision
with `git log -1 --format=%H -- docs/handoffs/2026-09-07-issue-19-paused.md`.
No push, PR publication, merge, release or installed-profile change accompanies
this checkpoint. Commit hooks are bypassed for the stop/save operation so they
cannot trigger additional testing or code generation.

## Branch and reference material

- Branch: `feat/issue-19-codex-parity`, targeting `main`.
- Original base: `2751789890e13f0c5ca0d33bb7097a7e45666d48`.
- Previous WIP checkpoint: `401713fbafc363b0a2d9ad3df30f44fcdb8bdedf`.
- Locate the existing execution checkout with `git worktree list`; retain this
  single feature branch rather than creating a parallel implementation branch.
- Read [the plan](../superpowers/plans/2026-09-05-issue-19-codex-parity.md),
  [the acceptance ledger](../codex-acceptance.md), repository `CLAUDE.md`, and
  issue 19 including its comments before resuming.
- Local evidence outside Git is retained in the temporary review directory
  `issue19-review-current-5pgx_uyt`: `report.md`, `repro.ts`, and package logs.
  Local session notes are named `cc-pacekeeper-issue-19-handoff.md` and
  `cc-pacekeeper-issue-19-implementation-report.md` in the temporary directory.
  These artifacts may disappear; the essential findings are recorded below.

## What led to this checkpoint

A parent review of the previous checkpoint plus an implementation-only pass
found eleven issues despite green tests. The worker, using gpt-5.6-luna with
max reasoning, was authorized to apply fixes and run disposable verification.
The user then requested an immediate pause and local checkpoint. The worker
was interrupted; no final completion report was received or requested after
that interruption.

The saved edits span native transport, fact refresh, scheduling, checkpoints,
hook output, diagnostics, presence, worktree safety, regression tests, parity
tests and documentation. The worker's local notes say the following triggers
were addressed. Those claims remain subject to independent review of this
exact checkpoint.

| Finding | Required behavior to verify after authorized resume |
|---|---|
| F1 | Every native transport connection performs initialize/initialized and negotiates required experimental capabilities before requests. An echo server is insufficient proof. |
| F2 | Production entrypoints acquire evidenced owner/account/context facts and connect scheduling, completion, checkpoint consumption, dispatch advice and presence lifecycle. Test-supplied callbacks or an unpublished registry are not a working adapter. |
| F3 | Hook output follows each native event's supported fields. A save request is never recorded as an acknowledged save. |
| F4 | Empty/failed refreshes preserve original fact ages. Quota, context, authentication and activity clocks are separate; sanitized multi-bucket metadata survives caching. |
| F5 | An ambiguous submission retains its client identity and cannot be overwritten by rescheduling with a fresh ID. |
| F6 | A crash leaving submitting state can reconcile by stable client ID without blind retry. |
| F7 | The public consumer uses claim/read/ack. Checkpoints stay recoverable until actual receipt is acknowledged; stdout delivery is not assumed. |
| F8 | Superseded, discarded and consumed are distinct outcomes. Active claims and owner boundaries survive a same-lane save. |
| F9 | Cleanup always protects the actual invoking worktree, independently of the shared repository/checkpoint root. |
| F10 | `keepalive.require_pending=false` disables only the pending-work requirement; other safety gates remain enforced. |
| F11 | Unreadable remote-terminal activity returns unavailable, not idle/AFK. |

Additional review concerns: doctor must distinguish configured hints from
observed authentication/trust, cache containment must handle legitimate system
ancestor aliases without permitting escape from owned directories, and native
transport tests must not treat a socket-permission error as successful coverage.

## Evidence and its limits

Before the repair pass, the parent independently ran 205 Codex, 41 parity and
342 Claude tests, with zero failures and all three typechecks passing. The
parent also reproduced the recovery/cache/override failures listed above. That
evidence predates these repairs.

The interrupted worker's notes report:

- Codex: 217 tests passed, zero failures; typecheck exit 0.
- Parity: 41 tests passed, zero failures; typecheck exit 0.
- Claude: 342 tests passed, zero failures; typecheck exit 0.
- A targeted repair set reported 102 passing tests before the full suites.
- Checks used disposable child-process home/config/cache directories; Claude
  ran from the original safe checkout because its root tests reject temporary
  worktrees.
- The transport fixture uses an in-memory socket seam after the runner denied
  a real fixture socket. This establishes fixture behavior, not live transport.

The parent has not rerun those checks or reviewed the final repair diff. Do
not present the worker's counts as independently verified results for the
commit containing this handoff. The parent ran no technical tests or repairs
after the stop request; only checkpoint bookkeeping and the required staged
content/message safety scan were authorized for that operation.
That scan replaced a dummy home-directory path and private-network address in
two test fixtures with impersonal fixture values. These sanitation-only edits
were not retested after the stop request.

## Remaining gates

The worker notes still list missing native owner-registry production evidence,
native context-usage sourcing, spawn mapping, trusted hook loading, live
subscription/paid-transition/reset/bridge/wake, child handoff, Linux away/back,
macOS and hosted CI acceptance. In particular, F2 must be reconciled against
actual production call paths rather than closed from a summary claiming it
was addressed.

Strict no-tools, race-free pre-model suppression and a pre-compaction save
barrier remain unproved or unsupported in the examined native interface.
Preserve these precise blockers. Included subscription capacity remains
unknown/fail-closed where no authoritative positive observation exists;
`spendControlReached=false` is not sufficient authorization to spend.

## Resume procedure and boundaries

1. Obtain explicit authorization for the next activity: review, verification,
   or further implementation. The pause is not standing execution authority.
2. Locate the existing worktree and verify its branch and current changes.
   Read this handoff and the referenced plan/ledger; do not discard newer work.
3. If review is authorized, assess the exact saved diff against F1-F11 and the
   full 25-capability scope. Separate repaired local defects, missing production
   implementation and native/platform acceptance blockers.
4. If verification is authorized, use disposable process environments and
   meaningful regressions. Preserve the original Claude checkout and its
   drafts. Live model turns, profile changes and publication require explicit
   authority beyond ordinary local tests.
5. If repairs are authorized, keep one serial Luna worker on this branch and
   have the parent independently assess the result. No additional feature
   branch or implementation worker is required.

Preserve shipped Claude runtime/config/state/version. The Codex package is
isolated and opt-in. Only capability 9 (model/window arbitrage) and capability
21 (away routing) are deferred; presence remains in scope. Use existing-owner
delivery only, with no second server taking a live thread, API fallback,
purchases or unknown-capacity spending. Retain the accepted one-hour cache
assumption and 30-minute cadence; no TTL experiment is required. Keep normal
installed profiles and unrelated checkout drafts untouched.
