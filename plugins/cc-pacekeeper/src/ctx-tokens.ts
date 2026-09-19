import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { DEFAULT_CONTEXT_WINDOW_SIZE, getContextConfig } from './vendor/model-context';
import { getClaudeConfigDir } from './vendor/claude-config-dir';
import { readCachedMaxInputTokens } from './model-info';

/**
 * Compute the current context window token count from a Claude Code transcript JSONL.
 *
 * Strategy: walk the file backwards looking for the most recent assistant turn that
 * carries a `message.usage` object. That `usage` is cumulative for the conversation
 * up to that point (it reflects what was sent to the model on that turn), so it is
 * the right number for "how full is the context right now." A compact_boundary
 * entry met before any assistant usage short-circuits to its postTokens (see
 * CompactBoundarySchema).
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
    isSidechain: z.boolean().optional(),
    message: z.object({
        model: z.string().optional(),
        usage: UsageSchema.optional()
    }).optional()
});

/**
 * Claude Code writes this system entry when it compacts. Every usage record
 * above it describes the discarded conversation, so once we meet it walking
 * backwards the honest answer is the post-compaction size it carries.
 * `postTokens` is the summary + preserved tail; the fixed prefix (system
 * prompt, tools) is added back by the first real assistant turn's usage.
 */
const CompactBoundarySchema = z.object({
    type: z.literal('system'),
    subtype: z.literal('compact_boundary'),
    isSidechain: z.boolean().optional(),
    compactMetadata: z.object({ postTokens: z.number().optional() }).optional()
});

export interface ContextTokens {
    inputTotal: number;
    outputTotal: number;
    cached: number;
    /** input + cache_creation + cache_read — the number that fills the window. */
    contextLength: number;
    /** Model id from the same assistant turn, if present. */
    model?: string;
    /** Set when the reading came from a compact_boundary entry, not a turn. */
    fromCompactBoundary?: true;
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
        const boundary = CompactBoundarySchema.safeParse(obj);
        if (boundary.success) {
            if (boundary.data.isSidechain === true) continue;
            const post = boundary.data.compactMetadata?.postTokens;
            if (post === undefined) return null;
            return { inputTotal: post, outputTotal: 0, cached: 0, contextLength: post, fromCompactBoundary: true };
        }
        const parsed = AssistantMessageSchema.safeParse(obj);
        if (!parsed.success) continue;
        if (parsed.data.isSidechain === true) continue;
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
        if (parsed.data.isSidechain === true) continue;
        const model = parsed.data.message?.model;
        if (model) return model;
    }
    return null;
}

/** Claude Code's default auto-compact point for a model with a native 1M
 *  window ("compact before the window fills, at about 967K tokens by default"
 *  — docs, model-config § Default auto-compact thresholds). */
export const ONE_M_AUTOCOMPACT_TOKENS = 967_000;

/** Claude Code clamps the auto-compact window to this range (docs,
 *  settings-reference: "number of tokens, from 100000 to 1000000"). */
const AUTO_COMPACT_MIN_TOKENS = 100_000;
const AUTO_COMPACT_MAX_TOKENS = 1_000_000;

function clampAutoCompact(tokens: number): number {
    return Math.min(AUTO_COMPACT_MAX_TOKENS, Math.max(AUTO_COMPACT_MIN_TOKENS, tokens));
}

/**
 * Parse CLAUDE_CODE_AUTO_COMPACT_WINDOW, which takes a plain token count ONLY
 * (docs, env-vars reference): `500k` reads as `500` — and then clamps to the
 * 100K minimum. Deliberately not parseWindowSetting: mirroring Claude Code's
 * value semantics is the whole point of this denominator.
 */
function parseWindowEnv(raw: unknown): number | null {
    if (typeof raw !== 'string') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * Parse a window size in the forms the `autoCompactWindow` setting and the
 * `/autocompact` command accept (NOT the env var — see parseWindowEnv): a
 * plain token count, `500k` / `1M`, or a bare 100..1000 meaning thousands.
 * Null otherwise.
 */
export function parseWindowSetting(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
    if (typeof raw !== 'string') return null;
    const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM])?\s*$/.exec(raw);
    if (!m) return null;
    const n = Number.parseFloat(m[1]!);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = m[2]?.toLowerCase();
    if (unit === 'm') return Math.round(n * 1_000_000);
    if (unit === 'k') return Math.round(n * 1_000);
    return n >= 100 && n <= 1000 ? Math.round(n * 1_000) : Math.round(n);
}

