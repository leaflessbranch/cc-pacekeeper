#!/usr/bin/env bun
import { loadConfig, bootstrapConfigIfMissing } from './config';
import { KEEPALIVE_MARKER, scanKeepaliveState, scanMarkerCreates } from './keepalive';
import { RESUME_MARKER } from './agent-budget';
import { z } from 'zod';

/**
 * Auto-approval is gated on the FULL cron payload matching one of the plugin's
 * own scheduling templates — not mere marker presence. The markers are public
 * strings in a public repo, so any content the main agent ingests could ask it
 * to create a cron whose prompt embeds a marker; marker-presence approval would
 * waive the user's permission prompt for that injected job. Validating the whole
 * shape (recurring flag + cron form + marker position + length cap) closes that
 * hole: an injected job that isn't literally the plugin's keepalive/wake
 * template falls through to the normal permission flow.
 */

// Prompts from the plugin's own templates are short one-liners; anything longer
// smells like scope escalation smuggled into the prompt body.
const MAX_PROMPT_LEN = 1000;

// keepaliveDirective (keepalive.ts) instructs, verbatim:
//   "schedule one via CronCreate (recurring: true) firing every ~N minutes —
//    use fixed minute marks (e.g. \"13,43 * * * *\"), not a \"*/N\" minute step"
// So the only auto-approvable keepalive cron is two fixed minutes, every hour,
// every day/month/weekday: `M1,M2 * * * *` with M1,M2 in 0-59.
const KEEPALIVE_CRON = /^(\d{1,2}),(\d{1,2}) \* \* \* \*$/;

function inRange(field: string, lo: number, hi: number): boolean {
    if (!/^\d{1,2}$/.test(field)) return false;
    const n = Number(field);
    return n >= lo && n <= hi;
}

/** Keepalive shape: recurring true, two-fixed-minute cron, marker present. */
function isKeepaliveCreate(input: Record<string, unknown>): boolean {
    const prompt = input.prompt;
    if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LEN) return false;
    if (!prompt.includes(KEEPALIVE_MARKER)) return false;
    if (input.recurring !== true) return false;
    if (typeof input.cron !== 'string') return false;
    const m = KEEPALIVE_CRON.exec(input.cron);
    if (!m) return false;
    return inRange(m[1]!, 0, 59) && inRange(m[2]!, 0, 59);
}

/**
 * Wake one-shot shape (formatAutoLoopDirective in tick.ts):
 *   "Schedule a ONE-SHOT CronCreate at <ISO> ... whose prompt starts with the
 *    literal marker [pacekeeper-resume]".
 * A single future fire pins minute/hour/day-of-month/month to specific values
 * (no wildcards in those four fields); day-of-week may be `*` or a specific day.
 */
function isWakeOneShot(input: Record<string, unknown>): boolean {
    const prompt = input.prompt;
    if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LEN) return false;
    if (!prompt.startsWith(RESUME_MARKER)) return false;
    if (input.recurring !== false) return false;
    if (typeof input.cron !== 'string') return false;
    const fields = input.cron.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [min, hr, dom, mon, dow] = fields;
    if (!inRange(min!, 0, 59) || !inRange(hr!, 0, 23) || !inRange(dom!, 1, 31) || !inRange(mon!, 1, 12)) return false;
    // day-of-week is the only field allowed to stay unpinned.
    return dow === '*' || inRange(dow!, 0, 7);
}

async function readRawStdin(): Promise<unknown> {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk.toString();
    if (raw.trim() === '') return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * PreToolUse hook for cron tools. Auto-approves ONLY the keepalive-scoped
 * CronCreate/CronDelete calls this plugin itself instructs, so the user isn't
 * prompted for its own background cache-warming. Everything else falls through
 * to normal permission handling (emit {}).
 */

const ToolInputSchema = z.object({
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    transcript_path: z.string().optional(),
    // Present only inside subagent hook calls. [G7] Wake-arming (RESUME_MARKER
    // auto-approval) is exclusively the main loop's job — a subagent CronCreate
    // carrying the marker falls through to normal permissions instead.
    agent_id: z.string().optional()
});

function allow(reason: string): void {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: reason
        }
    }));
}

function passthrough(): void {
    process.stdout.write('{}');
}

async function main(): Promise<void> {
    const stdin = await readRawStdin();
    const parsed = ToolInputSchema.safeParse(stdin);
    const data = parsed.success ? parsed.data : {};

    bootstrapConfigIfMissing();
    const cfg = loadConfig();
    if (!cfg.keepalive.enabled) return passthrough();

    const toolName = data.tool_name;
    const input = data.tool_input ?? {};

    if (toolName === 'CronCreate') {
        // Keepalive recurring job: full-shape match required.
        if (isKeepaliveCreate(input)) {
            return allow('pacekeeper keepalive recurring job');
        }
        // [G7] Wake one-shot, but only on the main thread — a subagent marker
        // CronCreate falls through even if its shape is otherwise valid.
        if (!data.agent_id && isWakeOneShot(input)) {
            return allow('pacekeeper auto-wake one-shot');
        }
        return passthrough();
    }

    if (toolName === 'CronDelete') {
        // Id-scoped: auto-approve only when the target id is a job the plugin
        // itself scheduled and still has pending, recovered from the transcript
        // (keepalive or wake one-shot). The id is system-assigned and only
        // appears in the CronCreate tool_result, so an unrecoverable or unknown
        // id gives us nothing to match — fall through to the user rather than
        // approve a delete of an arbitrary job blind.
        const id = input.id;
        if (typeof id !== 'string' || !data.transcript_path) return passthrough();
        const known = new Set<string>();
        const ka = scanKeepaliveState(data.transcript_path);
        if (ka.hasPending && ka.pendingTaskId) known.add(ka.pendingTaskId);
        const wake = scanMarkerCreates(data.transcript_path, RESUME_MARKER);
        if (wake.hasPending && wake.pendingTaskId) known.add(wake.pendingTaskId);
        if (known.has(id)) return allow('pacekeeper cron cancel (known job id)');
        return passthrough();
    }

    return passthrough();
}

main().catch(() => {
    // On any error, never auto-approve — fall through to normal handling.
    try { process.stdout.write('{}'); } catch { /* ignore */ }
});
