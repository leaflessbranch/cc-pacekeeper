# cc-pacekeeper

A Claude Code plugin that hands monitoring of context window, 5-hour session block, and weekly usage limits over to Claude itself — so it can pace, warn, and checkpoint work before hitting a wall.

**Status:** v0.10.0 — adds an **experimental**, opt-in port for the Codex CLI (see [Codex package](#codex-package-experimental)); the Claude plugin itself is unchanged since 0.9.x. 0.9.0 made the context meter agree with Claude Code about when compaction happens, re-injects this session's checkpoint after an in-session compaction, and locks a checkpoint lane's `## Goal` so long tasks can't drift; 0.9.1–0.9.2 prepared the plugin listing. See the [changelog](CHANGELOG.md).

![cc-pacekeeper in action](docs/demo.gif)

## What it does

ccstatusline shows usage to *you*. cc-pacekeeper injects those same numbers into Claude's context via hooks, so Claude actively self-paces, surfaces threshold crossings, and offers to write a resumable checkpoint before limits force a stop.

Three meters tracked:

- **Context window %** — current conversation tokens as a fraction of Claude Code's auto-compact window (100% = compaction due)
- **5-hour session block %** — Anthropic rolling window
- **Weekly limits** — all-models, Sonnet-only, Opus-only

Plus **extra-usage credits** state, so when limits approach Claude can ask whether to keep going on pay-as-you-go or checkpoint and resume after reset.

### New in v0.10

- **Codex package (experimental, opt-in)** — the same pacing for Codex CLI sessions on a ChatGPT subscription: the status line, warn/critical directives, checkpoint lanes with auto-save, subagent budgets and handoffs, and cache keepalive, installed from this repository's Codex marketplace entry. Live-tested on Codex 0.164 (Linux); the post-reset wake, macOS and account switching are not yet proven. Details in [Codex package](#codex-package-experimental).

### New in v0.9

- **Context meter matches Claude Code's compaction point** — ctx% is measured against the window Claude Code actually compacts at (~967K on 1M-window models, the full window otherwise; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and the `autoCompactWindow` setting override it). It previously divided by 0.8 × window, reading ~95% at a real ~760K and driving checkpoint-and-restart cycles that discarded ~200K of usable context per cycle. 100% now means compaction is due.
- **Compaction re-orients from the checkpoint** — after an in-session compaction, the checkpoint saved this session is re-injected in full, so Claude picks up from it rather than the compaction summary alone. The PreCompact hook is removed: it cannot inject context, so that nudge never reached Claude.
- **Goal lock** — a checkpoint lane's `## Goal` is carried forward verbatim across saves; `save` refuses a changed goal unless `--goal-changed` is passed, and the change is recorded in the file and shown by `list`. This is what stops a long task from drifting one paraphrase at a time across compactions. It makes a goal change deliberate and visible, not impossible: for a harness-enforced completion condition on an unattended run, use Claude Code's `/goal` alongside — pacekeeper's checkpoint carries the *state*, `/goal` carries the *condition*.

### New in v0.7 / v0.8

- **Proactive AFK detection** — a background monitor watches tmux client activity, controlling-tty atime, SSH logins and systemd's idle hint, and reports when you actually step away. Previously absence was only knowable *retroactively*, from the gap between two hook events once you came back; hooks stop firing the moment you leave, so they can never see a departure.
- **Away notifications** — when you're away, Claude reaches you on the channel you chose instead of talking to an empty terminal: it routes substantive replies to you as soon as you're detected `afk`, and sends a status report when work is pending and a limit escalates. It asks once, at session start, offering whatever channels it can see; the answer is saved.
- **Channel-agnostic by design** — the plugin names no channel anywhere. Your `preferred` labels and `target` are opaque strings it stores and hands back; Claude resolves them at send time against the tools actually loaded in your session. Your destination lives only in your local config, never in the repo.
- **Presence is per machine, not per session** — several open sessions won't each ping you for one departure; the watchers arbitrate through a shared state file so exactly one reports it.

Presence probes are Linux-only for now (macOS support is deferred for lack of a test environment); everywhere else detection falls back to the previous hook-gap behavior. Notifications only work while a session is open — nothing can reach a session that has ended.

### New in v0.6

- **Injection-hardened cron auto-approval** — the plugin's own keepalive/wake cron jobs are auto-approved only when the *entire* payload matches the plugin's scheduling templates (cron shape, recurring flag, marker position, length cap), not when a prompt merely mentions a marker; `CronDelete` is auto-approved only for job ids the plugin itself scheduled. Anything else falls through to the normal permission prompt.
- **Need-based keepalive** — the idle cache-warming cron only schedules while a checkpoint lane or paused handoff is pending (`keepalive.require_pending`, default true).
- **macOS fixes + CI** — three latent macOS bugs fixed (background refresh, live-session counting, symlinked `/tmp`); the suite is enforced green on ubuntu + macos via GitHub Actions.
- **Doctor grows** — hook-crash breadcrumbs, version-skew detection, cache format-drift checks, `--transcript` probe.
- **Calmer keepalive suppression (0.6.1)** — when a keepalive ping races with active use, the unavoidable hook-block banner is all the plugin can restyle; its reason now rotates through a set of dry, plainly-intentional one-liners (clock-derived, no persisted state) instead of one terse string that read like an error.

### New in v0.5

- **macOS support** — OAuth credentials are now also read from the macOS Keychain, so the 5h/weekly meters work on Macs (previously silently absent).
- **Self-diagnosis** — if usage meters can't be read, Claude is told *why* once per session instead of the meters just vanishing, and `pacekeeper-checkpoint doctor` checks the whole environment (runtime, credentials, caches, config) with fixes.
- **Graceful degradation** — hooks no-op cleanly with an install hint if Bun is missing, instead of erroring on every event.
- **Better model tracking** — model-family detection covers Haiku/Fable/Mythos, per-model context windows resolve via `ANTHROPIC_API_KEY` when no subscription token exists, and subagent transcript rows no longer skew the context meter.

### New in v0.4

- **Budget-aware subagent trees** — hook state is keyed per agent, so subagents at any depth see their own compact meter ticks (`5h X% · pause at P%`). Each spawned agent gets a budget contract with a spawn-relative pause point: instead of burning the block invisibly, it finishes the current small step, writes a handoff to `.claude-checkpoints/handoffs/<agent_id>.md`, and returns `PAUSED-BUDGET`. Parents record (never re-attempt) paused children's work and pause too. Manage handoffs via `pacekeeper-checkpoint handoffs list|write|archive`.
- **Autonomous block renewal** — full auto, no asking: at `auto.five_hour_pct` (default 85) of the 5h block, Claude saves a checkpoint immediately and schedules a one-shot wake cron for just after the block resets. The wake prompt re-orients from the checkpoint (consuming it) and re-dispatches paused handoffs. Works even when the trigger tick arrives on an AFK keepalive turn. Claude Code itself (2.1.234+) continues a session when a usage limit resets; if that happens first, the wake prompt finds nothing pending and ends in one word.
- **Context auto-save** — at ctx critical, an immediate no-asking checkpoint save, re-armed per compaction cycle. Combined with the 5h directive when both fire at once. After an in-session compaction, the checkpoint saved this session is re-injected in full (SessionStart with source "compact"), so Claude re-orients from the checkpoint rather than the compaction summary alone.
- **Dispatch advisory** — a one-line caution (never a denial) before spawning agent trees when the 5h block is already tight.

### New in v0.3

- **Named checkpoint lanes** — checkpoints are keyed by a lane name (default: the sanitized git branch; `save --name` overrides). Saving supersedes only the same lane, so parallel efforts — including in separate worktrees — each keep an active, independently resumable checkpoint. `resume <name>` / `peek <name>` (non-mutating preview) / `resume --worktree` to re-enter or recreate the lane's worktree.
- **AFK cache keepalive** — Claude schedules a single recurring cron job (once per session) to keep the prompt cache warm. Pings are suppressed hook-side while you're active (zero context cost) and pass through only while you're actually idle; after `keepalive.max_idle_hours` (default 12) of continuous idleness the job is torn down. Jobs are deduped via a CronList-first check, since cron jobs survive `/clear`. Auto-disabled when drawing on usage credits, where the cache TTL is short anyway. Since 0.6, keepalive is need-based by default: it only schedules while a checkpoint lane or paused handoff is pending (config: keepalive.require_pending).

### New in v0.2

- **Time & AFK awareness** — every prompt carries the local wall-clock, session duration, and (after an idle gap) a "you were away" note, so Claude reasons about elapsed time and reset windows.
- **Cross-session budget awareness** — when more than one Claude session is live, the line notes how many share your account budget.
- **5-hour block-reset bridge** — when the 5h block is nearly full but resets soon, Claude is told to wait it out rather than checkpoint-and-resume.
- **Weekly model-family arbitrage** — when one family's weekly limit is stressed but the other has headroom, Claude is nudged to consider switching models.
- **Worktree-aware checkpoints** — checkpoints saved from a linked git worktree anchor to the main repo and record provenance, so resuming re-enters the originating worktree.

## Install

```
/plugin marketplace add leaflessbranch/cc-pacekeeper
/plugin install cc-pacekeeper@cc-pacekeeper
```

Requires [Claude Code](https://claude.com/claude-code) and [Bun](https://bun.sh) on PATH. On macOS, the first usage fetch may show a Keychain prompt for `bun` — choose "Always Allow" so the 5h/weekly meters can read Claude Code's OAuth credential. Linux and macOS are supported; native Windows is not (the hook entrypoints are bash).

## Codex package (experimental)

> **Experimental.** The Codex package is live-tested on Codex 0.164 (Linux) for status, checkpoints, subagent handoffs and keepalive delivery, but the post-reset wake has not yet run against a real five-hour reset, macOS is untested, and Codex's thread-queue API it relies on is itself experimental. Expect rough edges and check `doctor`; the Claude plugin is unaffected.

The repository also ships an opt-in package for the [Codex CLI](https://github.com/openai/codex) at `plugins/codex-pacekeeper/`, targeting Codex **0.160** with a ChatGPT subscription. It brings the same pacing to Codex sessions: the status line on every prompt, warn/critical directives, context auto-save, five-hour auto-renewal with a post-reset wake, the near-reset bridge, checkpoint lanes, subagent budget contracts and handoffs, need-based cache keepalive, worktree helpers and `doctor`. Codex keeps its own state and checkpoint subtree (`.claude-checkpoints/codex/`); it reads the Claude config as input but never writes it.

How it differs from the Claude plugin, and why:

- **Readings come from the rollout.** Codex appends a `token_count` event (context and the five-hour/weekly windows) to the session rollout on every response, and the hook reads it there. A background refresh adds the native account read through Codex's local control socket when one is available.
- **Keepalive and the reset wake are queued messages.** Codex has no in-session cron for the model, so a small background service (`pacekeeper-service watch`) queues `[pacekeeper-keepalive] ping` or `[pacekeeper-resume] <id>` into the idle thread through the control socket. A turn end with pending work starts it and it exits on its own when nothing is pending. As with Claude, the ping is a prompt-level contract: the model is told to reply `pong` without tools, and `doctor` reports a reply that wasn't.
- **Not ported:** the live-sessions-sharing-budget segment, model-family arbitrage (Codex has no per-family weekly bucket), and presence-driven away routing (Codex has no plugin monitor to deliver presence changes).

See [`docs/codex-acceptance.md`](docs/codex-acceptance.md) for the per-capability ledger and the checks that still need a live Codex session.

Install from this repository (Bun required):

```sh
(cd plugins/codex-pacekeeper && bun install --frozen-lockfile)
codex plugin marketplace add <repository-root>
codex plugin add codex-pacekeeper@pacekeeper-codex
```

Trust the plugin's hooks when Codex asks, then run `plugins/codex-pacekeeper/bin/pacekeeper-checkpoint doctor` from a Codex session to check the rollout readings, control socket, quota and keepalive service. Disable the plugin with `plugins."codex-pacekeeper@pacekeeper-codex".enabled = false` in the Codex configuration, or remove it with `codex plugin remove codex-pacekeeper@pacekeeper-codex`.

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

### Away channels

The first session after install, Claude asks how to reach you when you step away, offering the channels it can see in your setup. Nothing is sent unless you answer — decline and it won't ask again.

The answer lands in `~/.config/cc-pacekeeper/config.json`:

```jsonc
"channels": {
  "preferred": ["my-channel"],  // your own labels, most-preferred first
  "target": "my-destination",   // whatever identifies where to send
  "asked": true
}
```

Both values are opaque to the plugin — it stores them and hands them back to Claude, which matches them against the tools actually available. They stay in your local config and are never committed.

Two things happen when you're away. As soon as you're detected `afk`, Claude is told — once per away episode — to route *substantive* replies to your channel for the rest of that absence, deciding for itself when a reply is worth interrupting you for; a trivial acknowledgement stays quiet. Separately, if work is pending *and* a limit escalates while you're gone, it sends the usual status report. Walking away from an idle session with nothing to say sends nothing.

To turn presence detection off entirely, set `"presence": { "enabled": false }`. Run `pacekeeper-checkpoint doctor` to see which probes work on your machine.

Checkpoints are written to your project's `.claude-checkpoints/` directory — anchored to the git repo root (or the session's working directory for non-git projects), never a transient dir like `/tmp`. Because they live in the working tree, you can commit, ignore, or delete them as you see fit.

## Credentials

The 5h and weekly meters, and the per-model context window, come from Anthropic's own API, so the plugin reuses the credential Claude Code already holds rather than asking you for one:

- **Where it's read:** Claude Code's OAuth token from `<config dir>/.credentials.json` (Linux) or the macOS Keychain item `Claude Code-credentials` (`src/vendor/usage-fetch.ts`). If there is no OAuth token, `ANTHROPIC_API_KEY` is used for the model-window lookup only (`src/model-info.ts`).
- **Where it goes:** only to `api.anthropic.com` — `GET /api/oauth/usage` for the limit meters and `GET /v1/models/<id>` for the context window. If `HTTPS_PROXY` is set, the request tunnels through your proxy with TLS end to end.
- **What's kept:** the token itself is never written anywhere. The usage cache in `~/.cache/cc-pacekeeper/` stores only the response and a hash of the token (to notice account switches).

It isn't a `user_config` option because the token belongs to Claude Code, which rotates it; a pasted copy would go stale within hours.

## License

MIT. Vendors MIT-licensed modules from [ccstatusline](https://github.com/sirmalloc/ccstatusline) — see [`LICENSE`](LICENSE).
