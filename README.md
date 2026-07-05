# cc-pacekeeper

A Claude Code plugin that hands monitoring of context window, 5-hour session block, and weekly usage limits over to Claude itself — so it can pace, warn, and checkpoint work before hitting a wall.

**Status:** v0.2.4 — time & AFK awareness, cross-session budget awareness, worktree-aware checkpoints, a worktree lifecycle skill, and AFK cache keepalive. See the [changelog](CHANGELOG.md).

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
- **AFK cache keepalive** — Claude schedules a single recurring cron job (once per session) to keep the prompt cache warm. Pings are suppressed hook-side while you're active (zero context cost) and pass through only while you're actually idle; after `keepalive.max_idle_hours` (default 12) of continuous idleness the job is torn down. Auto-disabled when drawing on usage credits, where the cache TTL is short anyway.

## Install

```
/plugin marketplace add leaflessbranch/cc-pacekeeper
/plugin install cc-pacekeeper@cc-pacekeeper
```

Requires [Claude Code](https://claude.com/claude-code) and [Bun](https://bun.sh) on PATH.

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
