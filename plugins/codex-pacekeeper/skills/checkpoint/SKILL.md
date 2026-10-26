---
name: checkpoint
description: Save, resume, list, or clean up cc-pacekeeper checkpoints in a Codex session, and write or archive subagent handoffs. Use when limits are nearing, when a pacekeeper directive says to save, before context compaction, to preserve in-flight work for a fresh session, or to orient a new session from a saved checkpoint. To pick up a checkpoint ALWAYS run the `resume` verb — never read the .md file directly, because `resume` also archives it so it is not re-surfaced as pending.
---

# Codex checkpoints

All operations run through the `pacekeeper-checkpoint` CLI. Pacekeeper's own directives print its absolute path; use that exact path (a subagent's shell does not see a PATH shim). The thread id defaults to `$CODEX_THREAD_ID`, which Codex exports to every tool shell, so `--thread-id` is only needed when a directive spells it out.

Codex checkpoints live in their own subtree (`.claude-checkpoints/codex/`) of the project's checkpoint directory. Claude's lanes are invisible here and the reverse holds too, even for lanes with the same name.

## Lanes

Checkpoints are organized into named **lanes**. A lane defaults to the current git branch (from a linked worktree, the worktree's branch), or `default` outside a repo. Pass `--lane <name>` to pick one. Saving supersedes only the previous checkpoint in the same lane. Any Codex session in the project may save to or resume any lane; the saving and resuming threads are recorded as provenance.

## Verbs

| Verb | When to use |
|---|---|
| `save [--lane <name>] [--goal-changed]` | A directive says to save; limits nearing critical; context at warn or critical (after compaction pacekeeper re-injects this checkpoint); end of a working session. |
| `resume [id\|lane\|N]` | Orient from a checkpoint. Prints the body **and archives it**. Bare `resume` picks the only active lane, or lists the lanes and archives nothing when there are several. |
| `peek <id\|lane\|N>` | Preview without archiving. |
| `list [--archived]` | Index, lane, branch, worktree, age, id and first Goal line. |
| `discard <id\|lane\|N> [--reason …]` | The user says a checkpoint is no longer relevant. |
| `cleanup [--apply]` | Periodic tidy; dry-run first, apply only after the user confirms (it deletes old archive files). |
| `handoffs list` | Pending subagent handoffs. |
| `handoffs write <agent_id>` | Used by a paused subagent: pipe the handoff body in. |
| `handoffs archive <agent_id>` | After re-dispatching (or deliberately dropping) a handoff's work. Never move handoff files by hand. |
| `doctor` | "Is pacekeeper working?" — checks the rollout readings, control socket, quota, keepalive service and last ping. |

## Auto-save (no asking)

When the 5-hour block reaches the auto threshold (default 85%) or context reaches critical, a pacekeeper directive tells you to **save immediately without asking the user**. Do it: compose the body and run `save` right away, then keep to small steps.

A 5-hour save also registers a one-shot **wake** for just after the block resets (Codex has no in-session cron, so the CLI does this itself). Check the output: `Registered reset wake for …` means pacekeeper will send a prompt starting with `[pacekeeper-resume]` after the reset; `Reset wake withheld: …` means it could not, and the user will have to prompt you to continue. On a `[pacekeeper-resume]` prompt, run `resume` (this consumes the checkpoint even in the same session), then re-dispatch any pending handoffs, archiving each once absorbed.

## Save flow

Without `--body`, `--body-file` or piped input, `save` prints the body template and exits 2. Fill it in and pipe it back, or write it to a temp file and pass `--body-file` (safest for text with special characters):

- **Goal** — the user's request, quoted verbatim, plus at most one line of scope.
- **Status** — what is done.
- **In flight** — the exact step underway.
- **Next** — the specific next action.
- **Open questions** — anything blocked on the user.
- **References** — plans, PRs, files.

**The Goal is locked per lane.** On later saves in the same lane copy the Goal **verbatim**; progress belongs under Status. A save whose Goal differs is refused (exit 2, both goals printed). Pass `--goal-changed` only when the user explicitly redirected the work.

Report the saved path to the user; do not narrate root resolution. If `save` cannot resolve a safe project root it refuses — re-run with `--cwd <project-root>`.

## Resume flow

Always resume through the CLI. `resume` prints the body and moves the checkpoint to `archive/`; reading the file yourself leaves it active and it will be offered again. Resuming an id that was already consumed reports that it was already picked up: that is the right answer, not an error to work around — the work is in progress elsewhere. After resuming, continue from **Next** unless the user redirects.

## Subagent handoffs

A spawned subagent receives a budget contract with its pause point and an exact `handoffs write` command. At the pause point it finishes the current small step, pipes a handoff (Goal / Done / Next / Files touched) to that command, and returns `PAUSED-BUDGET <agent_id>`. The parent is shown the handoff on its next turn. Re-dispatch the remaining work when the budget allows, then `handoffs archive <agent_id>`. Never blindly retry a paused child.

## Keepalive pings

While a checkpoint or handoff is pending and the session is idle, pacekeeper sends `[pacekeeper-keepalive] ping` about every 30 minutes to keep the prompt cache warm. Reply with exactly `pong` and nothing else: no tools, no file reads, no other work.

## What a checkpoint is not

Being told to save is not a save. Only a checkpoint the CLI reports as saved counts. If saving fails, say so rather than proceeding as though the work is protected.

Suggest adding `.claude-checkpoints/` to the project's `.gitignore` unless the user wants checkpoints committed.
