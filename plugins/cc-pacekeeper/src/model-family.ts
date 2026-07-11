/**
 * Model-family detection for the weekly-arbitrage nudge. One table to extend
 * when Anthropic ships a new family — the usage API's per-family weekly
 * buckets exist only for opus/sonnet today, so other families resolve here
 * but never get an arbitrage nudge (thresholds.ts filters to opus/sonnet).
 */

export const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const;
export type ModelFamily = typeof MODEL_FAMILIES[number];

const FAMILY_RE = new RegExp(`(${MODEL_FAMILIES.join('|')})`, 'i');

export function modelFamily(modelId: string | undefined): ModelFamily | null {
    if (!modelId) return null;
    const m = FAMILY_RE.exec(modelId);
    return m ? (m[1]!.toLowerCase() as ModelFamily) : null;
}
