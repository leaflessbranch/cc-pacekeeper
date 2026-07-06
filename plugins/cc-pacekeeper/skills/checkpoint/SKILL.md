---
name: checkpoint
description: Save, resume, list, or clean up cc-pacekeeper checkpoint files. Use when limits are nearing, before context compaction, to preserve in-flight work for resumption in a fresh session, or to orient a new session from a previously saved checkpoint. To orient from or pick up a checkpoint, ALWAYS run the `resume` verb — never open/Read the .md file directly, because `resume` also archives it (marks it resumed and moves it to archive/) so a stale checkpoint isn't re-surfaced next session; reading the file skips that archival and leaves it dangling. Checkpoints live in the project's .claude-checkpoints/ and the user controls commit/ignore/delete via git.
---

# /cc-pacekeeper:checkpoint

Persistent resumable handoff files for cc-pacekeeper. All operations run via the shim `pacekeeper-checkpoint` (added to PATH while the plugin is enabled).

## Lanes

Checkpoints are organized into named **lanes** — parallel active checkpoints that don't supersede one another. A lane defaults to the sanitized current git branch name (lowercase, non-`[a-z0-9]` runs collapsed to `-`), or `default` outside a repo / on detached HEAD. Pass `--name <slug>` to `save` to pick a lane explicitly.

Saving into a lane only supersedes the *previous active checkpoint in that same lane* — actives in other lanes are left untouched. This is what lets you keep a checkpoint alive on `main` while iterating on a feature branch in a worktree, for instance.

Legacy checkpoints saved before lanes existed have no `name` in frontmatter; they're treated as belonging to the lane derived from their `git_branch` (or `default` if that's also absent) — never a hard error.

## Verbs

| Verb | When to use |
|---|---|
| `save [--name <slug>]` | User wants to preserve current state. Limits nearing critical. Before `PreCompact`. End of a working session. Lane defaults to the current branch. |
| `resume [name\|N] [--worktree]` | New session in a project that has active checkpoints. Bare `resume` picks the sole active lane, or lists all lanes and asks you to choose if there are several (nothing is archived in that case). `--worktree` re-enters (or creates) a worktree for the resumed checkpoint afterward. |
| `peek <name\|N>` | Preview a checkpoint's body without archiving or mutating anything — use when checking a lane before committing to resume it. |
| `list [--archived]` | User asks "what checkpoints do I have here?" or wants to choose a non-default lane to resume. Shows index, lane name, branch, worktree, age, and first Goal line. |
| `discard [name\|N] [--reason …]` | User says a checkpoint is no longer relevant; mark superseded without resuming. |
| `cleanup [--older-than Nd] [--apply]` | Periodic tidy, lane-aware: the newest checkpoint in each lane is never marked stale, even past the threshold. Dry-run first; only pass `--apply` after user confirms. |

## Save flow

The CLI expects a markdown body with the canonical sections (Goal / Status / In flight / Next / Open questions / References). When invoked without `--body` or stdin, it prints a template and exits 2 — fill the template, then either:

1. Pipe it back: `printf '%s' "$BODY" | pacekeeper-checkpoint save --trigger user_invoked`
2. Write to a temp file and pass `--body-file <tmpfile>`

In a Claude Code session, you (Claude) compose the body from the current conversation: the explicit goal the user gave you, the steps already done, the exact in-flight step, the next concrete step, anything blocked on user input, plus relevant plan/PR/file references. Then invoke the CLI with `--body-file` so YAML-unfriendly content (colons, hashes) is safe.

**Always pass `--transcript-path $CLAUDE_TRANSCRIPT_PATH`** (and `--session-id $CLAUDE_SESSION_ID`) when available: frontmatter captures live meter readings, and the CLI uses the transcript to anchor the checkpoint to the project root. <!-- Anchoring: transcript cwd → --cwd → git root → process cwd; refuses transient dirs so the file lands where git can track it. -->

> **Anchoring is internal mechanics — never mention `/tmp`, root resolution, or anchoring to the user. Just save and report the saved checkpoint path.**

The body temp file's location does **not** affect where the checkpoint is written. If `save` can only resolve a transient dir it refuses and exits non-zero; re-invoke with `--cwd <project-root>`.

## Resume flow

**Always resume via the CLI — never by reading the `.md` file yourself.** `pacekeeper-checkpoint resume` prints the body of the target active checkpoint **and archives it** (status `resumed`, moved to `archive/`, with `resumed_at` and — if `--session-id` was passed — `resumed_by_session` recorded). Reading the file directly gives you the same text but skips the archival, so the checkpoint stays `active` and gets re-surfaced on the next SessionStart as if it were never picked up. If the SessionStart banner shows an active checkpoint, run `resume` to orient — do not Read the path it prints. After running it, you have full orientation — proceed from "Next" unless the user redirects.

If a single lane is active, bare `resume` picks it. If multiple lanes are active, bare `resume` lists them and asks the user to pick — nothing is archived until you re-run `resume <name>` or `resume N` with a specific lane. Use `peek <name|N>` first if you just want to preview a lane without committing to resuming it.

**Worktree provenance:** run `resume <name> --worktree` when the user wants to switch into the checkpoint's original working tree. It prints the checkpoint's recorded `worktree` path if that directory still exists; otherwise it creates a fresh worktree for the checkpoint's `git_branch` (under `.worktrees/<branch>` at the repo root) and prints that path, or explains why it couldn't (e.g. the branch is checked out elsewhere already). Re-enter the printed path with `EnterWorktree`. Do this silently; don't narrate the worktree mechanics to the user.

## Cleanup safety

`cleanup` defaults to dry-run. **Always show the user the dry-run output and get confirmation before re-running with `--apply`.** The `--apply` flag will:

- Move live files with `status: active` older than `stale_after_days` (config default 14) into `archive/` with `status: stale`
- **Permanently delete** archive files older than `archive_keep_days` (config default 90)

Files in the project's working tree — if the user committed any to git, those are recoverable; uncommitted ones aren't. Surface this before applying.

## File locations

When the project is a git repo, checkpoints live at the repo root.

| Path | Purpose |
|---|---|
| `<project-root>/.claude-checkpoints/*.md` | Live (active or stranded-orphan) checkpoints |
| `<project-root>/.claude-checkpoints/archive/*.md` | Resumed / superseded / stale checkpoints |
| `~/.config/cc-pacekeeper/config.json` | Thresholds, debounce, checkpoint cleanup ages |

## Tip

Suggest adding `.claude-checkpoints/` to the project's `.gitignore` unless the user explicitly wants checkpoints committed.
