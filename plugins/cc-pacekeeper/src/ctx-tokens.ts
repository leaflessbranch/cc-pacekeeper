import * as fs from 'fs';
import { z } from 'zod';

/**
 * Compute the current context window token count from a Claude Code transcript JSONL.
 *
 * Strategy: walk the file backwards looking for the most recent assistant turn that
 * carries a `message.usage` object. That `usage` is cumulative for the conversation
 * up to that point (it reflects what was sent to the model on that turn), so it is
 * the right number for "how full is the context right now."
 *
 * Returns null if the transcript can't be read or has no usable usage record yet.
 */

const UsageSchema = z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional()
});

const AssistantMessageSchema = z.object({
    type: z.literal('assistant').optional(),
    message: z.object({
        usage: UsageSchema.optional()
    }).optional()
});

export interface ContextTokens {
    inputTotal: number;
    outputTotal: number;
    cached: number;
    /** input + cache_creation + cache_read — the number that fills the window. */
    contextLength: number;
}

export function readContextTokens(transcriptPath: string): ContextTokens | null {
    let raw: string;
    try {
        raw = fs.readFileSync(transcriptPath, 'utf8');
    } catch {
        return null;
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || line.length === 0) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }
        const parsed = AssistantMessageSchema.safeParse(obj);
        if (!parsed.success) continue;
        const usage = parsed.data.message?.usage;
        if (!usage) continue;
        const input = usage.input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        const creation = usage.cache_creation_input_tokens ?? 0;
        const read = usage.cache_read_input_tokens ?? 0;
        return {
            inputTotal: input,
            outputTotal: output,
            cached: creation + read,
            contextLength: input + creation + read
        };
    }
    return null;
}

export function contextPercent(contextLength: number, windowSize: number): number {
    if (windowSize <= 0) return 0;
    return Math.min(100, Math.max(0, (contextLength / windowSize) * 100));
}
