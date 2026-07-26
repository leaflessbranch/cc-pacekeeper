# Spec: Autopilot + Presence-Aware Channels

Status: **locked design, not yet implemented**
Date: 2026-07-26
Ships as **two independent releases**. Presence (Feature 2) lands first — Autopilot's
notification story depends on it.

---

## Feature 2 — Presence detection + channel switching

Ships first. Useful standalone for any long-running session.

### Problem

Today AFK detection is purely retroactive: `detectAfkReturn` in `timeline.ts` measures
the gap between two hook events, so "user is away" is only knowable *after* they come
back. Nothing can act on absence while it is happening.

### Presence module — `src/presence.ts`

```ts
type ProbeState = 'active' | 'idle' | 'unavailable';
type Signal = { name: string; state: ProbeState; lastActivityMs?: number; detail?: string };
type Presence = {
  state: 'online' | 'afk' | 'unknown';
  signals: Signal[];
  lastActivityMs: number | null;
};
```

**Probes** (Linux; each independently try/catch'd to `unavailable`, never throwing):

| Probe | Mechanism | Notes |
|---|---|---|
| `hook-gap` | existing `lastEventAt` from `session-state.ts` | always available; the only probe on macOS today |
| `tmux` | `tmux list-clients -F '#{client_activity} #{client_tty}'` | **attachment + recency**, not existence |
| `tty` | `stat -c %X <tty>` (atime of the controlling terminal device) | resolved from the session's tty |
| `ssh` | `who`, plus `ss -tnp` for live sshd sockets | see nesting rule below |
| `loginctl` | `loginctl show-session <id> -p IdleHint -p IdleSinceHint` | systemd only |

**Fusion — priority ladder, not any-of:**

1. A hook event in this session within `idle_minutes` → `online`. This outranks
   everything: the user demonstrably typed here.
2. Otherwise, any probe reporting **activity** within `idle_minutes` → `online`.
3. All probes report `unavailable` → `unknown` (never `afk`).
4. Every available probe reports idle beyond `idle_minutes` → `afk`.

**An unavailable probe never votes `afk`.** Degradation must fail toward "assume
present", because a false `afk` reroutes output away from a user who is watching.

**Nesting rule (SSH × tmux).** Presence requires *attachment + recency*, never mere
connection existence. A live SSH socket with no recent activity beneath it — the
closed-laptop case, where the TCP connection lingers for minutes — contributes
**nothing** to the ladder: it votes neither `online` nor `afk`. Covered cases:

- SSH alive + tmux client attached + recent `client_activity` → `online`.
- SSH alive + tmux client **detached** → no vote from either probe.
- No SSH, local TTY, tmux attached, recent activity → `online`.
- Bare SSH (no tmux), recent TTY atime → `online`.

**Caching.** Result cached ~30 s in `~/.cache/cc-pacekeeper/presence.json`. Probes are
five subprocesses; they run in the already-detached `refresh.ts` child (PostToolUse,
need-gated), so no new daemon and no added hook latency.

**Platform.** Linux-first. macOS is explicitly deferred — we have no way to test it.
The code must not *break* there (CI runs both): every non-Linux probe reports
`unavailable`, so macOS falls back to today's `hook-gap` behavior.

**Doctor.** A new check prints which probes are available on this box and the current
fused state.

### Channel switching

Hooks are short-lived bun processes with no MCP access, so pacekeeper **cannot send
messages itself**. It injects an instruction into context and Claude performs the send
with its own MCP tools.

Injected on transition to `afk`, e.g.:

> `[pacekeeper] User is AFK (no input 23m). Route significant updates to the configured
> channel: <channel> → <target>. Keep terminal output normal.`

Channel and target are **read from config only** — never hardcoded, never in code,
tests, docs, or committed examples (CLAUDE.md §7).

**Send policy: significant events only.** Task completed, task blocked, threshold
crossed, run finished, question needed. Never mirror every assistant turn.

**Direction: notify-only for v1.** The Telegram/Signal MCP plugins already handle
inbound separately; feeding replies into a running autonomous loop is a much larger
design and is out of scope.

### Config addition

```jsonc
{
  "presence": {
    "enabled": true,
    "idle_minutes": 10,
    "probes": { "tmux": true, "tty": true, "ssh": true, "loginctl": true }
  },
  "channels": {
    "preferred": "none",              // "telegram" | "signal" | "command" | "none"
    "telegram": { "chat_id": "" },    // placeholder — real value is user-local only
    "signal":   { "recipient": "" },
    "command":  { "argv": [] },       // escape hatch for users without MCP channels
    "fallback": "none"
  }
}
```

---

## Feature 1 — Autopilot: autonomous multi-task sessions

Ships second, in **two PRs**: (1) plan/lock/execute-one-block, (2) auto-wake across
block boundaries.

### Shape

Three phases: **grill → lock → execute**.

1. **Grill.** Self-contained interview shipped inside `skills/autopilot/`. It **must
   not** depend on the third-party `grilling` skill: cc-pacekeeper is a standalone
   marketplace plugin, the manifest has no dependency mechanism to declare such a
   requirement, and both existing skills are fully self-contained. A hard dependency
   would silently break for every user who has not separately installed it.

   The interview is therefore inlined — enough of it to produce a spec, task list, and
   acceptance criteria. If a richer grilling skill *is* present the user can always run
   it first and hand the result in; autopilot accepts a pre-written spec as input and
   skips its own interview.
2. **Lock.** Writes `plan.md` and marks it immutable.
3. **Execute.** Works tasks one at a time, self-pacing across 5-hour blocks.

### State model — manifest, not checkpoint queue

A single `plan.md` at `.claude-checkpoints/plans/<slug>.md` is the source of truth:
locked spec body, ordered task list, per-task acceptance criteria and status, and the
grilling Q&A record.

Checkpoints keep their current meaning — lazily created in-flight snapshots, one per
task as work begins. **They are not the queue.** `resume` archives a checkpoint by
design; a persistent task queue stored as checkpoints would archive itself out of
existence and break the lane contract that `skills/checkpoint/SKILL.md` depends on.

### Locking

Frontmatter carries `locked: true` and a hash of the spec body. Execution refuses to
start if the hash does not match, so mid-run drift is detected rather than silently
absorbed. Not a git commit — plan files may be gitignored.

### Task execution

- **Order:** strict declared order. No dependency DAG (CLAUDE.md §6 — serialize work).
- **Granularity:** no size guard at lock time; a task exceeding one block writes a
  mid-task checkpoint and resumes, using machinery that already exists.
- **Acceptance criteria:** required per task, a runnable command where possible
  (`bun test -t '…'`). Free-text is allowed only with `manual: true`. Without a
  runnable check, "autonomous" means "unverified".
- **Failure:** 2 retries, then mark the task `blocked`, notify via the configured
  channel, and continue to the next task.

### Autonomy boundary

A configurable allowlist of action classes, defaulting to:

```jsonc
"autopilot": {
  "allow": ["edit", "test", "commit", "push", "pr"],   // "merge"/"destructive" off by default
  "max_blocks": 4,
  "max_tasks": 0,                                       // 0 = unlimited
  "pacing": {
    "floor_pct": 10,        // always-available allowance, fixes week-start starvation
    "overdraft_pct": 15,    // how far past the pace line an unattended run may go
    "hard_floor_pct": 90    // never auto-wake above this weekly usage
  }
}
```

`destructive` (deletions, history rewrites, force-push) is **off by default** and must
be opted into explicitly. The allowlist is overridable per plan at lock time.

**Merging is never autonomous.** Push and PR stay enabled even when running unattended
— branch work is safe and a PR is reviewable before it lands. `merge` is a distinct
action class that autopilot will not perform regardless of allowlist contents; the
integration decision stays with the user. This is what makes unattended push/PR
acceptable: everything autopilot produces waits at a reviewable boundary.

### Block boundaries

Auto-wake at 5-hour reset via the existing `[pacekeeper-resume]` + cron mechanism,
gated behind `auto.multitask: true`. Unattended quota burn is the entire risk of this
feature, so it stays opt-in.

### Termination

The loop stops on: all tasks done, **or** `max_blocks` reached, **or** the weekly pace
line below. `max_blocks` bounds a single run; the pace line bounds consumption across
auto-woken blocks, which would otherwise each pass their own block check while
collectively draining the week.

#### Weekly pacing

A static weekly cap does not work: weekly usage is a **cumulative** meter that a run may
join at any value. A configured `max_weekly_pct: 60` means "generous budget" when a run
starts at 5% and "refuse to start at all" when it starts at 75% — the same number with
opposite meanings depending on when the user happens to begin.

Instead, the allowance is apportioned across the week and recomputed at each check:

```
elapsed_fraction   = time elapsed in current weekly window / window length
allowance          = max(floor_pct, 100 × elapsed_fraction)      // floor_pct  default 10
unattended_ceiling = min(allowance + overdraft_pct, hard_floor)  // overdraft  default 15
                                                                  // hard_floor default 90
```

Three numbers, each with a distinct job:

- **`floor_pct`** solves the Monday-morning problem. Early in the week the pace line is
  near zero, so a strict reading would pause autopilot immediately — precisely when the
  most quota is available. Autopilot may always use up to `floor_pct` regardless of how
  early it is.
- **`overdraft_pct`** buys the unattended window, expressed as distance *past* the pace
  line rather than an absolute percentage, so it means the same thing on any day of the
  week.
- **`hard_floor`** is the never-cross. Near week's end the pace line approaches 100% and
  would otherwise permit draining the remaining quota entirely.

**Carry-forward is intended.** The line is a budget with accumulated slack, not a rate
limit: a user who consumed nothing for four days is far below the line and may spend the
whole gap. Pace-based rationing that forfeits unused quota would penalize exactly the
user who conserved.

**Soft for the user, binding for autopilot.** Crossing `allowance` never restricts
interactive work. It pauses *autopilot* and requests authorization, granted as
"continue to X%" rather than "one more block" — the user is reasoning about quota, and a
block-count grant re-asks at an unpredictable point.

**When AFK**, the run continues to `unattended_ceiling` without asking, then stalls,
checkpoints, and notifies. The ceiling is set at lock time, with a clear head, rather
than negotiated half-awake by phone.

Note the practical consequence: an unattended run stalls when it exhausts
`overdraft_pct`, so the usable unattended window is bounded by that number, not by the
length of the night. Measure real block consumption before tuning it.

### Placement

New skill `skills/autopilot/` plus a new `src/plan-cli.ts`. Not folded into
`checkpoint-cli.ts` — mixing plan-queue verbs into the checkpoint surface muddies both
SKILL.md files, and those docs are what future sessions actually follow.

---

### Safety and correctness requirements

These are not optional refinements; the unattended-execution argument depends on them.

#### 1. Plan ownership (concurrent sessions)

The plan manifest is the **first genuinely shared mutable file** in the design.
Everything else in pacekeeper is keyed by `stateKey(sessionId, agentId)` specifically to
avoid shared state. Nothing prevents a second session opening the same repo mid-run,
reading the same plan, and picking the same "next task."

Frontmatter carries an owning `session_id` and a heartbeat timestamp, refreshed each
tick. A session that finds a live owner other than itself refuses to execute and says
so. A stale heartbeat (owner gone) may be claimed after confirmation.

#### 2. Enforced allowlist, not instructed allowlist

The autonomy boundary is currently text in a SKILL.md, and instruction-following is
exactly what degrades over a long unattended run. `merge` being forbidden is
load-bearing for the claim that unattended push/PR is safe — enforcing it by asking
nicely does not support that weight.

`approve.ts` already does real PreToolUse enforcement for cron. The same seam hard-blocks
`git merge`, force-push, and history rewrites **while a plan is active and unattended**,
regardless of what the allowlist text says. Enforcement lives in the hook, not the prose.

#### 3. Dirty-tree precondition at wake

Auto-wake resumes into a working tree that may hold uncommitted changes — the user's,
from working interactively between blocks, or autopilot's own from a mid-task pause.
Committing over in-flight user edits is a genuinely destructive outcome.

Before resuming, autopilot checks the tree. Changes it recognizes as its own (matching
the paused task's checkpoint) are resumed; unrecognized changes stall the run and notify
rather than absorbing them.

#### 4. Sticky blocked status

Retry-twice-then-block is per attempt. Without persistence, a task blocked in block 1 is
retried afresh on every auto-wake — four blocks spent failing the same way.

`blocked` is written to the manifest and survives resume. A blocked task is skipped, not
re-litigated, until the user explicitly unblocks it.

#### 5. Notification timing — RESOLVED 2026-07-26

**Finding: a Stop-hook injection can make tool calls. The notification design works.**

Observed directly: `tick.ts` emitted the keepalive directive on `Stop` via
`emitAdditionalContext`; it surfaced as `Stop hook additional context:` and the model
acted on it, executing `ToolSearch` → `CronList` → `CronCreate`. The resulting recurring
job was confirmed present afterwards, so the calls genuinely executed.

Two constraints this imposes on the channel layer:

- **The injection starts a new turn; it does not extend the finished one.** Each
  notification therefore costs a turn — which matters when the feature's purpose is
  conserving quota. **Batch significant events into one injection** rather than
  injecting per event.
- **Deferred MCP tools require a `ToolSearch` before they are callable.** The Telegram
  and Signal tools are deferred, exactly as `CronCreate` was. The injected instruction
  must therefore **name the specific tool** so it can be resolved; a vague "notify the
  user" is unlikely to reach a tool call.

#### 6. Plan-is-wrong exit

A task turning out to be misconceived is a normal outcome of any plan meeting real code.
The lock hash makes the plan immutable, so autopilot can only implement something
known-bad or block — neither is right.

There is an explicit "plan needs revision" exit: autopilot halts, checkpoints, records
why, and notifies. Revision requires an explicit unlock-and-relock, which rehashes the
body. Autopilot never edits a locked plan itself.

## Open items deferred

- macOS presence probes (no test environment).
- Two-way channel replies into a running autopilot loop.
- Dependency-DAG task selection.

**Rejected, with reasons** — recorded so they are not re-proposed:

- *Static `max_weekly_pct` cap.* Weekly usage is cumulative and a run may join it at any
  value, so one constant means opposite things depending on start time. Replaced by the
  pace line.
- *Deriving budgets from estimated task cost at lock time.* Size estimation is
  unreliable; already rejected for the granularity guard, and it does not become
  reliable when reused for budgeting.
- *Deriving the unattended ceiling from measured block history.* Same guessing problem
  wearing different clothes, plus it is bootstrap-hostile. `overdraft_pct` needs no
  history and adapts correctly on its own.
