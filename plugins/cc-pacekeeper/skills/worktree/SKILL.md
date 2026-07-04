---
name: worktree
description: List, create, and clean up git worktrees for the current project. Use when the user wants to work on an isolated branch without disturbing the current checkout, asks "what worktrees do I have", wants to spin up a scratch worktree, or wants to tidy up finished ones. Never removes a worktree with uncommitted changes unless the user explicitly confirms.
---

# /cc-pacekeeper:worktree

Lightweight git-worktree lifecycle helpers. Worktrees let you check out a second branch in a separate directory that shares the same repo — useful for isolated feature work, but easy to lose track of. This skill lists them with live-session and dirty-state annotations, creates new ones, and cleans up safely.

## Verbs

| Verb | When to use |
|---|---|
| `list` | "What worktrees do I have?" or before creating/removing one. |
| `new [name]` | User wants an isolated checkout for a branch. |
| `cleanup` | Tidy finished worktrees. Never touches dirty trees without explicit confirmation. |

## list

Run the shim `pacekeeper-worktrees` (added to PATH while the plugin is enabled). It prints JSON:

```
{ "worktrees": [ { "path", "branch", "head", "bare", "detached", "locked", "dirty", "liveSessions" } ] }
```

Present it as a short table. Call out any worktree that is `dirty` (uncommitted changes) or has `liveSessions > 0` (a Claude session is running there right now — removing it would pull the rug out from under that session).

## new [name]

Use the harness's `EnterWorktree` tool to create and switch into a new worktree. By default it lands at `.claude/worktrees/<name>/` on a new branch `worktree-<name>`, branched from the repo's default branch (`origin/HEAD`). Pick `<name>` from the user's intent.

- Suggest adding `.claude/worktrees/` to `.gitignore` so worktree contents don't show as untracked files in the main checkout.
- Worktrees are a fresh checkout and do **not** inherit gitignored files (`.env`, local configs, build caches). If the project relies on such files, tell the user to add a `.worktreeinclude` file (`.gitignore` syntax) to the repo root — the harness copies matching gitignored files into each new worktree.
- One branch per worktree: git refuses to check out a branch already checked out elsewhere. If that happens, reuse the existing worktree or pick a new branch.
- Remember to run project setup (install deps, venv, etc.) in the new worktree — it doesn't carry those over.

## cleanup

The harness already handles the common case: **exiting** a worktree (`ExitWorktree`) auto-removes it and its branch when the tree is clean (no uncommitted changes, untracked files, or new commits), and prompts to keep-or-remove when it's dirty or named. This skill's `cleanup` covers worktrees that linger beyond that.

1. Run `list` first and show it to the user.
2. **Never remove a worktree that is `dirty` or has `liveSessions > 0`.** For a dirty tree, surface the uncommitted changes and stop — the user must commit, stash, or explicitly confirm `--force`. A running session's worktree is `git worktree lock`ed by the harness anyway.
3. Remove a clean, idle worktree with `git worktree remove <path>`. Use `--force` only when the user has explicitly confirmed they accept losing uncommitted/untracked work.
4. After removals, `git worktree prune` clears any stale administrative entries.

## Note

This skill has no hooks and changes no budget behavior — it's purely a convenience wrapper around git worktrees plus cc-pacekeeper's live-session awareness.
