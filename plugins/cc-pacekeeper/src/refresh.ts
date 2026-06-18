#!/usr/bin/env bun
import { bootstrapConfigIfMissing, loadConfig } from './config';
import { fetchUsageData, getUsageCacheFileAgeSeconds } from './vendor/usage-fetch';
import { readStdinJson } from './hook-io';
import { readMostRecentModel } from './ctx-tokens';
import { fetchAndCacheMaxInputTokens, readCachedMaxInputTokens } from './model-info';

/**
 * Detached refresh script — runs in the background after PostToolUse. Self-gates
 * on cache staleness so spawning every tool call is harmless. The lock file
 * inside fetchUsageData prevents API hammering even if multiple instances race.
 *
 * Also opportunistically populates the per-model max_input_tokens cache. The
 * tick hook reads that cache synchronously to size the context window; if a
 * tick saw a fresh model id and bailed to the 200k default, this run fills it
 * in so the next tick is accurate.
 */
async function main(): Promise<void> {
    bootstrapConfigIfMissing();
    const cfg = loadConfig();

    const stdin = await readStdinJson();
    const model = stdin.model
        ?? (stdin.transcript_path ? readMostRecentModel(stdin.transcript_path) : null);
    if (model && readCachedMaxInputTokens(model) === null) {
        try { await fetchAndCacheMaxInputTokens(model); } catch { /* swallow */ }
    }

    const age = getUsageCacheFileAgeSeconds();
    if (age !== null && age < cfg.cache_ttl_seconds) {
        // Cache fresh enough; skip API call.
        return;
    }

    try {
        await fetchUsageData();
    } catch {
        // Stale-cache fallback inside fetchUsageData already handled everything;
        // here we just swallow.
    }
}

main().catch(() => { /* never throw from a detached refresh */ });
