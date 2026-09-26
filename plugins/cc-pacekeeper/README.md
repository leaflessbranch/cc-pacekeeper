# cc-pacekeeper

Usage-limit awareness for Claude Code. The plugin feeds your context window %, 5-hour block % and weekly limits into Claude's context on every prompt, so Claude paces itself, warns you at thresholds, and writes a resumable checkpoint before a limit forces a stop.

```
[pacekeeper] Fri 2026-07-04 18:42 IST · session 2h13m · ctx 19% · 5h 93% (2h29m) · week 42% (3d6h)
```

## What you get

- **A status line Claude can see.** Context % (measured against Claude Code's real auto-compact point), 5-hour block %, and weekly limits (all models, Sonnet-only, Opus-only), with time to each reset.
- **Threshold directives.** When a meter crosses a warning level, Claude pauses, tells you, and offers to checkpoint. It also knows whether you have extra-usage credits.
- **Resumable checkpoints.** `/cc-pacekeeper:checkpoint save | resume | list` writes Markdown files to your project's `.claude-checkpoints/`, organised in lanes (one per branch by default). After a compaction, this session's checkpoint is re-injected automatically.
- **Unattended renewal.** Near the end of a 5-hour block, Claude saves a checkpoint and schedules a wake-up for just after the reset. Subagents get a budget and hand off cleanly instead of burning the block.
- **Away awareness (Linux).** If you step away, Claude routes substantive replies to a channel you choose, and keeps the prompt cache warm while work is pending.
- **Worktrees.** `/cc-pacekeeper:worktree list | new | cleanup`, with live-session and uncommitted-change checks.

## Requirements

- Claude Code on Linux or macOS (native Windows is not supported).
- [Bun](https://bun.sh) on `PATH`. Without it the hooks stay silent and print an install hint.

Run `pacekeeper-checkpoint doctor` to check your setup.

## What runs on your machine

- **Hooks** on session start, prompt submit, tool use, stop and subagent events compute the status line and directives from the transcript and a local usage cache, fetching fresh usage (see Credentials) when the cache is stale.
- **A background refresh** after tool calls keeps that cache in `~/.cache/cc-pacekeeper/` current, so most hooks don't wait on the network.
- **A presence monitor** (Linux) reads tmux, tty, SSH and systemd idle state to detect when you've stepped away. Set `"presence": { "enabled": false }` to turn it off.
- **A permission hook** auto-approves only the plugin's own keepalive and wake-up cron jobs, and only when the whole request matches the plugin's template. Anything else goes to the normal permission prompt.

Configuration lives in `~/.config/cc-pacekeeper/config.json`.

## Credentials

The 5-hour and weekly meters come from Anthropic's API, so the plugin reuses the credential Claude Code already holds:

- **Read from:** Claude Code's OAuth token in `~/.claude/.credentials.json` or the macOS Keychain item `Claude Code-credentials`. If there is no OAuth token, `ANTHROPIC_API_KEY` is used for the context-window lookup only.
- **Sent to:** only `api.anthropic.com`, for `GET /api/oauth/usage` (limit meters) and `GET /v1/models/<id>` (context window). `HTTPS_PROXY` is honoured as a TLS tunnel.
- **Stored:** never. The cache keeps a truncated SHA-256 hash of the token to notice account switches.

On macOS, the first fetch may show a Keychain prompt for `bun`. Choose "Always Allow" so the meters work.

## More

Full documentation, changelog and source: https://github.com/leaflessbranch/cc-pacekeeper

MIT licensed.
