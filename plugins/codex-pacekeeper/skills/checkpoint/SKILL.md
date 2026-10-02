---
name: checkpoint
description: Save, resume, and list Codex-owned cc-pacekeeper checkpoints. Use when limits are nearing, before context compaction, to orient a fresh session, or to write or receive a scoped subagent handoff.
---

# Codex checkpoints

Codex checkpoints live in their own subtree of the project's checkpoint
directory. They are separate from Claude's: neither harness can read,
supersede, or archive the other's lanes, even when a lane has the same name in
both.

## Saving

Save before compaction and when a meter reaches critical. A checkpoint is only
useful if it can be picked up cold, so write:

- **Goal** — what the work is for.
- **Current state** — what is done and what is in flight.
- **Next step** — the specific next action.
- **Open questions** — anything unresolved.
- **Provenance** — branch, worktree, and relevant files.

Saving supersedes only the same lane. A different lane is left alone.

## Resuming

Always resume by exact checkpoint id. `resume`/`claim` prints the body and a
durable consumer token while leaving the active file in place; acknowledge it
only after the consumer has received the body.

- Resuming an id that was already consumed reports `already-consumed`. That is
  the correct answer, not an error to retry around: the work was already
  picked up, and repeating it would redo finished work.
- A bare resume is rejected and consumes **nothing**. Run `list`, then choose
  an exact checkpoint id.
- Archived content is retained, so a consumer that fails after acknowledgement
  can still inspect the consumed text; a consumer that fails before ack can
  retry the active claim by token.

The concrete command is `pacekeeper-checkpoint`; the package also embeds its
absolute path in subagent contracts. Use `list` first, then pass the exact id
to `peek`, `resume`, `discard`, or the durable `claim`/`ack` API. A claim keeps
the active file in place while a consumer works; only an acknowledgement
archives it. The CLI `ack` requires the exact token printed by `claim`/`resume`
and the owning thread id. Queue acceptance and a reset wake are separate from
checkpoint consumption.

## Preparing a reset wake

Run `pacekeeper-checkpoint save --thread-id <thread> --account-id <account>`
and verify the printed checkpoint id. After the checkpoint is persisted, the
CLI registers a reset wake only when it can verify the loaded native thread,
matching account and one valid future five-hour reset. A normal checkpoint
save remains available if that native evidence is unavailable or disagrees;
the CLI reports why it withheld the wake and does not record an unverified
reset generation.

An explicit `bin/pacekeeper-service schedule-reset` request is still available
when you have an authoritative reset timestamp and matching checkpoint
generation. Never infer either from a usage percentage or guessed clock.
Registration is a durable request, not delivery: production wake execution
remains blocked until native pre-model cancellation is supported, and live
reset acceptance has not been verified.

## Subagent handoffs

When native account and parent ownership is verified, a child budget contract
provides a scoped `handoffs write` command. Use its account, child thread,
parent thread and project values exactly; the CLI checks the persisted native
mapping. Legacy unowned handoffs are not adopted.

After the parent receives the supported V1 `wait_agent` completion notice, it
must read and absorb the exact handoff before running the displayed scoped
`handoffs ack` command. Archive only after that acknowledgement. A child stop
hook does not count as parent receipt, and a V2 wait summary without a child
identity does not trigger automatic handoff delivery.

Codex's native PreCompact hook does not prove a save barrier. When the hook
reports critical context, run `save` and verify the printed file before
continuing; a directive alone is not evidence that a checkpoint exists.

## What a checkpoint is not

Being told to save is not a save. Only a checkpoint whose file exists on disk,
with its content verified, counts. If saving fails, say so rather than
proceeding as though the work is protected.
