#!/usr/bin/env bun
import { bootstrapConfigIfMissing, loadConfig } from './config';
import { fetchUsageData, getUsageCacheFileAgeSeconds } from './vendor/usage-fetch';

/**
 * Detached refresh script — runs in the background after PostToolUse. Self-gates
 * on cache staleness so spawning every tool call is harmless. The lock file
 * inside fetchUsageData prevents API hammering even if multiple instances race.
 */
async function main(): Promise<void> {
    bootstrapConfigIfMissing();
    const cfg = loadConfig();

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
