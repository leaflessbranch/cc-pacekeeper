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

Test rules: the suite must not depend on the developer's machine — isolate `HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`, `DISABLE_AUTO_COMPACT` in any test that reads them (`isolateAutoCompactEnv` in ctx-tokens.test.ts is the pattern). Fixtures that must be a "safe root" cannot live under `os.tmpdir()` (`isUnsafeRoot` refuses it) — use a git-initialised dir under `src/__tests__/.*-fixtures/`, removed in `finally`. Bun ignores `process.exitCode = undefined`; reset to `0`.

Dev install: `/plugin marketplace add <path to this checkout>` replaces the GitHub `cc-pacekeeper` marketplace and uninstalls the plugin; then `claude plugin install cc-pacekeeper@cc-pacekeeper`. Shims exec the source from the cache dir, which is a **snapshot copied at install time**, not a link to the checkout: new commits do NOT reach the running hooks, and `claude plugin update` reports "already latest" while the version string is unchanged. To refresh, `claude plugin uninstall cc-pacekeeper && claude plugin install cc-pacekeeper@cc-pacekeeper` (observed live: a wake tick ran week-old code and missed a checkpoint the fix in the checkout would have found). Re-add `leaflessbranch/cc-pacekeeper` afterwards.

`docs/superpowers/` and `.superpowers/` are working files — never commit them.

The suite must be fully green on both macOS and Linux — CI (`.github/workflows/ci.yml`) enforces it. There are no "known failures"; treat any failure as real. Historical note: six macOS failures were once tolerated as environment-sensitive — they turned out to be three genuine production bugs (`setsid` missing, `/proc` liveness, `/tmp` symlink evasion), all fixed. Don't re-normalize a red suite.

## Architecture

### Hook pipeline

`hooks/hooks.json` wires Claude Code hook events to bash shims in `bin/`, each of which execs a `src/*.ts` entrypoint. Hooks read the event JSON from stdin and reply by printing JSON to stdout (`hookSpecificOutput.additionalContext` to inject text, `{}` to stay silent) — see `src/hook-io.ts`.

- **`pacekeeper-tick` → `src/tick.ts`** — the orchestrator (~700 lines), fired on SessionStart, UserPromptSubmit, PreToolUse, Stop, SubagentStart/Stop. Computes a meter `Snapshot` (`thresholds.ts`), formats the `[pacekeeper]` status line and any threshold directives, and decides whether to inject.
- **`pacekeeper-refresh` → `src/refresh.ts`** — PostToolUse. The shim captures stdin to a temp file and spawns the refresh **detached** so the hook returns in milliseconds; the child refreshes the usage cache (self-gated on staleness) and the per-model `max_input_tokens` cache.
- **`pacekeeper-approve` → `src/approve.ts`** — PreToolUse on `CronCreate|CronDelete`. Auto-approves only the plugin's own keepalive/wake cron calls (matched by markers); everything else falls through to normal permissions.
- **No PreCompact hook.** Claude Code's `PreCompact` cannot inject context (it discards `systemMessage`; its only power is blocking compaction) and nothing can run between it and the summary, so a "save before compaction" nudge there never reached Claude. The actionable moments are ctx critical (auto-save directive) and `SessionStart` with `source: "compact"` (`buildPostCompactContext` in tick.ts re-injects this session's checkpoint).
- **`pacekeeper-checkpoint` → `src/checkpoint-cli.ts`** and **`pacekeeper-worktrees` → `src/worktrees.ts`** — CLIs invoked by the skills, not by hooks.
- **Hook facts that gate design** (hooks reference, 2026-09): `PreCompact`/`PostCompact` cannot inject; `SessionStart` (`source`: startup/resume/clear/compact/fork) can; `Stop` carries `stop_hook_active`, `session_crons` and `background_tasks`; `additionalContext` over 10,000 chars becomes a file path plus a 2,000-char preview, so `buildPostCompactContext` budgets the whole block. Transcripts mark compaction with `{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":N}}`.
- **`pacekeeper-presence-watch` → `src/presence-watch.ts`** — not a hook. Declared in `monitors/monitors.json` as a plugin **monitor**: Claude Code starts it for the session's lifetime and delivers each stdout line to Claude as a notification. This exists because hook events fire only while a session is active, so no hook can observe the user *departing* — sampling stops the moment they leave. Monitors are an experimental plugin component and their manifest schema may change; they also cannot read `${user_config.*}`, so the script calls `loadConfig()` itself.

### Data flow and state locations

