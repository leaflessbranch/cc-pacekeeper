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
    model: z.string().optional()
});

export type HookStdin = z.infer<typeof HookStdinSchema>;

export async function readStdinJson(): Promise<HookStdin> {
    let raw = '';
    for await (const chunk of process.stdin) {
        raw += chunk.toString();
    }
    if (raw.trim() === '') return {};
    try {
        const parsed = HookStdinSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
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
