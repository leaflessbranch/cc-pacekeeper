# cc-pacekeeper

A Claude Code plugin that hands monitoring of context window, 5-hour session block, and weekly usage limits over to Claude itself — so it can pace, warn, and checkpoint work before hitting a wall.

**Status:** v0.6.1 — keepalive "ping suppressed" block reason now rotates so a ping racing active use reads as routine, not an error, plus everything from 0.6: injection-hardened cron auto-approval, need-based keepalive, three latent macOS bug fixes + CI (ubuntu + macos), and a richer doctor (crash breadcrumbs, version skew, cache-drift, `--transcript` probe). See the [changelog](CHANGELOG.md).

![cc-pacekeeper in action](docs/demo.gif)

## What it does

ccstatusline shows usage to *you*. cc-pacekeeper injects those same numbers into Claude's context via hooks, so Claude actively self-paces, surfaces threshold crossings, and offers to write a resumable checkpoint before limits force a stop.

Three meters tracked:

- **Context window %** — current conversation token usage
- **5-hour session block %** — Anthropic rolling window
- **Weekly limits** — all-models, Sonnet-only, Opus-only

Plus **extra-usage credits** state, so when limits approach Claude can ask whether to keep going on pay-as-you-go or checkpoint and resume after reset.

### New in v0.2

- **Time & AFK awareness** — every prompt carries the local wall-clock, session duration, and (after an idle gap) a "you were away" note, so Claude reasons about elapsed time and reset windows.
- **Cross-session budget awareness** — when more than one Claude session is live, the line notes how many share your account budget.
- **5-hour block-reset bridge** — when the 5h block is nearly full but resets soon, Claude is told to wait it out rather than checkpoint-and-resume.
- **Weekly model-family arbitrage** — when one family's weekly limit is stressed but the other has headroom, Claude is nudged to consider switching models.
- **Worktree-aware checkpoints** — checkpoints saved from a linked git worktree anchor to the main repo and record provenance, so resuming re-enters the originating worktree.

### New in v0.3

- **Named checkpoint lanes** — checkpoints are keyed by a lane name (default: the sanitized git branch; `save --name` overrides). Saving supersedes only the same lane, so parallel efforts — including in separate worktrees — each keep an active, independently resumable checkpoint. `resume <name>` / `peek <name>` (non-mutating preview) / `resume --worktree` to re-enter or recreate the lane's worktree.
- **AFK cache keepalive** — Claude schedules a single recurring cron job (once per session) to keep the prompt cache warm. Pings are suppressed hook-side while you're active (zero context cost) and pass through only while you're actually idle; after `keepalive.max_idle_hours` (default 12) of continuous idleness the job is torn down. Jobs are deduped via a CronList-first check, since cron jobs survive `/clear`. Auto-disabled when drawing on usage credits, where the cache TTL is short anyway. Since 0.6, keepalive is need-based by default: it only schedules while a checkpoint lane or paused handoff is pending (config: keepalive.require_pending).

### New in v0.4

- **Budget-aware subagent trees** — hook state is keyed per agent, so subagents at any depth see their own compact meter ticks (`5h X% · pause at P%`). Each spawned agent gets a budget contract with a spawn-relative pause point: instead of burning the block invisibly, it finishes the current small step, writes a handoff to `.claude-checkpoints/handoffs/<agent_id>.md`, and returns `PAUSED-BUDGET`. Parents record (never re-attempt) paused children's work and pause too. Manage handoffs via `pacekeeper-checkpoint handoffs list|write|archive`.
- **Autonomous block renewal** — full auto, no asking: at `auto.five_hour_pct` (default 85) of the 5h block, Claude saves a checkpoint immediately and schedules a one-shot wake cron for just after the block resets. The wake prompt re-orients from the checkpoint (consuming it) and re-dispatches paused handoffs. Works even when the trigger tick arrives on an AFK keepalive turn.
- **Context auto-save** — at ctx critical, an immediate no-asking checkpoint save, re-armed per compaction cycle. Combined with the 5h directive when both fire at once.
- **Dispatch advisory** — a one-line caution (never a denial) before spawning agent trees when the 5h block is already tight.