/** `autoCompactWindow` from Claude Code's user settings.json, or null. */
export function readAutoCompactSetting(): number | null {
    try {
        const raw = fs.readFileSync(path.join(getClaudeConfigDir(), 'settings.json'), 'utf8');
        const parsed = JSON.parse(raw) as { autoCompactWindow?: unknown };
        return parseWindowSetting(parsed.autoCompactWindow);
    } catch {
        return null;
    }
}

/**
 * Whether Claude Code compacts automatically at all: off via the
 * `DISABLE_AUTO_COMPACT` env var or `autoCompactEnabled: false` in the user
 * settings.json. With it off a session stops at the context limit instead of
 * compacting, so directives that promise a compaction must not be emitted.
 * Anything unreadable means "on", the default.
 */
export function readAutoCompactEnabled(): boolean {
    try {
        const disable = process.env.DISABLE_AUTO_COMPACT;
        if (disable === '1' || disable?.toLowerCase() === 'true') return false;
        const raw = fs.readFileSync(path.join(getClaudeConfigDir(), 'settings.json'), 'utf8');
        const parsed = JSON.parse(raw) as { autoCompactEnabled?: unknown };
        return parsed.autoCompactEnabled !== false;
    } catch {
        return true;
    }
}

export type AutoCompactSource = 'env' | 'settings' | 'model-default';

/**
 * The token count at which Claude Code compacts a conversation on a model
 * whose window is `maxTokens`. This is the ctx% denominator: the meter reads
 * 100% exactly when compaction is due, matching Claude Code's own meter.
 * Precedence mirrors Claude Code: CLAUDE_CODE_AUTO_COMPACT_WINDOW → the
 * `autoCompactWindow` user setting → the model default (~967K for 1M windows,
 * the full window otherwise). Either override is clamped to [100K, 1M] as
 * Claude Code clamps it, then capped at the window.
 *
 * Historical note: until this change the denominator was 0.8 × window
 * (ccstatusline's "usable" ratio). On 1M models that reported ~95% at a real
 * 760K, ~200K short of compaction — observed live driving premature
 * checkpoint-and-restart cycles that discarded the whole conversation.
 */
export function autoCompactWindow(
    maxTokens: number,
    env: NodeJS.ProcessEnv = process.env,
    settingsWindow: number | null = readAutoCompactSetting()
): { tokens: number; source: AutoCompactSource } {
    const fromEnv = parseWindowEnv(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    if (fromEnv !== null) return { tokens: Math.min(clampAutoCompact(fromEnv), maxTokens), source: 'env' };
    if (settingsWindow !== null) return { tokens: Math.min(clampAutoCompact(settingsWindow), maxTokens), source: 'settings' };
    return { tokens: maxTokens >= 1_000_000 ? ONE_M_AUTOCOMPACT_TOKENS : maxTokens, source: 'model-default' };
}

/**
 * The model's context window, in this order:
 *   1. Explicit non-default `configOverride` (user-set value).
 *   2. Cached `max_input_tokens` from Anthropic's `/v1/models/{id}` endpoint.
 *   3. ccstatusline-style regex parse of size hints in the model string (`[1M]`).
 *   4. 200k default.
 *
 * `configOverride` equal to the historical default (200k) is treated as a
 * sentinel "no override" so existing configs don't silently cap modern models.
 */
function resolveMaxTokens(model?: string, configOverride?: number): number {
    const max = resolveRawMaxTokens(model, configOverride);
    // Docs, model-config: with CLAUDE_CODE_DISABLE_1M_CONTEXT=1, models with a
    // native 1M window are held at the 200K boundary and compact there.
    if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') return Math.min(max, 200_000);
    return max;
}

function resolveRawMaxTokens(model?: string, configOverride?: number): number {
    if (configOverride !== undefined && configOverride !== DEFAULT_CONTEXT_WINDOW_SIZE) {
        return getContextConfig(undefined, configOverride).maxTokens;
    }
    if (model) {
        const cached = readCachedMaxInputTokens(model);
        if (cached !== null) return cached;
    }
    return getContextConfig(model, null).maxTokens;
}

/**
 * Resolve the ctx% denominator: the auto-compact point for this model's
 * window (see autoCompactWindow). Name kept for the existing call sites.
 */
export function resolveUsableContextWindow(model?: string, configOverride?: number): number {
    return autoCompactWindow(resolveMaxTokens(model, configOverride)).tokens;
}

export function contextPercent(contextLength: number, usableTokens: number): number {
    if (usableTokens <= 0) return 0;
    return Math.min(100, Math.max(0, (contextLength / usableTokens) * 100));
}
