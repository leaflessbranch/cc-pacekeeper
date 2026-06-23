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

Checkpoints are written to your project's `.claude-checkpoints/` directory — anchored to the git repo root (or the session's working directory for non-git projects), never a transient dir like `/tmp`. Because they live in the working tree, you can commit, ignore, or delete them as you see fit.

## Configuration

Optional config lives at `~/.config/cc-pacekeeper/config.json` (created with defaults on first run).

### Per-model context window

cc-pacekeeper infers the context window from the active model. But some models expose the **same id for multiple context tiers** — e.g. Claude Opus 4.8 runs at either 200k or a 1M beta tier under one id, and Anthropic's model API reports only 200k. When detection can't tell which tier you're on, the percentage is scored against the wrong denominator (a 1M session reads as ~94% when it's really ~17% full).

Pin the window per model with `context_window_overrides` — matched by exact id first, then by longest id-prefix (so a base id also covers dated variants like `claude-opus-4-8-20260101`):

```json
{
  "context_window_overrides": {
    "claude-opus-4-8": 1000000
  }
}
```

A per-model override is preferred over the global `context_window_size`: it only affects the models you list, leaving every other model's auto-detection intact.

## License

MIT. Vendors MIT-licensed modules from [ccstatusline](https://github.com/sirmalloc/ccstatusline) — see [`LICENSE`](LICENSE).
