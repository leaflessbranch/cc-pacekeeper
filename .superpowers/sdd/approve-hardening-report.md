# approve.ts hardening report — full cron payload validation + id-scoped deletes

## Threat model

The PreToolUse hook `bin/pacekeeper-approve` (`src/approve.ts`) matches `CronCreate|CronDelete`
and auto-approves the plugin's own background cron machinery so the user isn't prompted for it.

**Before:** the decision was made by **marker presence** — any `CronCreate` whose `prompt`
contained the literal string `[pacekeeper-keepalive]` or `[pacekeeper-resume]` was auto-approved.
Those markers are public strings in a public repo. Any untrusted content the main agent ingests
(a webpage, README, pasted issue) can instruct it to create a cron job whose prompt embeds a
marker. The hook would then silently waive the user's permission prompt for an attacker-authored
scheduled job — a prompt-injection-shaped hole yielding unattended scheduled prompts the user
never approved. `CronDelete` was similarly loose: it would auto-approve deleting an
**unrecoverable-id** job whenever *any* keepalive was pending, i.e. approve deletion of an
arbitrary job id blind.

**After:** auto-approval requires the **entire payload** to match one of the plugin's own
scheduling templates. An injected job that merely name-drops a marker no longer matches and falls
through to the normal permission flow. Deletes are id-scoped to jobs the plugin itself scheduled.

## Rules implemented

### CronCreate — keepalive shape (`isKeepaliveCreate`)
Auto-approve only if ALL hold:
- `recurring === true`
- `cron` matches `^\d{1,2},\d{1,2} \* \* \* \*$` with both minutes in 0–59 (two fixed minute
  marks, every hour/day/month/weekday)
- `prompt` contains `KEEPALIVE_MARKER`
- `prompt.length <= 1000`

Cited template (`keepalive.ts` `keepaliveDirective`): *"schedule one via CronCreate (recurring:
true) ... use fixed minute marks (e.g. "13,43 * * * *"), not a "*/N" minute step"*. The regex is
aligned to exactly this two-fixed-minute form (embedded as a code comment in `approve.ts`).

### CronCreate — wake one-shot shape (`isWakeOneShot`)
Auto-approve only if ALL hold:
- `!agent_id` (**[G7]** wake-arming is exclusively the main loop's job; a subagent marker
  CronCreate falls through even if otherwise well-shaped — preserved from prior behavior)
- `recurring === false`
- `prompt` **starts with** `RESUME_MARKER`
- `cron` has 5 fields; minute (0–59), hour (0–23), day-of-month (1–31), month (1–12) are each a
  specific pinned integer (no wildcards); day-of-week may be `*` or 0–7 (the only unpinned field —
  a specific date's weekday is redundant, so it's left free)
- `prompt.length <= 1000`

Cited template (`tick.ts` `formatAutoLoopDirective`): *"Schedule a ONE-SHOT CronCreate at <ISO>
... whose prompt starts with the literal marker [pacekeeper-resume]"*.

### CronDelete — id-scoped (`known` set)
Auto-approve only when `input.id` is a string, `transcript_path` is present, and the id equals a
pending job id the plugin recovered from the transcript:
- `scanKeepaliveState(transcript_path).pendingTaskId` (keepalive), OR
- `scanMarkerCreates(transcript_path, RESUME_MARKER).pendingTaskId` (wake one-shot — the analogous
  recorded id; wake one-shots are tracked by the same forward-scan correlation via the shared
  `scanMarkerCreates`).

Unknown id, missing id, missing transcript, or unrecoverable pending id → fall through (`{}`).
The prior "id unrecoverable but keepalive pending → allow" branch was **removed** as the deletion
half of the vulnerability.

### Invariants preserved
- **Never deny** — only ever `allow` or `{}` (passthrough). No `deny` decision is emitted.
- **Fail-safe** — parse failure / empty stdin / missing fields / unexpected shape → `{}`
  (unchanged `readRawStdin` + top-level `.catch` writing `{}`; every helper returns false on any
  non-conforming field).