- **Usage data** comes from vendored ccstatusline code (`src/vendor/`), cached in `~/.cache/cc-pacekeeper/`. Context % is computed from the transcript JSONL (`ctx-tokens.ts`) as a fraction of Claude Code's **auto-compact window** (`autoCompactWindow()` in `ctx-tokens.ts`: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` → the `autoCompactWindow` user setting → ~967K for 1M-window models, else the full window), with the model's window itself from the `model-info.ts` cache. The vendored `USABLE_CONTEXT_RATIO` (0.8) is no longer used — it made 1M models read ~95% at a real 760K and drove premature session cycling.
- **Config** is `~/.config/cc-pacekeeper/config.json`, zod-validated with bootstrapped defaults (`config.ts`). Thresholds, debounce, keepalive, bridge, and the `auto` (autonomous renewal) block all live here.
- **Injection debounce** (`state.ts`) and **per-session timeline** (`session-state.ts`) live in `~/.cache/cc-pacekeeper/`. Everything is keyed by `stateKey(sessionId, agentId)` — `sid` for the main thread, `sid:agentId` for subagents — so subagent ticks don't share (and starve on) the main thread's debounce entries. `agentId === undefined` is how tick.ts distinguishes main-thread-only behavior (AFK, keepalive, arbitrage, auto-loop) from subagent ticks.
- **Checkpoints** are written to the project's `.claude-checkpoints/` (never `/tmp` — `resolve-root.ts` resolves the root via `--cwd` flag → transcript cwd → git toplevel → `process.cwd()`, refusing transient/broad dirs). Markdown files with YAML frontmatter, organized in named **lanes** (default: sanitized git branch); saving supersedes only the same lane. `resume` archives the file to `archive/` — the files themselves are the registry, there is no separate index. Every lookup in tick.ts goes through `lookupRoot(cwd)` (`resolve-root.ts`) so a session running in a linked worktree finds the checkpoints the CLI anchored at the main root.
- **Session id in the CLI comes from `CLAUDE_CODE_SESSION_ID`** (exported to the Bash tool; matches the hook's `session_id`). `$CLAUDE_SESSION_ID` and `$CLAUDE_TRANSCRIPT_PATH` do not exist. `save`/`resume` find the transcript by scanning `<config dir>/projects/*/<sid>.jsonl` (`transcriptPathForSession`), stamp the id only when that transcript exists (on `--continue` the Bash id can be the startup id), and `newestSince` falls back to the newest candidate when no stamp matches — the concurrent-session guard is ordering, not exclusion.
- **Goal lock** (`laneGoalAnchor`, `goalSection` in `checkpoint.ts`): `save` refuses a changed `## Goal` for the lane's newest active-or-resumed checkpoint within `stale_after_days` unless `--goal-changed`; a goal-less body is never refused and dissolves the lock. Recency is `max(created_at, resumed_at)` in both the anchor and `newestSince` — keep them identical.
- **Frontmatter is parsed by a hand-rolled `parseYaml`** in `checkpoint.ts`: an empty scalar (`session_id:`) reads as `''`, keys with indented children as objects/arrays, `true`/`false`/numbers are typed. Guard optional strings with `typeof x === 'string'`, never `=== undefined` alone, and write tests against the on-disk form real checkpoints have (blank line, not absent key).
- **Subagent handoffs** (`agent-budget.ts`) follow the same files-are-the-registry pattern in `.claude-checkpoints/handoffs/`. Spawned agents get a budget contract with a pause threshold; on hitting it they write a handoff and return `PAUSED-BUDGET <agent_id>`. Contracts embed the **absolute** CLI path (`checkpointCliPath()`) because the PATH shim isn't visible inside subagent Bash.

### Marker strings

Behavior is coordinated through markers: `[pacekeeper]` (status lines), the keepalive marker (`keepalive.ts`), and `[pacekeeper-resume]` (`agent-budget.ts`, the auto-wake prompt after a 5h block reset). Prompt-classification gates match markers only at the START of a prompt (`tick.ts` `promptStartsWithMarker`) — text merely *quoting* a marker must pass through; an `.includes()` check once suppressed real user messages that quoted the marker. Transcript *scans* stay permissive by design. `approve.ts` auto-approves cron calls only on full-payload template validation, never marker presence. Changing a marker or its anchoring breaks these seams — grep all usages first.

### Diagnostics and platform

- **`doctor`** (`src/doctor.ts`, CLI verb) — ✓/⚠/✗ environment checks; grows a check whenever a new silent-failure mode is found. Hook entrypoints record crashes to `~/.cache/cc-pacekeeper/crash-log.json` via `src/crash-log.ts` — hooks swallow errors by design, so that file is the only trace a crash leaves.
- **`src/model-family.ts`** — the one table to extend when Anthropic ships a new model family.
- **Presence** (`src/presence.ts`) fuses four Linux probes into `online`/`afk`/`unknown` via a priority ladder with one asymmetry that is load-bearing: **an unavailable probe never votes `afk`**. Degradation fails toward "assume present", because a false `afk` reroutes output away from a user who is sitting there watching. Presence also requires *attachment plus recent activity*, never mere connection existence — a live SSH socket lingers for minutes after a laptop closes, so it is the most tempting signal and the one that lies. `isAway()` is a cheap state-file read for the hot path; the monitor does the probing.
- **Channels are never named in this codebase** (`src/channels.ts`). Users configure different ones, so `channels.preferred`/`target` are opaque strings the plugin stores and hands back verbatim — Claude resolves them at send time against the tools actually loaded, which the plugin cannot see. A test asserts no channel name appears in plugin output; keep it that way.
- **Keepalive is need-based** (`keepalive.require_pending`, default true): the idle cache-warming cron is scheduled only while an active checkpoint lane or paused handoff exists.
- macOS and Linux are both supported (credentials come from `~/.claude/.credentials.json` or the macOS Keychain; `getUsageToken` is memoized per hook process). Native Windows is not.

### Vendored code

`src/vendor/` is derived from ccstatusline, pinned to an upstream SHA documented in `src/vendor/VENDOR.md` along with the exact local modifications. Don't refactor these files; when syncing upstream, update the SHA and re-diff.

### Skills

`skills/checkpoint/SKILL.md` and `skills/worktree/SKILL.md` are the model-facing docs for the two CLIs. If you change CLI verbs, flags, or semantics in `checkpoint-cli.ts` / `worktrees.ts`, update the corresponding SKILL.md (and README) in the same change — the skill text is what future Claude sessions actually follow.

## Releasing

Version lives in **both** `plugins/cc-pacekeeper/.claude-plugin/plugin.json` and `plugins/cc-pacekeeper/package.json`; keep them in sync, update `CHANGELOG.md`, and mirror the `vX.Y.Z: summary` commit-message style used in history.
