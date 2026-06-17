# cc-pacekeeper

A Claude Code plugin that hands monitoring of context window, 5-hour session block, and weekly usage limits over to Claude itself — so it can pace, warn, and checkpoint work before hitting a wall.

**Status:** Design phase. See [`docs/design.md`](docs/design.md).

## What it does

ccstatusline shows usage to *you*. cc-pacekeeper injects those same numbers into Claude's context via hooks, so Claude actively self-paces, surfaces threshold crossings, and offers to write a resumable checkpoint before limits force a stop.

Three meters tracked:

- **Context window %** — current conversation token usage
- **5-hour session block %** — Anthropic rolling window
- **Weekly limits** — all-models, Sonnet-only, Opus-only

Plus **extra-usage credits** state, so when limits approach Claude can ask whether to keep going on pay-as-you-go or checkpoint and resume after reset.

## Install

> Not yet released. Once published:

```
/plugin marketplace add leaflessbranch/cc-pacekeeper
/plugin install cc-pacekeeper@cc-pacekeeper
```

Requires [Bun](https://bun.sh) on PATH.

## License

MIT. Vendors MIT-licensed modules from [ccstatusline](https://github.com/sirmalloc/ccstatusline) — see [`LICENSE`](LICENSE).
