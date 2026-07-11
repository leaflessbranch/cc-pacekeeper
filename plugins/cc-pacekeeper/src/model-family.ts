/**
 * Model-family detection, shared by the weekly-arbitrage nudge and doctor.
 * One table to extend when Anthropic ships a new family — the usage API's
 * per-family weekly buckets exist only for opus/sonnet today, so families
 * outside FAMILIES_WITH_WEEKLY_BUCKET simply never get an arbitrage nudge.
 */

export const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const;
export type ModelFamily = typeof MODEL_FAMILIES[number];

const FAMILY_RE = new RegExp(`(${MODEL_FAMILIES.join('|')})`, 'i');

export function modelFamily(modelId: string | undefined): ModelFamily | null {
    if (!modelId) return null;
    const m = FAMILY_RE.exec(modelId);
    return m ? (m[1]!.toLowerCase() as ModelFamily) : null;
}
