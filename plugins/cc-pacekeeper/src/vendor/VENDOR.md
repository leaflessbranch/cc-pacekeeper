# Vendored modules

The files in this directory are derived from
[ccstatusline](https://github.com/sirmalloc/ccstatusline) by Matthew Breedlove,
MIT-licensed.

**Upstream pin:** commit `151521ca6ea19aaaff058183dc3876ae4cc91521`
(repo cloned `2026-06-17`)

**Modifications from upstream:**

- `usage-fetch.ts`: removed macOS keychain branch (`readUsageTokenFromMacKeychain*`
  functions and the platform check in `getUsageToken`). cc-pacekeeper targets
  Linux; falling back to `~/.claude/.credentials.json` is the only path. Cache
  paths changed from `~/.cache/ccstatusline/` to `~/.cache/cc-pacekeeper/`.
- `usage-types.ts`: copied verbatim.
- `claude-config-dir.ts`: extracted just `getClaudeConfigDir` from upstream's
  `claude-settings.ts` (rest of that file is install/uninstall TUI logic we
  don't need).

When syncing from upstream, update the SHA above and re-run the vendor diff.