### New in v0.5

- **macOS support** — OAuth credentials are now also read from the macOS Keychain, so the 5h/weekly meters work on Macs (previously silently absent).
- **Self-diagnosis** — if usage meters can't be read, Claude is told *why* once per session instead of the meters just vanishing, and `pacekeeper-checkpoint doctor` checks the whole environment (runtime, credentials, caches, config) with fixes.
- **Graceful degradation** — hooks no-op cleanly with an install hint if Bun is missing, instead of erroring on every event.
- **Better model tracking** — model-family detection covers Haiku/Fable/Mythos, per-model context windows resolve via `ANTHROPIC_API_KEY` when no subscription token exists, and subagent transcript rows no longer skew the context meter.

### New in v0.6

- **Injection-hardened cron auto-approval** — the plugin's own keepalive/wake cron jobs are auto-approved only when the *entire* payload matches the plugin's scheduling templates (cron shape, recurring flag, marker position, length cap), not when a prompt merely mentions a marker; `CronDelete` is auto-approved only for job ids the plugin itself scheduled. Anything else falls through to the normal permission prompt.
- **Need-based keepalive** — the idle cache-warming cron only schedules while a checkpoint lane or paused handoff is pending (`keepalive.require_pending`, default true).
- **macOS fixes + CI** — three latent macOS bugs fixed (background refresh, live-session counting, symlinked `/tmp`); the suite is enforced green on ubuntu + macos via GitHub Actions.
- **Doctor grows** — hook-crash breadcrumbs, version-skew detection, cache format-drift checks, `--transcript` probe.
- **Calmer keepalive suppression (0.6.1)** — when a keepalive ping races with active use, the unavoidable hook-block banner is all the plugin can restyle; its reason now rotates through a set of dry, plainly-intentional one-liners (clock-derived, no persisted state) instead of one terse string that read like an error.

## Install

```
/plugin marketplace add leaflessbranch/cc-pacekeeper
/plugin install cc-pacekeeper@cc-pacekeeper
```

Requires [Claude Code](https://claude.com/claude-code) and [Bun](https://bun.sh) on PATH. On macOS, the first usage fetch may show a Keychain prompt for `bun` — choose "Always Allow" so the 5h/weekly meters can read Claude Code's OAuth credential. Linux and macOS are supported; native Windows is not (the hook entrypoints are bash).

## Usage

Once installed, every prompt gets a one-line status prefix injected into Claude's context:

```
[pacekeeper] Fri 2026-07-04 18:42 IST · session 2h13m · idle 47m · ctx 19% · 5h 93% (2h29m) · week 42% (3d6h)
```

When a meter crosses a warning threshold, Claude is nudged to pause, surface the state, and offer to checkpoint. To save or resume in-flight work manually:

```
/cc-pacekeeper:checkpoint save
/cc-pacekeeper:checkpoint resume
/cc-pacekeeper:checkpoint list
```

Always resume via the `resume` verb (not by opening the file) — it archives the checkpoint so a stale one isn't re-surfaced next session.

To list, create, or clean up git worktrees with live-session and dirty-state awareness:

```
/cc-pacekeeper:worktree list
/cc-pacekeeper:worktree new <name>
/cc-pacekeeper:worktree cleanup
```

Checkpoints are written to your project's `.claude-checkpoints/` directory — anchored to the git repo root (or the session's working directory for non-git projects), never a transient dir like `/tmp`. Because they live in the working tree, you can commit, ignore, or delete them as you see fit.

## License

MIT. Vendors MIT-licensed modules from [ccstatusline](https://github.com/sirmalloc/ccstatusline) — see [`LICENSE`](LICENSE).
