# Codex parity review and local completion record

The local completion pass resumed checkpoint
`e96426bf273db327c7b0be2de527f35c4e75c930` and repaired the confirmed review
findings below. Independent Linux suites and typechecks pass. Full plan
acceptance remains blocked by production integration, native capability, live,
and hosted platform gates. This record is not release or merge approval.

The reviewed code is in the commit containing this document. Obtain its exact
revision with `git log -1 --format=%H -- docs/codex-review-2026-10-02.md`.
Claude is preserved against main reference
`e043d1d12ea17b48a4c1912a534ec5ab431dc5e3`.

## Fresh findings and amendments

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

The checkpoint skill now documents exact-id selection and the public reset
registration command with matching generation. Registration does not claim
automatic lifecycle integration or authorized native execution.

## Previous R1-R8 disposition

| Previous finding | Current disposition |
|---|---|
| R1: production fact/owner/scheduling/completion/presence wiring | Improved native control discovery, account/quota refresh, bounded transcript observation, public reset registration, exact native completion parsing, and service-owned activity sampling. Automatic save-to-reset integration, real cross-session owner publication, pre-completion synthetic turn correlation, spawn coverage, and durable parent handoff receipt remain acceptance gates. |
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
| Codex `bun test` | 266 passed, 0 failed |
| Parity `bun test` | 41 passed, 0 failed |
| Claude `bun test` | 418 passed, 0 failed |
| All three `bun run typecheck` commands | Exit 0 |
| Claude package and catalog comparison with current main | Empty diff |
| Standalone locked-dependency package and public CLI smoke | Passed; unauthenticated doctor correctly returns failure and names blockers |
| Native disposable catalog install/read | 18 hooks and two skills registered |
| Public transcript refresh/tick, owner unavailable | Fresh critical context and later invalidation both observed |
| Diff whitespace check | Passed |

Retained local evidence: `/tmp/issue19-parent-validation-bas2xzw6/` holds
`results.json`, suite/typecheck logs and tested source blob identifiers.
Standalone CLI evidence is `/tmp/issue19-parent-cli-an6rlf7v/cli-smoke.json`;
native registration is
`/tmp/issue19-parent-final-package-1pk_sn39/plugin-details.json`; public context
checks are `/tmp/issue19-public-context-aj03m7hc/results.json`.
Temporary artifacts may disappear; the table records their essential results.
The tracked source blobs were compared with this tested set when committing.
The fresh review was bounded source/integration review and reproduced failures;
it does not establish exhaustive coverage or live/native product acceptance.

## Remaining gates

- The examined 0.160.0 native interface does not provide strict no-tools,
  atomic pre-model cancellation, or a model-generated pre-compaction save
  barrier. Production keepalive and reset dispatch stay closed. Queue deletion
  is a cancellation request, not proof that model execution was suppressed.
- Proactive native presence notification remains unproved. Linux sampling and
  persisted transitions do not satisfy proactive delivery or away/back acceptance.
- Native hooks expose turn ids, but this package has no production producer
  binding an in-flight owned submission to that id before hook execution.
  Matching prompt text is deliberately not substituted for this missing proof.
- Handoff files have local Codex-subtree isolation and explicit CLI archival,
  but account/parent ownership, durable parent receipt, and actual native
  child-to-parent absorption remain unproved. A child stop notice is not proof
  that its parent received or absorbed the handoff.
- Manual reset registration is available; automatic verified-save-to-reset
  scheduling and a real reset/bridge/wake trace remain unfinished acceptance.
- Authenticated quota/context/logout and weekly comparisons, trusted hook
  execution, child lifecycle/spawn traces, live away/back, macOS and hosted CI
  remain unrun. Existing tests and offline plugin discovery do not replace them.

Only capabilities 9 and 21 are deferred. Other incomplete rows remain explicit
in [the acceptance ledger](codex-acceptance.md). No push, PR publication, merge,
release, or normal installed-profile enablement accompanies this local pass.
