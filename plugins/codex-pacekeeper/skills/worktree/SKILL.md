---
name: worktree
description: List, create, and clean up git worktrees for Codex sessions. Use to work on an isolated branch without disturbing the current checkout.
---

# Worktrees

Worktrees isolate a branch from the current checkout so in-progress edits are
not disturbed.

## Cleanup safety

Never remove a worktree that:

- has uncommitted changes, unless the user explicitly confirms;
- is locked;
- is occupied by a live session, in either harness.

Uncertainty is not permission. If liveness cannot be determined, or `git
status` fails, treat the worktree as occupied and leave it alone. A worktree
wrongly kept costs disk space; a worktree wrongly deleted costs work.
