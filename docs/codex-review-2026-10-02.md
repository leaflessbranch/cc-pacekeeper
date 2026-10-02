# Codex parity review and local completion record

The local completion pass resumed checkpoint
`e96426bf273db327c7b0be2de527f35c4e75c930`, repaired the first review findings,
and reviewed integration commit `3258fd6a9af420e862e66080b3b77fb48b78aeb8`.
The fresh parent review found and repaired two additional reset defects.
Independent Linux suites and typechecks pass after those amendments. Full
parity acceptance remains blocked by native capabilities, live integration,
and hosted platform gates. This record is not release or merge approval.

The reviewed code is in the commit containing this document. Obtain its exact
revision with `git log -1 --format=%H -- docs/codex-review-2026-10-02.md`.
Claude is preserved against main reference
`e043d1d12ea17b48a4c1912a534ec5ab431dc5e3`.

## Fresh findings and amendments

The final review examined the new production callers and tests using
architecture and operations perspectives. It reproduced both defects below
before repairing them; the regressions now pass. A separate check verifies
that a checkpoint cannot be retargeted after native submission begins.

| Finding | Trigger and amendment | Verification |
|---|---|---|
| Discovery clock | The save command captured its clock before asynchronous discovery; a valid newly observed owner was consequently rejected as a future observation. Freshness is now evaluated after discovery and rate-limit reads. | Delayed native discovery fails before the amendment and registers the exact reset afterward. Existing stale-owner and account mismatch checks remain green. |
| Replacement checkpoint | A second save in the same reset window superseded the first file, but the existing wake still referenced that first checkpoint. A still-scheduled wake now follows the exact replacement and project without changing its submission identity. Retargeting is refused once submission starts, and contradictory reset identity is refused. | Two saves retain one wake pointing to the new active checkpoint. A submitting wake retains its original metadata and the new manual save reports why registration was withheld. |

The reviewed integration adds automatic registration after a verified save,
paginated loaded-thread discovery without a fabricated process PID, native
child-parent mapping, account/parent-scoped handoff commands and V1 parent
wait-result context delivery, and exact in-flight client-message/turn binding.
The parent independently reran all three suites and typechecks against these
callers and then again after the reset amendments. No additional reproduced
defect remains open in this bounded review; native and live gates below remain.

## Earlier review amendments

A fresh read-only reviewer used architecture and operations perspectives and
reproduced four integration defects. The parent reproduced these and additional
reset/correlation defects, repaired them, and reviewed the amendments. Every
behavioral regression below failed before its repair and passed afterward.

| Finding | Trigger and amendment | Verification |
|---|---|---|
| Reset observation source | Native refresh updates the parent timeline, while the reset gate read job metadata. The gate now reads owner-scoped observations. | Native owner refresh supplies reset readiness without test-written job quota. |
| Reset project provenance | A service restarted from another directory cannot locate its scheduled checkpoint. Execution now verifies the recorded project root. | Restarted service verifies the original project's checkpoint. |
| Reset generation | An owned checkpoint with a different generation was accepted. The default verifier now requires the saved generation at schedule and execution. | A mismatched generation is refused before job creation. |
| Genuine marker input | A real marker-prefixed prompt silently skipped activity and cancellation. Synthetic classification now requires exact owned identity; genuine prompts cancel scheduled/queued owner work. | Unowned marker prompt records activity and cancellation intent. |
| Contradictory turn identity | One matching correlation field masked another conflicting field. All supplied identity fields must match. | A new turn with stale job/submission identifiers remains ordinary input. |
| Independent context | A fresh thread context or invalidation was hidden by an older account row. Context is selected independently by its own observation/invalidation clock, without refreshing quota/auth; agent lanes cannot supply parent facts. | Fresh context replaces the older reading, invalidation clears it, and quota age is preserved. Public refresh/tick shims also pass with no native owner. |
| Child rollover | The spawn percentage remained anchored to the ended quota window. A fresh changed reset identity rebases and persists the anchor. | Child starts at 80%, new window begins at 5%, later reaches 80% and pauses at the default 75% boundary. |
| Handoff lookup | A child stop used raw cwd and unrelated meter debounce. It now resolves the same project root as the writer and reports the pending handoff independently of meter warnings. | Subdirectory stop finds the handoff; continuation output stays silent. Parent delivery is still unproved. |

The checkpoint skill documents exact-id selection, automatic save registration
when native owner/reset facts are verified, and scoped handoff acknowledgement.
Registration does not claim authorized native execution.

