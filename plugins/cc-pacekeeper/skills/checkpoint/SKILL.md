---
name: checkpoint
description: Save, resume, list, or clean up cc-pacekeeper checkpoint files. Use when limits are nearing, before context compaction, to preserve in-flight work for resumption in a fresh session, or to orient a new session from a previously saved checkpoint. Checkpoints live in <cwd>/.claude-checkpoints/ and the user controls commit/ignore/delete via git.
---

# /cc-pacekeeper:checkpoint

Persistent resumable handoff files for cc-pacekeeper. All operations run via the shim `pacekeeper-checkpoint` (added to PATH while the plugin is enabled).

## Verbs

| Verb | When to use |
|---|---|
| `save` | User wants to preserve current state. Limits nearing critical. Before `PreCompact`. End of a working session. |
| `resume [N]` | New session in a project that has active checkpoints. Pick the newest unless the user specifies otherwise. |
| `list [--archived]` | User asks "what checkpoints do I have here?" or wants to choose a non-default to resume. |
| `discard [N] [--reason …]` | User says a checkpoint is no longer relevant; mark superseded without resuming. |
| `cleanup [--older-than Nd] [--apply]` | Periodic tidy. Dry-run first; only pass `--apply` after user confirms. |

## Save flow

The CLI expects a markdown body with the canonical sections (Goal / Status / In flight / Next / Open questions / References). When invoked without `--body` or stdin, it prints a template and exits 2 — fill the template, then either:

1. Pipe it back: `printf '%s' "$BODY" | pacekeeper-checkpoint save --trigger user_invoked`
2. Write to a temp file and pass `--body-file /tmp/checkpoint-body.md`

In a Claude Code session, you (Claude) compose the body from the current conversation: the explicit goal the user gave you, the steps already done, the exact in-flight step, the next concrete step, anything blocked on user input, plus relevant plan/PR/file references. Then invoke the CLI with `--body-file` so YAML-unfriendly content (colons, hashes) is safe.

You should also pass `--session-id $CLAUDE_SESSION_ID --transcript-path $CLAUDE_TRANSCRIPT_PATH` when available so frontmatter captures live meter readings (context %, 5h %, weekly %).

## Resume flow

`pacekeeper-checkpoint resume` prints the body of the newest active checkpoint and **archives it** (status `resumed`, moved to `archive/`). After running it, you have full orientation — proceed from "Next" unless the user redirects.

If multiple actives exist and the user wants an older one, run `list` first, then `resume N` with the index from the list.

## Cleanup safety

`cleanup` defaults to dry-run. **Always show the user the dry-run output and get confirmation before re-running with `--apply`.** The `--apply` flag will:

- Move live files with `status: active` older than `stale_after_days` (config default 14) into `archive/` with `status: stale`
- **Permanently delete** archive files older than `archive_keep_days` (config default 90)

Files in the project's working tree — if the user committed any to git, those are recoverable; uncommitted ones aren't. Surface this before applying.

## File locations

| Path | Purpose |
|---|---|
| `<cwd>/.claude-checkpoints/*.md` | Live (active or stranded-orphan) checkpoints |
| `<cwd>/.claude-checkpoints/archive/*.md` | Resumed / superseded / stale checkpoints |
| `~/.config/cc-pacekeeper/config.json` | Thresholds, debounce, checkpoint cleanup ages |

## Tip

Suggest adding `.claude-checkpoints/` to the project's `.gitignore` unless the user explicitly wants checkpoints committed.
