# Vendored modules

The files in this directory are derived from
[ccstatusline](https://github.com/sirmalloc/ccstatusline) by Matthew Breedlove,
MIT-licensed.

**Upstream pin:** commit `151521ca6ea19aaaff058183dc3876ae4cc91521`
(repo cloned `2026-06-17`)

**Modifications from upstream:**

- `usage-fetch.ts`: macOS keychain support restored (upstream removed during
  original vendoring, re-added 2026-07 with an injectable `exec` for tests —
  reads service `Claude Code-credentials`, falls back after the credentials
  file). Cache paths changed from `~/.cache/ccstatusline/` to
  `~/.cache/cc-pacekeeper/`. `readUsageCacheFile` gained an optional
  `verifyTokenHash` option (cc-pacekeeper addition, see Task 6 of the
  2026-07-11 plan). `getUsageToken` is memoized per process (hook processes
  are single-tick) to cap keychain probes at one per tick.
- `usage-types.ts`: copied verbatim.
- `claude-config-dir.ts`: extracted just `getClaudeConfigDir` from upstream's
  `claude-settings.ts` (rest of that file is install/uninstall TUI logic we
  don't need).
- `model-context.ts`: re-exported `USABLE_CONTEXT_RATIO` and
  `DEFAULT_CONTEXT_WINDOW_SIZE` so callers can scale to the same "usable"
  denominator ccstatusline uses for `context-percentage-usable`. Otherwise
  copied verbatim.

When syncing from upstream, update the SHA above and re-run the vendor diff.