## Previous R1-R8 disposition

| Previous finding | Current disposition |
|---|---|
| R1: production fact/owner/scheduling/completion/presence wiring | Automatic verified save registration, actual control-socket discovery, loaded-thread pagination, exact native parent mapping, in-flight correlation, and a scoped V1 parent wait-return producer now have production callers. Native queue timing, strict controls, V2 child identification, live shared-session behavior, proactive presence delivery, and hosted platform acceptance remain gates. |
| R2: continuation and compaction output | Local output and continuation regressions pass; no model-generated save barrier is claimed. |
| R3: repeated ack and archive crash recovery | Exact owner/token replay and prepared archive receipt are implemented; archive integrity regressions and public ack replay pass. |
| R4: cleanup safety | Actual invoking checkout, main checkout, both-harness occupancy and unknown registries are protected; public cleanup smoke was dry-run only. |
| R5: stale completion receipt | Mandatory stable submission identity prevents an older receipt completing its recurring successor. |
| R6: bootstrap identity masking | Provisional quota/auth rows cannot replace an authoritative account; ambiguous accounts remain unknown and agent lanes are excluded from parent lookup. Context is independently timestamped. |
| R7: linked-worktree provenance | Public save records the invoking branch/worktree while storing in the shared project Codex subtree; standalone CLI smoke passes. |
| R8: presence/cache aliases | Canonical ancestor aliases persist; owned-subtree symlink escape is refused and persistence failure remains visible. |

## Independent evidence

The final local run used separate disposable HOME, Codex home, Claude config,
XDG config and cache environments, with credential-related environment values
removed. It executed the current Codex and parity packages and unchanged Claude
package. No authenticated native calls, model turns, live queues, normal profile
changes or external messages were used.

| Check | Result |
|---|---|
| Codex `bun test` | 296 passed, 0 failed |
| Parity `bun test` | 41 passed, 0 failed |
| Claude `bun test` | 418 passed, 0 failed |
| All three `bun run typecheck` commands | Exit 0 |
| Claude package and catalog comparison with current main | Empty diff |
| Public scoped handoff CLI | Included in the current independent suite; write, wrong account refusal, acknowledgement and archive checks pass |
| Earlier standalone package and native registration | Passed at the preceding checkpoint; 18 hooks and two skills registered. These earlier checks do not establish live acceptance of the new callers. |
| Earlier public transcript refresh/tick, owner unavailable | Fresh critical context and later invalidation observed at the preceding checkpoint |
| Diff whitespace check | Passed |

Retained final evidence: `/tmp/issue19-parent-validation-bd7a1h7r/` holds
`results.json` and suite/typecheck logs. The independent pre-amendment run is
`/tmp/issue19-parent-validation-cx6mghsp/`; delayed discovery reproduction is
`/tmp/issue19-parent-review-clock-8inz2ma0/red.log`. Earlier package and native
registration evidence remains in the preceding local completion record.
Temporary artifacts may disappear; the table records their essential results.
The fresh review was bounded source/integration review and reproduced failures;
it does not establish exhaustive coverage or live/native product acceptance.

## Remaining gates

- The examined 0.160.0 native interface does not provide strict no-tools,
  atomic pre-model cancellation, or a model-generated pre-compaction save
  barrier. Production keepalive and reset dispatch stay closed. Queue deletion
  is a cancellation request, not proof that model execution was suppressed.
- Proactive native presence notification remains unproved. Linux sampling and
  persisted transitions do not satisfy proactive delivery or away/back acceptance.
- The production in-flight correlator polls exact thread/turn/client identity
  before tick policy. Missing or conflicting observations stay unbound. Polling
  does not prove real hook ordering or atomic pre-model suppression.
- Scoped handoffs have a V1 parent wait-return producer, persisted completion
  observation and explicit acknowledgement before archive. Live delivery and
  parent absorption remain unverified. V2 summaries without exact child ids
  cannot drive this producer. A child stop notice remains insufficient.
- Automatic verified-save-to-reset registration is implemented; a real
  reset/bridge/wake trace remains unrun and production dispatch stays closed.
- Authenticated quota/context/logout and weekly comparisons, trusted hook
  execution, child lifecycle/spawn traces, live away/back, macOS and hosted CI
  remain unrun. Existing tests and offline plugin discovery do not replace them.

Only capabilities 9 and 21 are deferred. Other incomplete rows remain explicit
in [the acceptance ledger](codex-acceptance.md). No push, PR publication, merge,
release, or normal installed-profile enablement accompanies this local pass.
