---
name: checkpoint
description: Save, resume, and list Codex-owned cc-pacekeeper checkpoints. Use when limits are nearing, before context compaction, or to orient a fresh session from a previously saved checkpoint.
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

Always resume by exact checkpoint id. Resuming archives the checkpoint, so a
stale one is not re-surfaced later.

- Resuming an id that was already consumed reports `already-consumed`. That is
  the correct answer, not an error to retry around: the work was already
  picked up, and repeating it would redo finished work.
- A bare resume with more than one active lane reports the lanes and consumes
  **nothing**. Choose one explicitly.
- Archived content is retained, so a consumer that fails after resuming can
  still recover the text.

## What a checkpoint is not

Being told to save is not a save. Only a checkpoint whose file exists on disk,
with its content verified, counts. If saving fails, say so rather than
proceeding as though the work is protected.
