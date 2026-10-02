# Issue 19: isolated Codex subscription support implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute this plan task by task. Implementation belongs to one `gpt-5.6-luna` subagent with reasoning effort `max`; the parent agent owns final review. Do not create additional implementation agents or parallel branches.

**Status:** Proposed; planning only. Await explicit GO before implementation, branch creation, live synthetic turns, scheduling, commits, or PR creation.

**Goal:** Deliver all 25 non-deferred capabilities from issue #19 in one branch and one PR, preserving the shipped Claude implementation and adding independently packaged Codex support.

**Architecture:** Keep `plugins/cc-pacekeeper/` runtime unchanged. Add a self-contained `plugins/codex-pacekeeper/` with native facts, deterministic policy, and native effect delivery. Share behavioral scenarios across the two packages; runtime extraction is not a prerequisite or a deliverable of this PR.

**Tech stack:** Bun, strict TypeScript, bun:test, Zod, native Codex hooks and existing-owner App Server interfaces, filesystem checkpoints, Git, Linux/macOS CI.

**Spec:** [Issue #19 and its full comment trail](https://github.com/leaflessbranch/cc-pacekeeper/issues/19), especially the September 5 evidence audit, plus the user's explicit deferral of capabilities 9 and 21. This document reconciles the older issue body with those newer decisions.

## 1. Controlling decisions

- One feature branch: `feat/issue-19-codex-parity`, targeting `main`; one PR for the complete scope. Serial commits within that branch are fine. Do not merge or publish a release as part of implementation handoff.
- Capability **9, model/window arbitrage: deferred**. Do not duplicate native Codex model switching or add bucket-to-model recommendations. Preserve existing Claude arbitrage.
- Capability **21, away routing: deferred**. Do not build Codex channels, channel onboarding, or a new messaging standard. Preserve existing Claude routing. Presence detection remains in scope.
- Two CLI harnesses and subscription accounts only. API-key and third-party providers get explicit disabled/degraded diagnostics. No API fallback, credit purchases, or reset-credit consumption.
- The latest audit supersedes the issue body's shared-runtime-first rewrite, independent-server-first wake proposal, exact-pong changes to Claude, and TTL experiment requirement.
- Preserve the actual Claude contract, including effective configuration, ordinary debounce re-emission, existing keepalive text, continuation guard, paths, packaging, and platform fallback. Do not strengthen Claude behavior to match aspirational issue prose.
- Codex cadence defaults to 30 minutes; one-hour cache TTL is an accepted product assumption, not a vendor guarantee. No TTL experiment or TTL proof gate. Cache observability remains in scope.
- Preserve defaults: context thresholds 60/75/90, five-hour 70/85/95, weekly 50/70/85; debounce 60 seconds; usage-cache freshness 180 seconds; idle threshold 10 minutes; tool tick 5 minutes; keepalive enabled, pending-work required, maximum continuous idle 12 hours; bridge enabled with maximum wait 60 minutes; auto enabled at five-hour 85%, subagent pause 75%, wake delay 3 minutes. Honor valid overrides rather than normalizing them.
- Context window comes from Codex model/native usage facts. Do not inherit Claude's 200,000-token fallback or usable-window ratio as a Codex truth.
- Treat queue acceptance, model completion, checkpoint save, and checkpoint consumption as separate outcomes. Unknown outcomes remain unknown; they never authorize blind retries.
- Linux and macOS are required CI platforms. Native Windows, other harnesses, rebranding, and the draft cross-session budget overlay are excluded.
- Every non-deferred capability must be implemented and verified, or remain an explicit blocker. An unsupported diagnostic is required failure behavior, not permission to silently remove a row from the requested scope.

## 2. Verified starting point and alternatives

Planning checkout: `main`, HEAD `2751789890e13f0c5ca0d33bb7097a7e45666d48`, Claude package 0.8.2. Codex CLI locally reports 0.153.4 and exposes `codex queue --thread ... --message ...`. Treat this as the initial acceptance target, not proof of a universal minimum supported version.

Pre-existing work to leave untouched:

- Modified `docs/spec-autopilot-presence.md`.
- Untracked `plugins/cc-pacekeeper/docs/design-cross-session-coordination.md`.

Re-read status and issue comments when executing; do not stash, stage, or overwrite unrelated work. Use one isolated worktree for the one feature branch if needed to preserve these drafts; it is not a second concurrent feature effort.

Options considered:

1. **Recommended: isolated Codex package, common acceptance corpus.** Smallest Claude regression surface; some policy duplication is accepted and held in check by tests.
2. Shared-runtime extraction first. Reduces duplication but rewires the installed Claude runtime before native semantics are proved; rejected by the newer audit direction.
3. Thin quota-only Codex plugin. Faster, but omits checkpoint/wake, budgets, presence, and keepalive; does not satisfy this request.

Source findings informing gates:

- Native queue source uses `thread/queue/add` and a client-generated message identifier; separate CLI invocations generate different identifiers. A process lock alone cannot resolve lost acknowledgements. The CLI may start an embedded server, so production delivery must validate the existing owner rather than invoke it blindly. [Pinned native implementation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/session_queue_commands.rs).
- Hook outputs are event-specific. In particular, PreCompact plain stdout is ignored, and stopping compaction is distinct from giving the model a checkpointing turn. Hook trust and specialized tool coverage need real acceptance checks. [Official hooks](https://learn.chatgpt.com/docs/hooks).
- Native account interfaces provide quota windows and bucket metadata. Normalize durations and timestamp units explicitly, preserve unknown buckets, and keep credit availability separate from spend state. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server).

No fresh runtime suite or live queue experiment was run while preparing this plan.

## 3. File and ownership map

Create under `plugins/codex-pacekeeper/`:

| Files | Responsibility |
|---|---|
| `package.json`, `bun.lock`, `tsconfig.json`, `.codex-plugin/plugin.json`, `hooks/hooks.json` | Independent install, strict checking, native hook wiring; manifest schema verified against installed/native docs |
| `bin/pacekeeper-tick`, `bin/pacekeeper-refresh`, `bin/pacekeeper-checkpoint`, `bin/pacekeeper-worktrees`, `bin/pacekeeper-service`, `bin/pacekeeper-doctor` | Small Bun entrypoint shims |
| `src/native.ts`, `src/facts.ts` | Versioned native boundary, owner discovery, subscription/context normalization |
| `src/config.ts`, `src/storage.ts` | Read-only configuration inheritance, isolated atomic state and identities |
| `src/policy.ts`, `src/tick.ts`, `src/refresh.ts` | Pure decisions, event-specific hook effects, cached/detached refresh |
| `src/checkpoint.ts`, `src/checkpoint-cli.ts`, `src/agent-budget.ts` | Owned lanes, CLI consumption, save verification, subagent contracts/handoffs |
| `src/delivery.ts`, `src/jobs.ts`, `src/service.ts` | Existing-owner queue protocol, durable job lifecycle, timers/reconciliation |
| `src/presence.ts`, `src/live-sessions.ts`, `src/worktrees.ts` | Platform probes, account-scoped liveness, safe Git operations |
| `src/doctor.ts` | Structured capability and failure diagnostics |
| `skills/checkpoint/SKILL.md`, `skills/worktree/SKILL.md` | Native model-facing CLI workflows |
| `src/__tests__/*.test.ts`, `src/__tests__/fixtures/native-0.153.4/` | Sanitized wire, behavioral, fault, and packaging tests |

Create `tests/parity/scenarios.json`, `tests/parity/claude.test.ts`, `tests/parity/codex.test.ts`, and `tests/parity/package.json` for black-box compatibility tests. They may launch package CLIs; production packages must not import this harness or each other's runtime.

Modify only the root `README.md`, `CHANGELOG.md`, `.github/workflows/ci.yml`, and the documented Codex distribution catalog if required by the verified packaging mechanism. Do not modify the Claude marketplace registration or version solely to register Codex. New Codex manifest/package versions must match; keep Claude's unchanged version pair intact.

Add `docs/codex-acceptance.md` for the capability ledger and sanitized evidence. These planned filenames are bounded responsibilities, not a requirement to create empty modules; consolidate adjacent files if the implementation stays clearer without weakening the native/policy/I/O separation.

### State and configuration rules

- Codex reads existing `~/.config/cc-pacekeeper/config.json` as a compatibility input without writing/bootstrap/migration. Apply matching defaults, then valid legacy values, then optional `adapters.codex` overrides. Exclude channel and Claude cache-sharing fields from Codex behavior. Validate and diagnose invalid settings explicitly; no silent resets.
- Codex runtime data lives under `~/.cache/cc-pacekeeper/codex/`. Separate account scope, thread, session, and agent identities; use encoded/hash keys and atomic replace/locks, not raw IDs as paths. Account identity is locally derived from authoritative native metadata; unknown account identity disables cross-session aggregation and automation requiring ownership.
- Codex checkpoints live under `<configured checkpoint root>/codex/`, preserving the existing default outer `.claude-checkpoints` directory. Codex never writes loose Markdown in the Claude root. Test that Claude listing, cleanup, supersession, and handoff scans cannot touch Codex data.
- Checkpoint metadata carries explicit harness/account/thread/agent ownership, unique checkpoint ID, lane, branch/worktree, and reset generation where relevant. Automatic selection uses exact IDs, never “latest” or a mutable numeric index. Explicit cross-harness import is outside this PR.
- Store no credentials or raw transcripts in persistent job/checkpoint metadata. Test fixtures use synthetic identities, paths and text.

## 4. Sequential execution tasks

Every task follows: write the named failing acceptance case, run it, implement the smallest change, rerun targeted tests and typecheck, then checkpoint the branch with a reviewed commit. Scan staged content and commit text for secrets, PII, and cross-project material first. The parent reviews milestone evidence and directs repairs on the same branch.

### Task 1 — Freeze compatibility and create the acceptance ledger

**Files:** `tests/parity/*`, `docs/codex-acceptance.md`; existing Claude tests are references, not rewrite targets.

- [ ] Re-read `CLAUDE.md`, issue body/comments, branch status and current base. Record tracked Claude runtime hashes from the base commit.
- [ ] Audit test filesystem/process effects before running them. Launch tests with disposable home/config/cache directories using child-process environment overrides; never set the working shell's HOME or test against live session/config files.
- [ ] Run the existing Claude suite and typecheck in that isolated environment. Record actual commands/results, not the audit's historical 342-test count.
- [ ] Capture reproducible black-box behavior for all Claude rows, including 9 and 21 as preservation checks. Distinguish a directive emitted from an action completed.
- [ ] Add fixtures for ordinary same-level re-emission after debounce, escalation, reset, compaction re-arm, main/subagent isolation, marker quotation, Stop continuation suppression, effective non-default settings, and current Claude keepalive text.
- [ ] Record all 27 rows using the matrix below, with 9/21 explicitly deferred only for new Codex work.

**Gate:** Baseline passes; no test touches real home/state; no Claude behavior is silently redefined.

### Task 2 — Prove the native owner and event boundary first

**Files:** new `src/native.ts`, native fixture tests, `docs/codex-acceptance.md`.

- [ ] Generate/read the installed CLI protocol schema and verify plugin manifest/trust wiring. Pin the fixture version and source provenance. Do not invent fields from hook names.
- [ ] Implement a minimal bounded native client. Discover an already running owner; no fallback that resumes the target through a second server. Probe required methods and return typed unsupported/unavailable results.
- [ ] Read native account/rate-limit/token facts without copying credentials. Verify cached reads can support hook timeouts.
- [ ] In a task-owned subscription thread, test queue delivery while idle, queue during an active turn, user activity between enqueue and execution, owner restart, unavailable owner, cancelled submission, and lost acknowledgement. Correlate submission and completed turn by stable native identity.
- [ ] Verify whether the selected protocol permits stable client IDs and reconciliation. If not, retain ambiguous state without retry; report the capability gap to the parent.
- [ ] Verify a queued synthetic message can be suppressed before model work and without entering conversation context. Separately verify strict no-tools through every tool surface available in the acceptance thread. A no-tools instruction or PostToolUse detection is insufficient enforcement.
- [ ] Verify proactive context-critical checkpoint execution before compaction. PreCompact cannot be treated as an ordinary model turn; establish an actual save barrier or identify the blocker before building dependent automation.

**Gate:** Parent reviews the native evidence before Tasks 5–7. If safe no-tools execution, pre-model suppression, save barrier, or owner reconciliation cannot be implemented through supported interfaces, keep those rows blocked. Continue independent reads/pacing/CLI work, but do not widen scope into a Codex fork or claim complete support.

### Task 3 — Package, configuration, storage, and readings

**Files:** package/manifests/shims, `src/{config,storage,facts,refresh}.ts`, tests `config.test.ts`, `storage.test.ts`, `facts.test.ts`, `packaging.test.ts`.

- [ ] Build the independent package and native hook manifest using the schema proved in Task 2. Install only in a disposable acceptance profile until live installation is separately authorized.
- [ ] Implement the state/config rules above. Tests cover partial/invalid overrides, unchanged legacy config bytes, equal thread IDs in different accounts, hostile IDs/path traversal, atomic-write crash, and concurrent writers.
- [ ] Normalize all quota buckets. Table-driven cases include primary=weekly/secondary=null; primary=5h/secondary=weekly; unknown 15-minute buckets; shuffled bucket maps; omitted fields; invalid percentages; timestamps seconds-to-milliseconds; stale/reset rollover.
- [ ] Keep authentication, observation freshness and spend classification explicit. `credits available` must not imply paid spending. Subscription automation requires a supported, fresh included-capacity classification; unknown/paid/unsupported disables it with a reason.
- [ ] Compute current context from native current-turn/context usage and model window metadata, not lifetime totals. Cover clear, resume, compaction, model change, missing window and malformed/version-drift fallback.
- [ ] Record observed cache read/write/uncached fields without fabricating unavailable values. Keep cache diagnostics separate from ordinary status.

**Gate:** Negative auth tests never fetch API usage; no fabricated quota/context values; no changes to Claude config/runtime/state; hooks use bounded cached work.

### Task 4 — Pacing, lifecycle, and liveness

**Files:** `src/{policy,tick,live-sessions}.ts`, tests `policy.test.ts`, `hooks.test.ts`, `live-sessions.test.ts`, parity corpus.

- [ ] Separate native normalization from deterministic decisions and response encoding. Policy inputs include event/identity, now, current meters, activity, state and effective settings; outputs contain next state plus explicit effects. No filesystem or native calls inside decision functions.
- [ ] Match actual Claude thresholds, ordinary debounce, escalation, block identity, once-per-compaction save re-arm, and main/subagent isolation. Do not invent new hysteresis behavior.
- [ ] Encode each tested lifecycle event separately: session start/end, prompt, pre/post tool, pre/post compact, subagent start/stop, Stop and Interrupt. Suppress re-entry on native continuation flags.
- [ ] Keep user input, substantive work, queued submission and synthetic execution separate in timing state. Synthetic events must not alter user-idle anchors, threshold decisions or AFK-return messages.
- [ ] Inject compact model-facing time/age/idle/context/quota status and pacing directives. Avoid duplicating native UI-only warning banners.
- [ ] Count only verified live local owners sharing the same known account. Exercise stale heartbeat, dead/reused PID, owner restart, unrelated account, duplicate thread records and unknown identity. Do not count transcript files as sessions.

**Gate:** Common scenario outcomes match the frozen reference where applicable; unknown native facts degrade visibly; no continuation loops or account-crossing state.

### Task 5 — Checkpoints, compaction, renewal preparation and worktrees

**Files:** `src/{checkpoint,checkpoint-cli,worktrees}.ts`, checkpoint/worktree shims and skills; tests `checkpoint.test.ts`, `checkpoint-cli.test.ts`, `compaction.test.ts`, `worktrees.test.ts`.

- [ ] Implement owned save/list/peek/resume/archive/supersede/discard/cleanup with branch/worktree provenance and safe project-root resolution. Preserve lane semantics, including ambiguous bare resume asking for selection without consuming anything.
- [ ] Write checkpoints atomically and verify their persisted content/ID before acknowledging save. Cover partial writes, symlinks, ambiguous lanes, stale lanes, concurrent saves and same-name Claude lanes.
- [ ] Context-critical handling invokes the proved save path once per cycle and verifies resumable content: goal, current work, next step, unresolved questions and relevant provenance. A hook instruction alone is not a saved checkpoint.
- [ ] If compaction arrives before successful save, use only the native barrier proved in Task 2; avoid repeated blocking loops. An inability to preserve a resumable checkpoint remains a row-11 blocker.
- [ ] Prepare block-renewal checkpoints with exact reset generation and ID; select bridge only when the real reset is within configured maximum wait. Preserve current thread during bridge; do not spin model turns or renew against an already rolled-over timestamp.
- [ ] Implement resume consumption with a durable claim/ack path: preserve recoverable content on failure, archive after successful CLI consumption, and reconcile interrupted consumption by checkpoint ID.
- [ ] Port Git list/create/cleanup workflow and skills. Do not remove dirty, locked or live-owned worktrees. Liveness uncertainty or failed git status must not be interpreted as safe deletion. Include spaces/symlinks and cross-harness occupancy tests.

**Gate:** Observable checkpoint file exists before save success; foreign lanes survive all operations; repeated resume does not replay work; Git helpers refuse unsafe cleanup.

### Task 6 — Subagent lifecycle

**Files:** `src/agent-budget.ts`, `src/tick.ts`, checkpoint skill; tests `agent-budget.test.ts`, `handoff.test.ts`, `dispatch.test.ts`.

- [ ] On native subagent start, derive the spawn-relative contract from fresh shared-account readings. Record parent/thread/agent identity and use an absolute installed CLI path in the model-facing contract.
- [ ] Apply the preserved pause calculation; label account-window deltas as estimates, never per-agent billing. Reset rollover must rebase the estimate without producing negative consumption.
- [ ] On pause, persist an owned handoff and return the existing pause marker convention. Parent receives it once, absorbs it, then archives it. A notification is not absorption; preserve content until acknowledgement.
- [ ] Advise before expensive fan-out using the actual native spawn tool mapping. Never deny ordinary spawning because of an advisory. Test uncovered/specialized dispatch shapes explicitly.
- [ ] Exercise nested agents, duplicate start/stop, parent restart, missing parent, failed handoff write, and repeated pause notification. Never blindly respawn paused work.

**Gate:** One live child pause-to-parent-absorption trace plus deterministic duplicate/reset cases; no main-thread debounce starvation or automatic retry loop.

### Task 7 — Durable scheduling, exact keepalive, reset wake

**Files:** `src/{delivery,jobs,service}.ts`, service shim; tests `jobs.test.ts`, `delivery.test.ts`, `keepalive.test.ts`, `reset-wake.test.ts`.

- [ ] Implement separate recurring keepalive and one-shot reset-wake identities. Job state includes owner scope, exact target, due time/reset generation, stable submission ID and state: scheduled, submitting, queued, running, completed, cancelled, or ambiguous.
- [ ] Persist submission intent before sending. Reconcile after crash/lost acknowledgement using native identity; do not issue a new ID and retry an ambiguous delivery. Reject a different owner rather than silently starting one.
- [ ] Recheck enabled/auth/freshness/included-capacity/pending-work/idle/liveness eligibility before enqueue AND at execution. User activity wins races. Session end, loss of pending work, max idle, auth change and paid-credit transition cancel owned pending jobs.
- [ ] Eligible keepalive sends exactly `[pacekeeper-keepalive] ping` to the existing thread/model. Use the Task 2 no-tools path, suppress other policy effects for that turn, require the one-word `pong` result, and record missing/non-exact/failed results. Never run cleanup tools inside the ping turn; the service owns cleanup.
- [ ] Preserve the thread's model and stable prefix. Clear/model change cancels or rebinds jobs only after validating new identity; compaction/resume/service restart cannot create duplicate recurring jobs.
- [ ] Schedule reset wake only after checkpoint save success, at authoritative reset plus configured delay. Recheck actual reset and cancellation before delivery; consume the exact checkpoint through the CLI and verify archive acknowledgement before marking complete.
- [ ] Exercise kill points before send, after native accept, during turn, after consumption, and before local completion write. Reconcile ambiguous outcomes without replay. Do not claim distributed exactly-once execution from locking alone.
- [ ] Restrict service operations to complete owned payload schemas and job IDs. A marker, arbitrary prompt, arbitrary target, or broad permission hook must never grant scheduling/deletion authority.

**Gate:** Same-thread idle pong with no tool execution; suppressed ping causes no model/context/state side effects; all cancellation/race/crash tests pass; real reset trace consumes the correct lane once. No TTL experiment is required.

### Task 8 — Presence and complete diagnostics

**Files:** `src/{presence,service,doctor}.ts`, doctor shim; tests `presence.test.ts`, `doctor.test.ts`.

- [ ] Port Linux probe fusion with unavailable probes never voting AFK and attachment requiring activity. Preserve non-Linux fallback; do not claim proactive macOS detection.
- [ ] Sample presence independently of hook activity using the owned service. Store transitions in Codex state and surface them through the proved native notification path, with deduplication and no external routing. If native proactive delivery is unavailable, report the precise limitation as an acceptance blocker for that promised behavior.
- [ ] Doctor distinguishes version/schema mismatch, unsupported auth, stale quota/context, owner absent, queue unsupported, ambiguous delivery, missing hook trust, missing executable, permissions, crash, invalid config and missing cache fields.
- [ ] Include explicit `deferred` entries for model/window arbitrage and channels. Do not ask Codex users for channel preferences.
- [ ] Verify doctor is read-only by default and that any active acceptance command targets only explicitly selected task-owned threads/jobs. Capture diagnostics without credentials, raw prompts or sensitive path values.

**Gate:** Probe and diagnostics fixtures pass on both platforms; a controlled away/back observation is recorded on Linux; unsupported capability is never reported as healthy.

### Task 9 — Integration, CI, soak and one PR

**Files:** `.github/workflows/ci.yml`, root docs/changelog, `docs/codex-acceptance.md`, both new skills, new package manifests/catalog as required.

- [ ] Extend CI to run original Claude, new Codex, and parity suites plus typechecking on Linux/macOS. Keep separate package installs independently reproducible; packaged Codex must work without a sibling checkout.
- [ ] Run public CLIs and real hook wire fixtures in disposable homes. Compare Claude runtime hashes to the baseline and verify user drafts never entered the diff.
- [ ] Run a subscription smoke matrix across available representative supported model/window sizes, recording exact versions and observed boundaries. Do not infer every model passes from one model or enable arbitrage to produce this evidence.
- [ ] Record a real five-hour reset/bridge/wake trace and a real weekly reading. A fake clock proves scheduling logic but does not replace live reset acceptance. Keep the same branch open during soak; no second feature branch.
- [ ] Document install/trust/disable/uninstall, isolated paths, inheritance precedence, diagnostics, subscription-only behavior, accepted cache assumption and all 27 capability statuses. Codex remains explicit opt-in initially; removing opt-in or publishing is a separate release decision.
- [ ] Validate new manifest/package version synchronization and unchanged Claude version pairing. Update the matching skills for every shipped CLI verb/flag.
- [ ] Parent reviews full final diff and evidence. Luna repairs findings on the same branch; parent reruns affected checks and verifies exact final SHA.
- [ ] Once authorized to publish the PR, open the single PR with scope, deferrals, validation and remaining live gates. Use `Refs #19` while deferred/incomplete issue scope remains; do not automatically close the issue or merge.

**Gate:** All 25 scoped rows meet acceptance and both platform jobs pass. If a native/platform/live gate remains blocked, retain the same draft PR with an explicit blocker; do not label the requested work complete.

## 5. Capability-to-acceptance ledger

| # | Capability | Task | Required evidence |
|---:|---|---:|---|
| 1 | Subscription authentication | 3 | Native subscription positive; API-key/unsupported negative; no secret leakage |
| 2 | Quota acquisition | 3 | Duration/order/unknown bucket fixtures; native 5h and weekly comparison |
| 3 | Context meter | 3–4 | Current context, compaction/model-change fixtures and live comparison |
| 4 | Compact status injection | 4 | Event-specific model-visible status; concise output |
| 5 | Threshold state machine | 1,4 | Frozen thresholds and actual reset/re-arm outcomes |
| 6 | Debounce/idempotency | 4,7 | Ordinary re-emission, continuation guard, duplicates and identity isolation |
| 7 | Time/AFK awareness | 4,8 | Genuine idle survives accepted and suppressed synthetic turns |
| 8 | Cross-session awareness | 4 | Same-account live owners only; stale/dead/unknown cases |
| 9 | Model/window arbitrage | Deferred | Existing Claude behavior preserved; no Codex implementation |
| 10 | Checkpoint lanes | 5 | Full CLI lifecycle, isolation, roots, provenance |
| 11 | Context auto-save | 2,5 | Persisted resumable checkpoint before compaction, once per cycle |
| 12 | Five-hour renewal | 5,7,9 | Verified save, actual reset, correct same-thread wake |
| 13 | Near-reset bridge | 5,7,9 | Bounded wait and same-thread continuation over real reset |
| 14 | Resume consumption | 5,7 | Correct exact-ID archival, duplicate/crash reconciliation |
| 15 | Subagent budgets | 6 | Spawn-relative estimate, native lifecycle, reset rollover |
| 16 | Subagent handoffs | 6 | Child pause, parent receipt/absorption/archive |
| 17 | Dispatch advisory | 6 | Native spawn mapping; advice without denial |
| 18 | Cache keepalive | 2,7 | Same-thread exact pong/no tools, 30-minute default, all safety gates |
| 19 | Cache observability | 3,8 | Observed fields/cold evidence; missing distinguished from zero |
| 20 | Presence detection | 8 | Linux away/back; unavailable probe and macOS fallback |
| 21 | Away routing | Deferred | Existing Claude channels preserved; no Codex onboarding/transport |
| 22 | Worktree helper | 5 | List/create/cleanup; dirty/locked/live/unknown refusal |
| 23 | Security-scoped automation | 3,7 | Full owned payload validation, traversal/foreign-job rejection |
| 24 | Diagnostics | 8 | Distinct actionable failures; trust actually executed |
| 25 | Configuration | 3 | Effective override preservation; optional Codex settings; no migration |
| 26 | Platform behavior | 9 | All three suites/typechecks green on Linux and macOS |
| 27 | Documentation/release | 9 | Installable opt-in package, complete matrix, truthful evidence, versions |

## 6. Test commands and representative assertions

Run commands inside the execution runner's disposable-home environment after its filesystem-safety audit:

```bash
bun install --cwd plugins/cc-pacekeeper --frozen-lockfile
bun test --cwd plugins/cc-pacekeeper
bun run --cwd plugins/cc-pacekeeper typecheck
bun install --cwd plugins/codex-pacekeeper --frozen-lockfile
bun test --cwd plugins/codex-pacekeeper
bun run --cwd plugins/codex-pacekeeper typecheck
bun install --cwd tests/parity --frozen-lockfile
bun test --cwd tests/parity
bun run --cwd tests/parity typecheck
git diff --check
```

Generate each new package lockfile during its initial dependency setup before using `--frozen-lockfile`. Verify Bun option support locally and use equivalent package working directories if needed.

Example black-box assertion structure for the test harness (the harness implements `runScenario` and returns the observations named here):

```ts
test('user activity wins an already queued keepalive race', async () => {
    const result = await runScenario('queued-ping-then-user-input', 'codex');
    expect(result.syntheticModelTurns).toBe(0);
    expect(result.syntheticToolCalls).toBe(0);
    expect(result.contextAfter).toEqual(result.contextAfterUserInput);
    expect(result.lastUserActivityAt).toBe(result.userInputAt);
    expect(result.checkpointsAfter).toEqual(result.checkpointsBefore);
});

test('lost acknowledgement cannot cause a second reset resume', async () => {
    const result = await runScenario('reset-wake-lost-ack-restart', 'codex');
    expect(result.resumeExecutionsForCheckpoint).toBe(1);
    expect(result.activeCheckpointIds).not.toContain(result.targetCheckpointId);
    expect(result.archivedCheckpointIds).toContain(result.targetCheckpointId);
});

test('Codex lane operations preserve the Claude lane', async () => {
    const result = await runScenario('same-lane-two-harnesses', 'codex');
    expect(result.claudeFilesAfter).toEqual(result.claudeFilesBefore);
    expect(result.codexActiveLaneCount).toBe(1);
});
```

Use deterministic fake time and injected failure points for races; live tests assert native observed outcomes separately. The test harness must not merely echo the policy's decisions as if they were native effects.

## 7. Review and handoff

After GO, the parent prepares the single branch/worktree and dispatches exactly one worker with these explicit tool settings:

```json
{
  "task_name": "issue_19_implementation",
  "model": "gpt-5.6-luna",
  "reasoning_effort": "max",
  "fork_turns": "none"
}
```

The dispatch message supplies the absolute execution worktree and plan locations at runtime, base SHA, authorization boundaries, existing-draft exclusions and this instruction:

> Implement Tasks 1–9 serially on the supplied branch. Read the plan, repository instructions and current issue comments first. Preserve the Claude runtime. Defer only capabilities 9 and 21. Use no additional implementation agents or branches. Report evidence at the native feasibility gate and each milestone. Never replace unknown native semantics with a simulated success. Keep unresolved rows visible; continue independent work where possible. Return the full change summary, test commands/results, acceptance ledger, final SHA and outstanding blockers to the parent. Do not merge, publish a release, install into unrelated live profiles or contact external destinations.

The parent performs final review personally using both DevOps and architecture perspectives: full diff, independent scenario assessment, native wire contracts, account/lane ownership, crash/retry behavior, no-tools enforcement, hook trust, packaging isolation, both-platform CI and recorded live outcomes. Review claims must match the exact final SHA. Findings go back to the same Luna worker, and repaired areas are reviewed again.

Pre-execution plan review resolved these risks:

| Risk | Amendment |
|---|---|
| Old issue proposes modifying Claude before Codex evidence | Freeze Claude runtime; common tests instead of extraction |
| Queue acknowledgement mistaken for execution | Stable submission identity, native reconciliation, ambiguous state |
| Late user input still permits a synthetic turn | Execution-time suppression is an early native gate |
| No-tools prose mistaken for enforcement | Require native coverage; keep row blocked if unsupported |
| PreCompact reminder mistaken for completed save | Prove persisted save barrier before dependent automation |
| Shared checkpoint root allows cross-harness supersession | Isolated Codex subtree and foreign-lane regression cases |
| “Credits available” treated as spending state | Fresh authoritative included-capacity classification |
| Deferred channels accidentally remove presence | Separate rows/tasks; preserve Linux probe and fallback work |
| Green tests mistaken for full acceptance | Real reset, weekly reading, child handoff and two-platform evidence |

Approval requested is for this concrete execution plan. The user's PLAN-vs-GO rule and issue #19's planning-only status are why no worker is armed during planning. A GO can authorize implementation and bounded task-owned native acceptance; PR publication and any changes to normal installed profiles must match the authorization actually given. Merge and release remain separate.
