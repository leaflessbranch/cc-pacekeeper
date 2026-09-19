import { z } from 'zod';

const HookStdinSchema = z.object({
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    hook_event_name: z.string().optional(),
    source: z.string().optional(),
    tool_name: z.string().optional(),
    // UserPromptSubmit carries the submitted prompt text. Used to recognize
    // keepalive pings so they don't count as user activity.
    prompt: z.string().optional(),
    // SessionStart includes the active model id directly. Other events don't,
    // so we fall back to reading it from the transcript.
    model: z.string().optional(),
    // Stop/SubagentStop only: true when Claude Code is ALREADY continuing as a
    // result of a prior stop-hook injection. additionalContext on a Stop hook
    // re-opens the turn under the same continuation cap as decision:block, so a
    // directive that re-injects every turn loops until the harness force-ends.
    // tick.ts reads this to stay silent inside a continuation it already fed.
    stop_hook_active: z.boolean().optional(),
    // Present only inside subagent hook calls (any tool event at any nesting
    // depth). Absent on the main thread — that absence is how tick.ts tells
    // main-thread vs. subagent branches apart.
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    // Stop only (Claude Code ≥ 2.1.2xx): the session-scoped crons the harness
    // itself knows about (CronCreate, ScheduleWakeup, /loop), each
    // { id, schedule, recurring, prompt }. Ground truth for "is a keepalive or
    // wake job scheduled" — no transcript scan needed when present. Kept
    // untyped here on purpose: a stricter schema would fail the WHOLE stdin
    // parse on one odd entry and silently no-op the tick. keepalive.ts
    // validates entries one by one.
    session_crons: z.array(z.unknown()).optional()
});

export type HookStdin = z.infer<typeof HookStdinSchema>;

/** Pure parser for the hook's stdin JSON. Anything unparseable is `{}`. */
export function parseHookStdin(raw: string): HookStdin {
    if (raw.trim() === '') return {};
    try {
        const parsed = HookStdinSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

export async function readStdinJson(): Promise<HookStdin> {
    let raw = '';
    for await (const chunk of process.stdin) {
        raw += chunk.toString();
    }
    return parseHookStdin(raw);
}

export function emitAdditionalContext(eventName: string, text: string): void {
    if (!text || text.trim() === '') {
        process.stdout.write('{}');
        return;
    }
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: eventName,
            additionalContext: text
        }
    }));
}

export function emitEmpty(): void {
    process.stdout.write('{}');
}

export function emitBlock(reason: string): void {
    process.stdout.write(JSON.stringify({
        decision: 'block',
        reason
    }));
}
