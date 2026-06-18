# cc-pacekeeper

A Claude Code plugin that hands monitoring of context window, 5-hour session block, and weekly usage limits over to Claude itself — so it can pace, warn, and checkpoint work before hitting a wall.

**Status:** v0.1 implemented — plugin, hooks, and checkpoint skill smoke-verified.

## What it does

ccstatusline shows usage to *you*. cc-pacekeeper injects those same numbers into Claude's context via hooks, so Claude actively self-paces, surfaces threshold crossings, and offers to write a resumable checkpoint before limits force a stop.

Three meters tracked:

- **Context window %** — current conversation token usage
- **5-hour session block %** — Anthropic rolling window
- **Weekly limits** — all-models, Sonnet-only, Opus-only

Plus **extra-usage credits** state, so when limits approach Claude can ask whether to keep going on pay-as-you-go or checkpoint and resume after reset.

## Install

```
/plugin marketplace add leaflessbranch/cc-pacekeeper
/plugin install cc-pacekeeper@cc-pacekeeper
```

Requires [Claude Code](https://claude.com/claude-code) and [Bun](https://bun.sh) on PATH.

## Usage

Once installed, every prompt gets a one-line status prefix injected into Claude's context:

```
[pacekeeper] ctx 19% · 5h 93% (2h29m) · week 42% (3d6h)
```

When a meter crosses a warning threshold, Claude is nudged to pause, surface the state, and offer to checkpoint. To save or resume in-flight work manually:

```
/cc-pacekeeper:checkpoint save
/cc-pacekeeper:checkpoint resume
/cc-pacekeeper:checkpoint list
```

Checkpoints are written to `<cwd>/.claude-checkpoints/` — commit, ignore, or delete them as you see fit.

## License

MIT. Vendors MIT-licensed modules from [ccstatusline](https://github.com/sirmalloc/ccstatusline) — see [`LICENSE`](LICENSE).