- **keepalive.enabled gate** — unchanged; disabled config → passthrough.

## Files changed
- `src/approve.ts` — added `MAX_PROMPT_LEN`, `KEEPALIVE_CRON`, `inRange`, `isKeepaliveCreate`,
  `isWakeOneShot`; rewrote the CronCreate and CronDelete branches; imported `scanMarkerCreates`.
- `src/__tests__/approve.test.ts` — updated the keepalive CronCreate case to a full-shape payload;
  the non-marker case now sends a valid cron too; the "unrecoverable id → allow" test became
  "unrecoverable id → passthrough" (hardened contract).
- `src/__tests__/approve-resume.test.ts` — updated the three cases to full-shape one-shot payloads.
- `src/__tests__/approve-payload.test.ts` — **new** file: keepalive-shape, wake-shape,
  CronDelete id-scoping, and fail-safe attack/legit cases.

## Test list (new / notable, all passing)
Keepalive shape: allows two-fixed-minute recurring + marker; rejects marker in `* * * * *`;
rejects `*/5` step; rejects keepalive cron with recurring=false; rejects out-of-range minute
(`13,77`); rejects over-length prompt; rejects missing cron field.
Wake shape: allows `30 14 7 11 *` recurring=false + RESUME prefix; rejects wildcard cron; rejects
marker mid-prompt (not prefix); rejects recurring=true; rejects wildcard day-of-month; rejects
over-length prompt; (approve-resume) rejects subagent agent_id.
CronDelete id-scoping: allows known wake one-shot id; rejects unknown id; rejects missing id;
(approve.test) allows known keepalive id; rejects unrelated id; rejects when no pending; rejects
unrecoverable-id.
Fail-safe: empty stdin, garbage stdin, non-string prompt → all `{}`.

## Suite output
- `bun run typecheck` — clean (`tsc --noEmit`, no output).
- Targeted: `29 pass, 0 fail` across the 3 approve test files.
- Full `bun test`: **225 pass, 6 fail** across 25 files. The 6 failures are exactly the documented
  out-of-scope, environment-sensitive pre-existing failures on macOS:
  `resolveProjectRoot` ×3, `pacekeeper-refresh wrapper` ×1, `liveSessionCount` ×2. No new failures.

## Self-review / uncertainties
- **Cron field format assumption.** I assumed Claude Code's CronCreate emits a standard 5-field
  cron (`min hour dom month dow`). The plugin's own directives use exactly this form
  (`13,43 * * * *`, and a one-shot pinning a specific datetime), so validation is aligned to what
  the plugin instructs. If the real CronCreate ever emits 6 fields (seconds) or a non-standard form,
  the legitimate job would fall through to a permission prompt (fail-safe, not fail-open) — the
  safe direction. This could be revisited if the plugin's scheduling form changes.
- **day-of-week left unpinned** for the one-shot. A specific calendar date already fixes the fire
  time; requiring a matching weekday would be redundant and could reject a legitimately-formed job.
  Requirement only mandated pinning the four fields min/hour/dom/month, which is enforced.
- **Two-minute keepalive cron is strict.** The regex requires exactly two comma-separated minutes,
  per the requirement's spec and the directive's `13,43 * * * *` example. A single-minute cron
  (`13 * * * *`) would fall through. This matches the stated contract; if the plugin ever schedules
  a single-mark keepalive it would need a permission prompt (again, safe direction).
- **CronDelete not agent_id-gated.** The original code did not gate deletes on `agent_id` and the
  requirements didn't ask for it, so I left it: a subagent may still auto-delete a *known* plugin
  job id. This is low-risk (delete-only, id-scoped to a plugin-scheduled job) and out of scope.
- No changes were needed outside `approve.ts` + the test files; `scanMarkerCreates` already existed
  and generalizes cleanly to the RESUME marker, so wake-one-shot id recovery required no new code
  elsewhere.
