#!/usr/bin/env bun
import { loadConfig, bootstrapConfigIfMissing } from './config';
import { KEEPALIVE_MARKER, scanKeepaliveState } from './keepalive';
import { z } from 'zod';

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
    transcript_path: z.string().optional()
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
        const prompt = input.prompt;
        if (typeof prompt === 'string' && prompt.includes(KEEPALIVE_MARKER)) {
            return allow('pacekeeper keepalive one-shot');
        }
        return passthrough();
    }

    if (toolName === 'CronDelete') {
        const id = input.id ?? input.taskId ?? input.cronId;
        const pending = data.transcript_path ? scanKeepaliveState(data.transcript_path).pendingTaskId : undefined;
        if (typeof id === 'string' && pending && id === pending) {
            return allow('pacekeeper keepalive cancel');
        }
        return passthrough();
    }

    return passthrough();
}

main().catch(() => {
    // On any error, never auto-approve — fall through to normal handling.
    try { process.stdout.write('{}'); } catch { /* ignore */ }
});
