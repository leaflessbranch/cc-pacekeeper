# Issue 19 paused completion checkpoint

## Controlling state

The user requested a break and checkpoint on 2026-10-02. The implementation
agent was interrupted, and no final worker report or independent final review
was completed. This is a local WIP checkpoint, not approval or completion.
No tests, repairs, live acceptance, publication, or push were performed after
the stop request. Resume only after explicit authorization.

The commit containing this document saves the interrupted edits. Find its
revision with `git log -1 --format=%H --
docs/handoffs/2026-10-02-issue-19-paused.md`. Commit hooks are disabled for this
checkpoint so saving cannot trigger further tests or generation.

## Branch and references

- Branch: `feat/issue-19-codex-parity`; retain the existing serial worktree.
- Starting revision: `45fb37edd8ad27fd38c4e11c4c3b7390f0fbf0bf`.
- Current main reference: `e043d1d12ea17b48a4c1912a534ec5ab431dc5e3`.
- The earlier rebase and push were completed before this implementation pass.
  The new checkpoint is local; it has not been pushed.
- Read `docs/superpowers/plans/2026-09-05-issue-19-codex-parity.md` in the
  retained checkout, [the acceptance ledger](../codex-acceptance.md), and
  [the previous handoff](2026-09-07-issue-19-paused.md).
- Local scratch notes remain under
  `.superpowers/sdd/2026-09-05-issue-19-codex-parity/`: `progress.md`,
  `continuation-brief.md`, `previous-review.md`, and `parent-review.md`.
  These notes and the plan are outside this checkpoint's tracked changes.
- Before any issue/PR action after resume, read repository instructions and
  issue 19 including its comment trail.

## Saved progress

One completion worker was requested at max reasoning, followed by independent
parent review. The saved edits address the prior R1-R8 findings and issues
found during that in-progress review. They remain subject to review of this
exact checkpoint.

- Native transport now uses the installed 0.160.0 WebSocket-over-Unix contract,
  validates the handshake, bounds messages, and bootstraps the native client.
- Account-matched `ordinaryUsageAllowed` and separate freshness clocks drive
  fail-closed eligibility; revocation, account conflicts, idle service refresh,
  and reset progression received repairs.
- Native transcript observation reads last-turn usage and cache fields,
  preserves original timestamps, validates canonical thread identity, and
  invalidates unavailable or obsolete observations.
- Event output and continuation handling, exact completion attempt identity,
  synthetic classification, cancellation, checkpoint verification, and a
  public reset scheduling entrypoint received changes.
- Claim/ack recovery, exact owner receipts, archive integrity, linked-worktree
  provenance, conservative both-harness occupancy, cache containment, and
  presence persistence received regression coverage and repairs.
- Codex packaging now has a separate native marketplace catalog, corrected
  manifest paths and hook root variable, and a hook file accepted by the
  installed native parser. Documentation and parity expectations were updated.
- The Claude runtime and catalog remained unchanged in the last in-progress
  comparison with the current main reference. No normal installed profile,
  authenticated model turn, or live session queue was used.

## Observed evidence and limits

Before dispatch, the parent observed 217 Codex, 41 parity, and 418 Claude tests
passing, with all three typechecks passing. Those results describe the starting
revision, not this checkpoint.

The worker's retained log tails report 258 Codex, 41 parity, and 418 Claude
tests passing with zero failures. The typecheck logs exist, but this checkpoint
operation did not rerun them or establish their final exit status. Additional
edits followed some of those runs. These counts do not certify this saved SHA.
Logs remain under `/tmp/issue19-final-logs/`.

During implementation, independent disposable checks observed:

- Current native Unix WebSocket bootstrap against an empty-profile server.
- Native marketplace install/read registering 18 hooks and two skills, plus
  disable/remove behavior, without authenticated model execution.
- Public CLI linked-worktree save/claim/ack/replay and cleanup dry-run behavior.
- Prior regression scenarios, permission revocation, owned-cache symlink
  containment, and transcript observation with null usage and long files.

The main evidence bundle is `/tmp/issue19-parent-contract-rshrsdgj/`.
Packaging evidence is in `/tmp/issue19-parent-final-package-e1o2hugz/` and
`/tmp/issue19-parent-final-package-0tv78kmv/`; CLI evidence is in
`/tmp/issue19-parent-cli-64a_abj8/`; latest transcript observation evidence is
in `/tmp/issue19-parent-observer-akoh7Q/`. Temporary artifacts may disappear.
The parent review notes are in progress, and the prepared independent final
suite runner was not executed. None of these checks is final acceptance of
this checkpoint. Only stop/save bookkeeping and staged-content sanitation
were performed after the pause.

## Pending after an authorized resume

1. Review the exact saved diff and whole branch against the plan and R1-R8.
   Reconcile the acceptance ledger with actual production callers and evidence;
   do not treat its implementation claims as an independent verdict.
2. Complete production integration review: reset scheduling from verified
   checkpoint lifecycle, native owner publication and cross-session discovery,
   actual spawn tool names and parent handoff, synthetic turn identity, and
   genuine activity input to the independent presence sampler.
3. Run the independent full suites and typechecks against the saved revision
   in disposable environments. Final worker evidence and report are missing.
   Verify Claude preservation against the current main reference.
4. Retain native blockers: strict no-tools, atomic pre-model suppression,
   model-generated pre-compaction save barrier, and proactive presence delivery.
   Fixture capabilities do not establish supported production controls.
5. Keep live authenticated quota/context, reset/bridge/wake, child handoff,
   trusted hook execution, away/back, macOS, and hosted CI acceptance separate.
   No live model turns or profile changes are authorized by this checkpoint.

Only capability 9 (model/window arbitrage) and 21 (away routing) are deferred.
Preserve existing-owner delivery, unknown-capacity fail-closed behavior, the
accepted one-hour cache assumption and 30-minute cadence, and the isolated
opt-in Codex package. Leave unrelated checkout drafts untouched. Publication,
push, merge, release, and live acceptance require their own authorization.
