// SPDX-License-Identifier: MIT
// Vendored from ccstatusline (https://github.com/sirmalloc/ccstatusline)
// Copyright (c) 2025 Matthew Breedlove. Used under the MIT License.
// Upstream: src/utils/usage-types.ts @ 151521ca6e
// No modifications from upstream.

import { z } from 'zod';

export const FIVE_HOUR_BLOCK_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const UsageErrorSchema = z.enum(['no-credentials', 'timeout', 'rate-limited', 'api-error', 'parse-error']);
export type UsageError = z.infer<typeof UsageErrorSchema>;

export interface UsageData {
    sessionUsage?: number;
    sessionResetAt?: string;
    weeklyUsage?: number;
    weeklyResetAt?: string;
    weeklySonnetUsage?: number;
    weeklySonnetResetAt?: string;
    weeklyOpusUsage?: number;
    weeklyOpusResetAt?: string;
    extraUsageEnabled?: boolean;
    extraUsageLimit?: number;
    extraUsageUsed?: number;
    extraUsageUtilization?: number;
    extraUsageCurrency?: string;
    error?: UsageError;
}

export interface UsageWindowMetrics {
    sessionDurationMs: number;
    elapsedMs: number;
    remainingMs: number;
    elapsedPercent: number;
    remainingPercent: number;
}
