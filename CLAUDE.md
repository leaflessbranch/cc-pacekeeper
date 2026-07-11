# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code **plugin marketplace** repo. The root holds `.claude-plugin/marketplace.json`; all code lives in the single plugin at `plugins/cc-pacekeeper/`. The plugin injects usage-limit data (context %, 5-hour block %, weekly limits) into Claude's context via hooks so Claude self-paces, warns at thresholds, and writes resumable checkpoints before hitting walls.

Runtime is **Bun** (no build step — the bash shims in `bin/` `exec bun run` the TypeScript directly). TypeScript is strict, `noEmit`, checked only.

## Commands

All commands run from `plugins/cc-pacekeeper/`:

```
bun install          # required once per clone (tests fail with "Cannot find package 'zod'" otherwise)
bun test             # full suite (bun:test, colocated in src/__tests__/)
bun test src/__tests__/state.test.ts        # single file
bun test -t 'escalate'                      # filter by test name
bun run typecheck    # tsc --noEmit
bun run src/checkpoint-cli.ts doctor [--network] [--transcript <path>]  # env preflight: creds, caches, config, version skew, crash breadcrumbs
```

The suite must be fully green on both macOS and Linux — CI (`.github/workflows/ci.yml`) enforces it. There are no "known failures"; treat any failure as real. Historical note: six macOS failures were once tolerated as environment-sensitive — they turned out to be three genuine production bugs (`setsid` missing, `/proc` liveness, `/tmp` symlink evasion), all fixed. Don't re-normalize a red suite.

## Architecture

### Hook pipeline

`hooks/hooks.json` wires Claude Code hook events to bash shims in `bin/`, each of which execs a `src/*.ts` entrypoint. Hooks read the event JSON from stdin and reply by printing JSON to stdout (`hookSpecificOutput.additionalContext` to inject text, `{}` to stay silent) — see `src/hook-io.ts`.

- **`pacekeeper-tick` → `src/tick.ts`** — the orchestrator (~700 lines), fired on SessionStart, UserPromptSubmit, PreToolUse, Stop, SubagentStart/Stop. Computes a meter `Snapshot` (`thresholds.ts`), formats the `[pacekeeper]` status line and any threshold directives, and decides whether to inject.
- **`pacekeeper-refresh` → `src/refresh.ts`** — PostToolUse. The shim captures stdin to a temp file and spawns the refresh **detached** so the hook returns in milliseconds; the child refreshes the usage cache (self-gated on staleness) and the per-model `max_input_tokens` cache.
- **`pacekeeper-approve` → `src/approve.ts`** — PreToolUse on `CronCreate|CronDelete`. Auto-approves only the plugin's own keepalive/wake cron calls (matched by markers); everything else falls through to normal permissions.
- **`pacekeeper-precompact` → `src/precompact.ts`** — PreCompact nudge to checkpoint.
- **`pacekeeper-checkpoint` → `src/checkpoint-cli.ts`** and **`pacekeeper-worktrees` → `src/worktrees.ts`** — CLIs invoked by the skills, not by hooks.

### Data flow and state locations

- **Usage data** comes from vendored ccstatusline code (`src/vendor/`), cached in `~/.cache/cc-pacekeeper/`. Context % is computed from the transcript JSONL (`ctx-tokens.ts`), scaled to the model's usable window (`model-info.ts` cache, ccstatusline's usable ratio).
- **Config** is `~/.config/cc-pacekeeper/config.json`, zod-validated with bootstrapped defaults (`config.ts`). Thresholds, debounce, keepalive, bridge, and the `auto` (autonomous renewal) block all live here.
- **Injection debounce** (`state.ts`) and **per-session timeline** (`session-state.ts`) live in `~/.cache/cc-pacekeeper/`. Everything is keyed by `stateKey(sessionId, agentId)` — `sid` for the main thread, `sid:agentId` for subagents — so subagent ticks don't share (and starve on) the main thread's debounce entries. `agentId === undefined` is how tick.ts distinguishes main-thread-only behavior (AFK, keepalive, arbitrage, auto-loop) from subagent ticks.
- **Checkpoints** are written to the project's `.claude-checkpoints/` (never `/tmp` — `resolve-root.ts` resolves the root via `--cwd` flag → transcript cwd → git toplevel → `process.cwd()`, refusing transient/broad dirs). Markdown files with YAML frontmatter, organized in named **lanes** (default: sanitized git branch); saving supersedes only the same lane. `resume` archives the file to `archive/` — the files themselves are the registry, there is no separate index.
- **Subagent handoffs** (`agent-budget.ts`) follow the same files-are-the-registry pattern in `.claude-checkpoints/handoffs/`. Spawned agents get a budget contract with a pause threshold; on hitting it they write a handoff and return `PAUSED-BUDGET <agent_id>`. Contracts embed the **absolute** CLI path (`checkpointCliPath()`) because the PATH shim isn't visible inside subagent Bash.

### Marker strings

Behavior is coordinated through markers: `[pacekeeper]` (status lines), the keepalive marker (`keepalive.ts`), and `[pacekeeper-resume]` (`agent-budget.ts`, the auto-wake prompt after a 5h block reset). Prompt-classification gates match markers only at the START of a prompt (`tick.ts` `promptStartsWithMarker`) — text merely *quoting* a marker must pass through; an `.includes()` check once suppressed real user messages that quoted the marker. Transcript *scans* stay permissive by design. `approve.ts` auto-approves cron calls only on full-payload template validation, never marker presence. Changing a marker or its anchoring breaks these seams — grep all usages first.

### Diagnostics and platform

- **`doctor`** (`src/doctor.ts`, CLI verb) — ✓/⚠/✗ environment checks; grows a check whenever a new silent-failure mode is found. Hook entrypoints record crashes to `~/.cache/cc-pacekeeper/crash-log.json` via `src/crash-log.ts` — hooks swallow errors by design, so that file is the only trace a crash leaves.
- **`src/model-family.ts`** — the one table to extend when Anthropic ships a new model family.
- **Keepalive is need-based** (`keepalive.require_pending`, default true): the idle cache-warming cron is scheduled only while an active checkpoint lane or paused handoff exists.
- macOS and Linux are both supported (credentials come from `~/.claude/.credentials.json` or the macOS Keychain; `getUsageToken` is memoized per hook process). Native Windows is not.

### Vendored code

`src/vendor/` is derived from ccstatusline, pinned to an upstream SHA documented in `src/vendor/VENDOR.md` along with the exact local modifications. Don't refactor these files; when syncing upstream, update the SHA and re-diff.

### Skills

`skills/checkpoint/SKILL.md` and `skills/worktree/SKILL.md` are the model-facing docs for the two CLIs. If you change CLI verbs, flags, or semantics in `checkpoint-cli.ts` / `worktrees.ts`, update the corresponding SKILL.md (and README) in the same change — the skill text is what future Claude sessions actually follow.

## Releasing

Version lives in **both** `plugins/cc-pacekeeper/.claude-plugin/plugin.json` and `plugins/cc-pacekeeper/package.json`; keep them in sync, update `CHANGELOG.md`, and mirror the `vX.Y.Z: summary` commit-message style used in history.
