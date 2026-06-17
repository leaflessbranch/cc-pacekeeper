# cc-pacekeeper — Design Spec

**Date:** 2026-06-17
**Status:** Draft for review
**Author:** leaflessbranch (+ Claude)

## 1. Problem

The user pays for a Claude Code subscription and monitors three usage meters manually via [ccstatusline](https://github.com/sirmalloc/ccstatusline):

- **Context window %** of the current conversation
- **5-hour session block %** (rolling Anthropic window)
- **Weekly limits** (all-models, Sonnet, Opus)

When Claude takes on long tool-heavy tasks, tool-call output sizes are unpredictable, so the user can't reliably estimate when limits will be hit. The visible numbers exist; Claude can't see them. The user wants to hand the monitoring job *to Claude*, so Claude itself can pace, warn, and propose a checkpoint before a wall is hit — across every project, not just one.

## 2. Goals & non-goals

**Goals**

1. Inject the three meters into Claude's context at the right lifecycle points (silent below thresholds, terse at notify, directive at warn/critical).
2. Make Claude **propose** a checkpoint when limits approach — never force-stop. Subscription users have extra-usage credits and may want to continue.
3. Provide a `/checkpoint save | resume | list` skill that writes structured handoff files into the project's working tree, where the user controls commit/ignore.
4. Ship as a single installable plugin via a personal marketplace at `github.com/leaflessbranch/cc-pacekeeper`.
5. Work globally — once enabled, all projects benefit; no per-project setup.

**Non-goals**

- Replacing ccstatusline (the human-readable statusline is complementary; the user keeps it).
- Hard-blocking Claude when limits are near. Always advisory.
- Tracking API-key users (the OAuth `/api/oauth/usage` endpoint is subscription-only).
- Compaction recovery — `PreCompact` triggers a checkpoint prompt, but we don't try to prevent compaction.

## 3. Key facts that shape the design

| Fact | Source | Implication |
|---|---|---|
| `rate_limits` is in `statusLine` stdin only — **not** in `PreToolUse`/`PostToolUse` stdin. The 5h/weekly numbers in statusLine come from a separate OAuth call to `https://api.anthropic.com/api/oauth/usage`. | [Statusline gotchas gist](https://gist.github.com/jtbr/4f99671d1cee06b44106456958caba8b), ccstatusline source `src/utils/usage-fetch.ts` | Plugin must fetch usage itself via cached OAuth call. Cannot rely on hook stdin for the 5h/weekly meters. |
| Claude Code on a **subscription** auto-requests the **1-hour prompt cache TTL** for the main conversation. Subagents use 5-min TTL. Direct API users get 5-min by default since March 2026. | [Anthropic prompt caching docs](https://code.claude.com/docs/en/prompt-caching), [mindstudio writeup](https://www.mindstudio.ai/blog/prompt-caching-claude-code-token-savings) | Same-session resume within 1 hour is feasible. After 1 hour, checkpoint-based resume in a fresh session is needed. |
| **5-hour block doubled May 6, 2026; weekly caps exist per-model and across-model on Max plans.** Hitting weekly locks even if 5h has room. | [Morph 2026 limits writeup](https://www.morphllm.com/claude-code-usage-limits) | All three meters matter independently; warn on whichever crosses first. |
| **Plugin `hooks/hooks.json`** uses the same schema as `~/.claude/settings.json` hooks and applies globally when the plugin is enabled. `${CLAUDE_PLUGIN_ROOT}` resolves to the installed plugin dir. | [Plugins docs](https://code.claude.com/docs/en/plugins) | Hooks registered in the plugin work across all projects automatically — no global settings.json mutation needed. |
| `additionalContext` from `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart` hooks **does** reach Claude as a system reminder. Stderr on exit 0 does **not**. | [Hooks reference](https://code.claude.com/docs/en/hooks) | Use `additionalContext` exclusively. cc-usage-monitor uses Stop hook stderr — that's invisible to Claude; we improve on that. |
| Plugins added to a marketplace can be installed via `/plugin marketplace add <owner>/<repo>` shorthand. One repo can be both the marketplace and host the plugin. | [Plugin marketplaces docs](https://code.claude.com/docs/en/plugin-marketplaces) | Single-repo distribution. |
| ccstatusline (10.9k★, MIT) already implements the OAuth fetch with 3-tier caching, rate-limit lock, token fingerprinting, stale-cache fallback. | Source: `src/utils/usage-fetch.ts` | Vendor the modules verbatim with copyright headers preserved. |

## 4. Architecture

### 4.1 Repo layout

```
cc-pacekeeper/                              # github.com/leaflessbranch/cc-pacekeeper
├── README.md
├── LICENSE                                 # MIT, mentions ccstatusline derivation
├── .gitignore
├── .claude-plugin/
│   └── marketplace.json                    # Marketplace catalog
├── docs/
│   └── design.md                           # This file
└── plugins/
    └── cc-pacekeeper/
        ├── .claude-plugin/
        │   └── plugin.json                 # name, version, description, author, repository
        ├── hooks/
        │   └── hooks.json                  # 6 hook events registered
        ├── skills/
        │   └── checkpoint/
        │       └── SKILL.md                # /cc-pacekeeper:checkpoint  save|resume|list
        ├── bin/
        │   ├── pacekeeper-tick             # sh shim → bun run src/tick.ts
        │   ├── pacekeeper-refresh          # sh shim → bun run src/refresh.ts
        │   ├── pacekeeper-precompact       # sh shim → bun run src/precompact.ts
        │   └── pacekeeper-checkpoint       # sh shim → bun run src/checkpoint-cli.ts
        │                                   # (invoked by SKILL.md for save/resume/list/
        │                                   #  cleanup/discard verbs)
        ├── src/
        │   ├── tick.ts                     # Main hook entrypoint: read stdin,
        │   │                               # compute snapshot, emit additionalContext
        │   ├── refresh.ts                  # OAuth refresh; same script invoked both
        │   │                               # synchronously by /checkpoint and detached
        │   │                               # by the PostToolUse shim (see §4.3, §4.8)
        │   ├── precompact.ts               # PreCompact handler: force checkpoint nudge
        │   ├── ctx-tokens.ts               # Parse transcript JSONL → context %
        │   ├── thresholds.ts               # Threshold logic, debouncing, snapshot format
        │   ├── checkpoint.ts               # Write/read/archive <cwd>/.claude-checkpoints/
        │   ├── checkpoint-cli.ts            # Verb dispatcher (save|resume|list|cleanup|discard)
        │   ├── config.ts                   # Load ~/.config/cc-pacekeeper/config.json
        │   ├── state.ts                    # Cross-call debounce state in ~/.cache/cc-pacekeeper/
        │   └── vendor/                     # MIT-licensed ccstatusline modules
        │       ├── usage-fetch.ts          # Preserve original copyright header
        │       ├── usage-types.ts
        │       └── (any deps from those)
        ├── package.json                    # Bun deps: zod, https-proxy-agent
        ├── tsconfig.json
        └── settings.json                   # (empty/reserved for now)
```

### 4.2 Runtime model

Each hook event invokes a shell shim under `bin/`. `hooks.json` references the shims via `${CLAUDE_PLUGIN_ROOT}/bin/pacekeeper-tick` (etc.) — `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code to the installed plugin directory, so paths resolve regardless of how the plugin was installed. The shim execs `bun run` on the matching `.ts` file. Hook stdin (JSON) is forwarded; the script writes a JSON response on stdout with `hookSpecificOutput.additionalContext` (when injection is warranted) or empty `{}` (when silent).

Three on-disk locations:

- `~/.cache/cc-pacekeeper/usage.json` — usage data (ccstatusline-compatible schema; we can even symlink to `~/.cache/ccstatusline/usage.json` if user already runs ccstatusline, sharing the rate-limit budget)
- `~/.cache/cc-pacekeeper/usage.lock` — rate-limit guard (≥30s between API calls; honors 429 Retry-After)
- `~/.cache/cc-pacekeeper/debounce.json` — per-session, per-meter last-injected level + timestamp, to avoid spamming the same warning every tool call

Plus:

- `~/.config/cc-pacekeeper/config.json` — user-editable thresholds, debounce seconds, project denylist
- `<cwd>/.claude-checkpoints/<ISO-timestamp>.md` — checkpoint files in the project working tree (per user direction)

### 4.3 Hook registration

`plugins/cc-pacekeeper/hooks/hooks.json`:

| Event | Matcher | Script | Purpose |
|---|---|---|---|
| `SessionStart` | — | `pacekeeper-tick` | Fires on **every** `source` (`startup`, `resume`, `clear`, `compact`). If `<cwd>/.claude-checkpoints/` contains one or more files with `status: active` frontmatter, inject: (a) the newest one's summary + path, (b) a count of additional live checkpoints if any, (c) a nudge to use `/cc-pacekeeper:checkpoint resume` if Claude/user want to continue from it. If no active checkpoints, **silent** — no question, no intent confirmation. Also primes the usage cache. |
| `UserPromptSubmit` | — | `pacekeeper-tick` | Inject current snapshot only if any meter ≥ notify threshold. Cheap — meters read from cache, never blocks waiting for API. |
| `PreToolUse` | `*` | `pacekeeper-tick` | Inject directive ONLY at threshold transitions (debounced). Fast cache read; never triggers API call. |
| `PostToolUse` | `*` | `pacekeeper-refresh` | Shim spawns the refresh detached (`setsid bun run … &`) and exits with `{}` in <5ms. Refresh runs in the background, updates cache when done. Stale check (>180s) lives inside the refresh script itself, so the shim has zero logic. |
| `PreCompact` | — | `pacekeeper-precompact` | Always inject: "Context compaction imminent — call `/cc-pacekeeper:checkpoint save` now to preserve state." |
| `Stop` | — | `pacekeeper-tick` | If any meter crossed warn/critical *during this turn* (debounce state shows a level-up since the last `Stop`), inject a soft reminder to discuss checkpointing. Otherwise silent. **Never `continue: false`.** |

### 4.4 Tick script — decision tree

`tick.ts` reads stdin, then:

1. Identify event from `hook_event_name`.
2. Load cached usage + transcript token count (compute from `transcript_path`).
3. For each meter, compute level: `none | notify | warn | critical`.
4. Check debounce state: have we already injected at this level for this `(session_id, meter)` within the debounce window (default 60s)? If yes → silent.
5. Compose `additionalContext` based on the *highest* level across all meters:
   - `none` → emit `{}`
   - `notify` → 1-line status: `[pacekeeper] ctx 64% · 5h 72% · week 41% · reset 1h12m`
   - `warn` → status line + directive: `⚠ Approaching limits. Finish current step cleanly, then ask the user about saving a checkpoint via /cc-pacekeeper:checkpoint save.`
   - `critical` → status line + extra-usage state + directive: `🛑 At critical threshold (week 96%). Extra-usage credits: 12% of $X used. Stop and ask the user whether to (a) continue with extra usage, (b) save checkpoint and resume after reset (in 1h12m), or (c) keep going if confident the current step is small.`
6. Update debounce state.
7. Emit JSON.

### 4.5 Meter computation

| Meter | Source | Compute |
|---|---|---|
| Context window % | Parse `transcript_path` JSONL: sum `usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens` for the latest assistant message; divide by model context window (200k for Opus 4.x / Sonnet 4.x; configurable) | Cached per-`session_id` for 5s |
| 5h session % | `usage.json` → `five_hour.utilization` | Cache TTL 180s; refresh async on `PostToolUse` |
| Weekly % | `usage.json` → `seven_day.utilization`, `seven_day_sonnet.utilization`, `seven_day_opus.utilization` | Same |
| Extra usage | `usage.json` → `extra_usage.{is_enabled, monthly_limit, used_credits, utilization, currency}` | Same |

### 4.6 Thresholds (defaults, configurable in `config.json`)

| Meter | notify | warn | critical |
|---|---|---|---|
| Context window | 60% | 75% | 90% |
| 5h block | 70% | 85% | 95% |
| Weekly (any of 3) | 50% | 70% | 85% |

Rationale: weekly thresholds sit lower than 5h because weekly resets are slow (days). Context window thresholds sit lower than 5h because once compaction triggers, fidelity drops.

### 4.7 Debouncing

Per `(session_id, meter)`, track:

```json
{ "lastLevel": "warn", "lastInjectedAt": 1718656234 }
```

Re-inject only when level *increases* (notify → warn, warn → critical) OR when the same level persists and `now - lastInjectedAt > debounce_seconds` (default 60s). This keeps PreToolUse injections from spamming the context every tool call while still nudging if the user ignores the first warning.

### 4.8 OAuth fetch — vendored from ccstatusline

`src/vendor/usage-fetch.ts` is a near-verbatim copy of [ccstatusline's `usage-fetch.ts`](https://github.com/sirmalloc/ccstatusline/blob/main/src/utils/usage-fetch.ts) with original MIT copyright header preserved. Behaviors retained:

- Reads OAuth token from `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (Linux path; macOS keychain branch can be left in for portability, costs nothing)
- POSTs to `https://api.anthropic.com/api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20`
- **3-tier cache:** in-process → file (180s TTL) → API
- **Rate-limit lock** at `~/.cache/cc-pacekeeper/usage.lock`: ≥30s minimum between API attempts; honors HTTP 429 `Retry-After`; defaults to 300s backoff if no header
- **Token fingerprint** (truncated SHA-256) persisted alongside cache so account switch invalidates cache instantly
- **Stale-cache fallback** on any error (auth, network, parse) — keep serving last good data, never break Claude's workflow

### 4.9 Checkpoint format

`<cwd>/.claude-checkpoints/<ISO-timestamp>.md`:

```markdown
---
status: active                   # active | resumed | superseded | stale
created_at: 2026-06-17T15:42:11Z
session_id: 01jcwq...
trigger: user_invoked            # or: precompact | critical_threshold
meters:
  context_pct: 78
  five_hour_pct: 91
  weekly_all_pct: 68
  weekly_sonnet_pct: 71
  weekly_opus_pct: 12
  five_hour_resets_at: 2026-06-17T18:15:00Z
project_root: /home/eddie/Projects/foo
git_branch: feature/bar
git_head: db66d6f
files_touched:
  - src/main.ts
  - tests/main.test.ts
---

## Goal
What this session is trying to accomplish.

## Status
Where we are in the plan.

## In flight
The exact step interrupted, with enough detail for fresh-session resume.

## Next
The next concrete step.

## Open questions
Anything blocked on user input.

## References
- Plan: ~/.claude/plans/2026-06-17-foo.md
- Related PR: #42
```

The directory is **inside the project working tree**, so the user decides per-project whether to `.gitignore` it, commit checkpoints, or `rm -rf` after success. README will suggest adding `.claude-checkpoints/` to `.gitignore` as the common case.

### 4.9.1 Checkpoint lifecycle & cleanup

Checkpoint files have a `status` field in frontmatter that drives a soft-delete archive convention. The filesystem layout:

```
<cwd>/.claude-checkpoints/
├── 2026-06-17T15-42-11Z.md      # status: active (live)
├── 2026-06-17T18-03-09Z.md      # status: active (live, newer)
└── archive/
    ├── 2026-06-16T09-11-22Z.md  # status: resumed
    └── 2026-06-15T14-30-00Z.md  # status: superseded
```

**Status values:**

| Status | Set when | File location |
|---|---|---|
| `active` | `checkpoint save` writes it | top of `.claude-checkpoints/` |
| `resumed` | user accepts `checkpoint resume` and Claude orients from it | atomically moved to `archive/` |
| `superseded` | a new `active` checkpoint is written in same `cwd`; older actives are demoted | atomically moved to `archive/` |
| `stale` | `checkpoint cleanup` marks files older than `stale_after_days` (default 14) and the user confirms | atomically moved to `archive/` |

**Skill verbs (extends `/cc-pacekeeper:checkpoint`):**

- `save` — write a new `active` checkpoint; demote previous actives to `superseded`.
- `resume [N]` — read the newest active (or Nth from `list`), present to Claude as orientation; on confirmation, move to `archive/` with `status: resumed`.
- `list` — show live actives in `.claude-checkpoints/` with mtimes, ages, brief goal line.
- `list --archived` — show files under `archive/`.
- `cleanup [--older-than 7d] [--apply]` — list candidates (active files older than threshold, plus any orphaned archive files older than `archive_keep_days`, default 90). Without `--apply`, dry-run only. With `--apply`, archive (for live) or delete (for archive older than `archive_keep_days`).
- `discard [N]` — explicit drop of a live checkpoint without resuming; moves to `archive/` with `status: superseded` and a `discard_reason` field.

**Why frontmatter + archive (not a ledger):**

- The filesystem is the source of truth — `git status` shows orphan checkpoints, `rm` and `mv` work naturally.
- Frontmatter explains *why* a file is in `archive/` (resumed vs. superseded vs. stale vs. discarded) for human review.
- No external state file to drift out of sync if the user moves directories, renames the project, or wipes the dir.
- Git stays the user's hard backstop: anyone who wants permanent record commits the file before resume.

**SessionStart surfacing logic:**

1. List `*.md` directly under `<cwd>/.claude-checkpoints/` (not recursive — `archive/` is excluded).
2. Filter to `status: active`.
3. If zero → silent.
4. If one → inject 1-paragraph summary of the file + path + offer `checkpoint resume`.
5. If two or more → inject summary of newest + `"N other active checkpoints exist in <cwd>/.claude-checkpoints/ — run /cc-pacekeeper:checkpoint list to review or /cc-pacekeeper:checkpoint cleanup to tidy."`

**Atomic move:** `archive/` writes use `fs.renameSync` (same filesystem, atomic). The directory is created on first archive event. Conflict on filename collision (same ISO timestamp): append `-1`, `-2`, etc.

### 4.10 Configuration

### 4.10 Configuration

`~/.config/cc-pacekeeper/config.json` (created with defaults on first run):

```json
{
  "thresholds": {
    "context":      { "notify": 60, "warn": 75, "critical": 90 },
    "five_hour":    { "notify": 70, "warn": 85, "critical": 95 },
    "weekly":       { "notify": 50, "warn": 70, "critical": 85 }
  },
  "debounce_seconds": 60,
  "cache_ttl_seconds": 180,
  "context_window_size": 200000,
  "project_denylist": [],
  "checkpoint_dir_name": ".claude-checkpoints",
  "checkpoint": {
    "stale_after_days": 14,
    "archive_keep_days": 90
  },
  "share_ccstatusline_cache": false
}
```

`project_denylist` matches against `cwd` prefix; useful to disable on scratchpad projects. `share_ccstatusline_cache: true` symlinks `~/.cache/cc-pacekeeper/usage.json` → `~/.cache/ccstatusline/usage.json` so both tools share one rate-limit budget.

## 5. Marketplace + plugin manifests

### 5.1 `.claude-plugin/marketplace.json`

```json
{
  "name": "cc-pacekeeper",
  "owner": {
    "name": "leaflessbranch",
    "url": "https://github.com/leaflessbranch"
  },
  "plugins": [
    {
      "name": "cc-pacekeeper",
      "source": "./plugins/cc-pacekeeper",
      "description": "Hands usage-limit monitoring to Claude itself — context %, 5h block %, weekly limits — with self-pacing, threshold warnings, and resumable checkpoints."
    }
  ]
}
```

### 5.2 `plugins/cc-pacekeeper/.claude-plugin/plugin.json`

```json
{
  "name": "cc-pacekeeper",
  "version": "0.1.0",
  "description": "Self-pacing usage monitor for Claude Code: injects context %, 5h block %, and weekly limit data into Claude's context via hooks, so Claude warns and offers checkpoints before walls.",
  "author": {
    "name": "leaflessbranch",
    "url": "https://github.com/leaflessbranch"
  },
  "repository": "https://github.com/leaflessbranch/cc-pacekeeper",
  "license": "MIT",
  "homepage": "https://github.com/leaflessbranch/cc-pacekeeper"
}
```

Explicit `version` so users only get updates on bumps — not every commit.

## 6. Install flow (end-user view)

> **Development status:** repo is **private** during development. While private, only authors with GitHub read access can `/plugin marketplace add` it (Claude Code uses the host's git auth — SSH key or `gh auth`). Repo will be flipped public at v1.0 release; the install commands below are unchanged either way.

```
# One-time
/plugin marketplace add leaflessbranch/cc-pacekeeper
/plugin install cc-pacekeeper@cc-pacekeeper

# Requires Bun (~30ms cold start, matters for PreToolUse)
curl -fsSL https://bun.sh/install | bash    # if not already
```

On first hook fire, the script bootstraps `~/.config/cc-pacekeeper/config.json` and `~/.cache/cc-pacekeeper/`, then runs normally. No additional setup.

## 7. Testing strategy

- **Unit tests** (Bun's built-in test runner):
  - `thresholds.test.ts` — level computation, debouncing, transition detection
  - `checkpoint.test.ts` — write/read/list round-trip; YAML frontmatter parse
  - `ctx-tokens.test.ts` — transcript JSONL parsing edge cases (empty, partial, multi-turn)
  - `config.test.ts` — defaults, override, validation
- **Integration tests** with mocked OAuth (record/replay HTTP):
  - First fetch: cache populated
  - Within TTL: file cache hit
  - Stale cache + API down: serve stale
  - 429 response: respect Retry-After
- **Manual smoke test**: install via `claude --plugin-dir ./plugins/cc-pacekeeper`, verify hooks fire on real tool calls, verify `additionalContext` lands in transcript.

Vendored ccstatusline modules: keep ccstatusline's own tests where they apply, drop macOS-keychain-only ones.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Anthropic changes `/api/oauth/usage` schema | Stale-cache fallback never breaks Claude; user sees "[pacekeeper] usage data unavailable" notify-tier message |
| Hook script slow → tool latency | Bun cold start ~30ms; tick reads cache only (no API). Refresh runs on `PostToolUse` async. Budget: <50ms p95 |
| `additionalContext` cost across many tool calls | Debounce 60s + transition-only injection. Silent at <notify. Worst case ~30KB/hour |
| User on plain Node, no Bun | README install one-liner. Alternative: `bun build --compile` to ship a single binary in future release if friction shows up |
| Subagents use 5-min cache TTL | Documented in README; checkpoint mechanism is the answer for cross-session resume regardless |
| Plugin namespace collision with future official `pacekeeper` | Name is sufficiently specific; if Anthropic ships an official one, we rename |
| ccstatusline changes break our vendored copy | Pin vendored version in a `VENDOR.md` recording upstream commit SHA; periodic manual sync |

## 9. Out of scope (explicit non-features)

- Web dashboard / TUI for viewing meters (ccstatusline already does this; we complement)
- Auto-resuming a previous session's plan (skill returns the checkpoint; Claude reads and acts on it — no magic)
- Cost-per-token billing analytics (ccusage covers this)
- Notifying via Signal/Telegram (user has separate channels for this)
- Auto-committing checkpoint files (user controls git)

## 10. Decisions made by default (override at review)

- **`share_ccstatusline_cache` defaults to `false`.** Sharing is opt-in via config; default avoids surprising the user if ccstatusline's cache schema drifts.
- **`SessionStart` surfacing fires on every source.** If `<cwd>/.claude-checkpoints/` has active checkpoints, surface them — otherwise silent. No intent confirmation, no "do you want to resume" prompt on cold start; the user (or Claude reading the injected summary) decides whether to invoke `checkpoint resume`.
- **Checkpoint cleanup uses frontmatter status + filesystem archive.** No external ledger. `archive/` subdirectory holds resumed/superseded/stale files; `cleanup --apply` is the only destructive verb and requires the user's explicit flag.

## 11. Open question for review

1. Plugin skill namespace is `/cc-pacekeeper:checkpoint`. Acceptable, or do you want a shorter alias (ship a second skill named just `pace` that delegates)?

## 12. References

- [ccstatusline source (MIT)](https://github.com/sirmalloc/ccstatusline) — vendoring target
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Settings docs](https://code.claude.com/docs/en/settings)
- [Claude Code Plugins docs](https://code.claude.com/docs/en/plugins)
- [Plugin Marketplaces docs](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code Skills docs](https://code.claude.com/docs/en/skills)
- [Claude Code prompt caching (subscription 1h TTL)](https://code.claude.com/docs/en/prompt-caching)
- [Statusline gotchas gist (jtbr)](https://gist.github.com/jtbr/4f99671d1cee06b44106456958caba8b)
- [Claude Code 2026 rate-limit changes (Morph)](https://www.morphllm.com/claude-code-usage-limits)
- [Anthropic dropped cache TTL 1h→5m for API (Mar 2026)](https://dev.to/whoffagents/anthropic-silently-dropped-prompt-cache-ttl-from-1-hour-to-5-minutes-16ao)
