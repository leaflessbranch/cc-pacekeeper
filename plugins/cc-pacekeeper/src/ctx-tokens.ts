import * as fs from 'fs';
import { z } from 'zod';
import { DEFAULT_CONTEXT_WINDOW_SIZE, getContextConfig } from './vendor/model-context';
import { readCachedMaxInputTokens } from './model-info';

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
        model: z.string().optional(),
        usage: UsageSchema.optional()
    }).optional()
});

export interface ContextTokens {
    inputTotal: number;
    outputTotal: number;
    cached: number;
    /** input + cache_creation + cache_read — the number that fills the window. */
    contextLength: number;
    /** Model id from the same assistant turn, if present. */
    model?: string;
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
            contextLength: input + creation + read,
            model: parsed.data.message?.model
        };
    }
    return null;
}

/**
 * Read the most recent assistant turn's model id from a transcript without
 * requiring a usage record. Useful at SessionStart-ish moments when no
 * assistant turn has emitted usage yet but the transcript already exists.
 * Returns null if the transcript can't be read or no model is found.
 */
export function readMostRecentModel(transcriptPath: string): string | null {
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
        const model = parsed.data.message?.model;
        if (model) return model;
    }
    return null;
}

/**
 * Look up an explicit per-model context-window override.
 *
 * Matches the model string against the override map: an exact key first, then
 * the longest key that is a prefix of the model string — so a base id like
 * `claude-opus-4-8` also covers dated/suffixed variants such as
 * `claude-opus-4-8-20260101` or `claude-opus-4-8 [1M]`. Returns null when no
 * key matches or the mapped value is not a positive number.
 */
export function lookupModelOverride(model: string, overrides: Record<string, number>): number | null {
    const exact = overrides[model];
    if (typeof exact === 'number' && exact > 0) return exact;
    let best: number | null = null;
    let bestLen = -1;
    for (const [key, value] of Object.entries(overrides)) {
        if (typeof value === 'number' && value > 0 && key.length > bestLen && model.startsWith(key)) {
            best = value;
            bestLen = key.length;
        }
    }
    return best;
}

/**
 * Resolve the context window denominator.
 *
 * Order:
 *   1. Explicit per-model override (`context_window_overrides[model]`) — the
 *      most specific signal, so switching models stays correct. Wins over the
 *      global override and the auto-detection below.
 *   2. Explicit non-default global `configOverride` (user-set value).
 *   3. Cached `max_input_tokens` from Anthropic's `/v1/models/{id}` endpoint —
 *      authoritative, populated by a background fetch on first encounter.
 *   4. ccstatusline-style regex parse of size hints in the model string (`[1M]`).
 *   5. 200k default.
 *
 * We divide by the "usable" portion (0.8 × max) so cc-pacekeeper's reported
 * percentage matches ccstatusline's `context-percentage-usable` widget — 80%
 * is where Claude Code auto-compaction triggers.
 *
 * `configOverride` equal to the historical default (200k) is treated as a
 * sentinel "no override" so existing configs don't silently cap modern models.
 * A per-model override is the model-adaptive answer when the 200k and 1M tiers
 * share one model id (the 1M window is a per-request beta tier the API does not
 * report), so a single global `context_window_size` would mis-scale others.
 */
export function resolveUsableContextWindow(
    model?: string,
    configOverride?: number,
    perModelOverrides?: Record<string, number>
): number {
    if (model && perModelOverrides) {
        const override = lookupModelOverride(model, perModelOverrides);
        if (override !== null) {
            return getContextConfig(undefined, override).usableTokens;
        }
    }
    if (configOverride !== undefined && configOverride !== DEFAULT_CONTEXT_WINDOW_SIZE) {
        return getContextConfig(undefined, configOverride).usableTokens;
    }
    if (model) {
        const cached = readCachedMaxInputTokens(model);
        if (cached !== null) {
            return getContextConfig(undefined, cached).usableTokens;
        }
    }
    return getContextConfig(model, null).usableTokens;
}

export function contextPercent(contextLength: number, usableTokens: number): number {
    if (usableTokens <= 0) return 0;
    return Math.min(100, Math.max(0, (contextLength / usableTokens) * 100));
}
