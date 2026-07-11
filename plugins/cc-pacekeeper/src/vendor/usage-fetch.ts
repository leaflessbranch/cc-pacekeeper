// SPDX-License-Identifier: MIT
// Vendored from ccstatusline (https://github.com/sirmalloc/ccstatusline)
// Copyright (c) 2025 Matthew Breedlove. Used under the MIT License.
// Upstream: src/utils/usage-fetch.ts @ 151521ca6e
//
// Modifications:
//   - macOS keychain branch restored (re-added 2026-07; see VENDOR.md).
//   - CACHE_DIR moved to ~/.cache/cc-pacekeeper/.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import { getClaudeConfigDir } from './claude-config-dir';
import type { UsageData, UsageError } from './usage-types';
import { UsageErrorSchema } from './usage-types';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'cc-pacekeeper');
const CACHE_FILE = path.join(CACHE_DIR, 'usage.json');
const LOCK_FILE = path.join(CACHE_DIR, 'usage.lock');
const CACHE_MAX_AGE = 180;
const LOCK_MAX_AGE = 30;
const DEFAULT_RATE_LIMIT_BACKOFF = 300;

type UsageDataField = Exclude<keyof UsageData, 'error'>;

export interface FetchUsageDataOptions { requiredFields?: readonly UsageDataField[] }

const EXTRA_USAGE_DETAIL_FIELDS = new Set<UsageDataField>([
    'extraUsageLimit',
    'extraUsageUsed',
    'extraUsageUtilization'
]);

const WINDOW_RESET_FIELD_SENTINELS: Partial<Record<UsageDataField, UsageDataField>> = {
    sessionResetAt: 'sessionUsage',
    weeklyResetAt: 'weeklyUsage',
    weeklySonnetResetAt: 'weeklySonnetUsage',
    weeklyOpusResetAt: 'weeklyOpusUsage'
};

const UsageCredentialsSchema = z.object({ claudeAiOauth: z.object({ accessToken: z.string().nullable().optional() }).optional() });
const UsageLockErrorSchema = z.enum(['timeout', 'rate-limited', 'parse-error']);
const UsageLockSchema = z.object({
    blockedUntil: z.number(),
    error: UsageLockErrorSchema.optional()
});

const CachedUsageDataSchema = z.object({
    sessionUsage: z.number().nullable().optional(),
    sessionResetAt: z.string().nullable().optional(),
    weeklyUsage: z.number().nullable().optional(),
    weeklyResetAt: z.string().nullable().optional(),
    weeklySonnetUsage: z.number().nullable().optional(),
    weeklySonnetResetAt: z.string().nullable().optional(),
    weeklyOpusUsage: z.number().nullable().optional(),
    weeklyOpusResetAt: z.string().nullable().optional(),
    extraUsageEnabled: z.boolean().nullable().optional(),
    extraUsageLimit: z.number().nullable().optional(),
    extraUsageUsed: z.number().nullable().optional(),
    extraUsageUtilization: z.number().nullable().optional(),
    extraUsageCurrency: z.string().nullable().optional(),
    error: z.string().nullable().optional()
});

const CachedTokenHashSchema = z.object({ tokenHash: z.string().optional() });

const UsageApiBucketSchema = z.object({
    utilization: z.number().nullable().optional(),
    resets_at: z.string().nullable().optional()
}).passthrough().nullable().optional();

type UsageApiBucket = z.infer<typeof UsageApiBucketSchema>;

const UsageApiResponseSchema = z.object({
    five_hour: UsageApiBucketSchema,
    seven_day: UsageApiBucketSchema,
    seven_day_sonnet: UsageApiBucketSchema,
    seven_day_opus: UsageApiBucketSchema,
    extra_usage: z.object({
        is_enabled: z.boolean().nullable().optional(),
        monthly_limit: z.number().nullable().optional(),
        used_credits: z.number().nullable().optional(),
        utilization: z.number().nullable().optional(),
        currency: z.string().nullable().optional()
    }).passthrough().nullable().optional()
}).passthrough();

function getUsageApiBucketUtilization(bucket: UsageApiBucket): number | undefined {
    return bucket === null ? 0 : bucket?.utilization ?? undefined;
}

function parseJsonWithSchema<T>(rawJson: string, schema: z.ZodType<T>): T | null {
    try {
        const parsed = schema.safeParse(JSON.parse(rawJson));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function parseUsageAccessToken(rawJson: string): string | null {
    const parsed = parseJsonWithSchema(rawJson, UsageCredentialsSchema);
    return parsed?.claudeAiOauth?.accessToken ?? null;
}

function parseCachedUsageData(rawJson: string): UsageData | null {
    const parsed = parseJsonWithSchema(rawJson, CachedUsageDataSchema);
    if (!parsed) {
        return null;
    }

    const parsedError = UsageErrorSchema.safeParse(parsed.error);

    return {
        sessionUsage: parsed.sessionUsage ?? undefined,
        sessionResetAt: parsed.sessionResetAt ?? undefined,
        weeklyUsage: parsed.weeklyUsage ?? undefined,
        weeklyResetAt: parsed.weeklyResetAt ?? undefined,
        weeklySonnetUsage: parsed.weeklySonnetUsage ?? undefined,
        weeklySonnetResetAt: parsed.weeklySonnetResetAt ?? undefined,
        weeklyOpusUsage: parsed.weeklyOpusUsage ?? undefined,
        weeklyOpusResetAt: parsed.weeklyOpusResetAt ?? undefined,
        extraUsageEnabled: parsed.extraUsageEnabled ?? undefined,
        extraUsageLimit: parsed.extraUsageLimit ?? undefined,
        extraUsageUsed: parsed.extraUsageUsed ?? undefined,
        extraUsageUtilization: parsed.extraUsageUtilization ?? undefined,
        extraUsageCurrency: parsed.extraUsageCurrency ?? undefined,
        error: parsedError.success ? parsedError.data : undefined
    };
}

function fingerprintUsageToken(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function readCachedTokenHash(rawJson: string): string | undefined {
    return parseJsonWithSchema(rawJson, CachedTokenHashSchema)?.tokenHash;
}

function tokenHashMatches(cachedHash: string | undefined, currentHash: string | null): boolean {
    if (currentHash === null) {
        return true;
    }
    return cachedHash === currentHash;
}

function parseUsageApiResponse(rawJson: string): UsageData | null {
    const parsed = parseJsonWithSchema(rawJson, UsageApiResponseSchema);
    if (!parsed) {
        return null;
    }

    return {
        sessionUsage: getUsageApiBucketUtilization(parsed.five_hour),
        sessionResetAt: parsed.five_hour?.resets_at ?? undefined,
        weeklyUsage: getUsageApiBucketUtilization(parsed.seven_day),
        weeklyResetAt: parsed.seven_day?.resets_at ?? undefined,
        weeklySonnetUsage: getUsageApiBucketUtilization(parsed.seven_day_sonnet),
        weeklySonnetResetAt: parsed.seven_day_sonnet?.resets_at ?? undefined,
        weeklyOpusUsage: getUsageApiBucketUtilization(parsed.seven_day_opus),
        weeklyOpusResetAt: parsed.seven_day_opus?.resets_at ?? undefined,
        extraUsageEnabled: parsed.extra_usage?.is_enabled ?? undefined,
        extraUsageLimit: parsed.extra_usage?.monthly_limit ?? undefined,
        extraUsageUsed: parsed.extra_usage?.used_credits ?? undefined,
        extraUsageUtilization: parsed.extra_usage?.utilization ?? undefined,
        extraUsageCurrency: parsed.extra_usage?.currency ?? undefined
    };
}

let cachedUsageData: UsageData | null = null;
let usageCacheTime = 0;
let usageErrorCacheMaxAge = LOCK_MAX_AGE;

type UsageLockError = z.infer<typeof UsageLockErrorSchema>;

type UsageApiFetchResult = { kind: 'success'; body: string } | { kind: 'rate-limited'; retryAfterSeconds: number } | { kind: 'error' };

function ensureCacheDirExists(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function setCachedUsageError(error: UsageError, now: number, maxAge = LOCK_MAX_AGE): UsageData {
    const errorData: UsageData = { error };
    cachedUsageData = errorData;
    usageCacheTime = now;
    usageErrorCacheMaxAge = maxAge;
    return errorData;
}

function cacheUsageData(data: UsageData, now: number): UsageData {
    cachedUsageData = data;
    usageCacheTime = now;
    usageErrorCacheMaxAge = LOCK_MAX_AGE;
    return data;
}

function hasRequiredUsageField(data: UsageData, field: UsageDataField): boolean {
    if (data[field] !== undefined) {
        return true;
    }

    const windowSentinel = WINDOW_RESET_FIELD_SENTINELS[field];
    if (windowSentinel !== undefined && data[windowSentinel] !== undefined) {
        return true;
    }

    return data.extraUsageEnabled !== undefined && EXTRA_USAGE_DETAIL_FIELDS.has(field);
}

function hasRequiredUsageFields(data: UsageData, requiredFields: readonly UsageDataField[] = []): boolean {
    return requiredFields.every(field => hasRequiredUsageField(data, field));
}

function getStaleUsageOrError(
    error: UsageError,
    now: number,
    currentTokenHash: string | null,
    errorCacheMaxAge = LOCK_MAX_AGE,
    requiredFields: readonly UsageDataField[] = []
): UsageData {
    const stale = readStaleUsageCache(currentTokenHash);
    if (stale && !stale.error && hasRequiredUsageFields(stale, requiredFields)) {
        return cacheUsageData(stale, now);
    }

    return setCachedUsageError(error, now, errorCacheMaxAge);
}

function readUsageTokenFromCredentialsFile(): string | null {
    try {
        const credFile = path.join(getClaudeConfigDir(), '.credentials.json');
        return parseUsageAccessToken(fs.readFileSync(credFile, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * cc-pacekeeper modification: restored macOS Keychain support (upstream had
 * it; the original vendoring stripped it). Claude Code on macOS stores the
 * OAuth credential blob under the Keychain service "Claude Code-credentials"
 * instead of ~/.claude/.credentials.json. `exec` is injectable for tests.
 * NOTE: the first read may show a macOS prompt asking to allow `bun` access
 * to the item — the user should click "Always Allow" once.
 */
export function readUsageTokenFromMacKeychain(
    exec: (cmd: string, args: string[], opts: object) => string | Buffer = execFileSync
): string | null {
    try {
        const out = exec('security',
            ['find-generic-password', '-a', os.userInfo().username, '-w', '-s', 'Claude Code-credentials'],
            { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        return parseUsageAccessToken(String(out).trim());
    } catch {
        return null;
    }
}

export function getUsageToken(): string | null {
    const fromFile = readUsageTokenFromCredentialsFile();
    if (fromFile) return fromFile;
    if (process.platform === 'darwin') return readUsageTokenFromMacKeychain();
    return null;
}

function readStaleUsageCache(currentTokenHash: string | null): UsageData | null {
    try {
        const rawCache = fs.readFileSync(CACHE_FILE, 'utf8');
        if (!tokenHashMatches(readCachedTokenHash(rawCache), currentTokenHash)) {
            return null;
        }
        return parseCachedUsageData(rawCache);
    } catch {
        return null;
    }
}

function writeUsageLock(blockedUntil: number, error: UsageLockError): void {
    try {
        ensureCacheDirExists();
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ blockedUntil, error }));
    } catch {
        // Ignore lock file errors
    }
}

function readActiveUsageLock(now: number): { blockedUntil: number; error: UsageLockError } | null {
    let hasValidJsonLock = false;

    try {
        const parsed = parseJsonWithSchema(fs.readFileSync(LOCK_FILE, 'utf8'), UsageLockSchema);
        if (parsed) {
            hasValidJsonLock = true;
            if (parsed.blockedUntil > now) {
                return {
                    blockedUntil: parsed.blockedUntil,
                    error: parsed.error ?? 'timeout'
                };
            }
            return null;
        }
    } catch {
        // Fall back to legacy mtime-based lock below.
    }

    if (hasValidJsonLock) {
        return null;
    }

    try {
        const lockStat = fs.statSync(LOCK_FILE);
        const lockMtime = Math.floor(lockStat.mtimeMs / 1000);
        const blockedUntil = lockMtime + LOCK_MAX_AGE;
        if (blockedUntil > now) {
            return { blockedUntil, error: 'timeout' };
        }
    } catch {
        // Lock file doesn't exist - OK to proceed
    }

    return null;
}

function parseRetryAfterSeconds(headerValue: string | string[] | undefined, nowMs = Date.now()): number | null {
    const rawValue = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const trimmedValue = rawValue?.trim();
    if (!trimmedValue) {
        return null;
    }

    if (/^\d+$/.test(trimmedValue)) {
        const seconds = Number.parseInt(trimmedValue, 10);
        return seconds > 0 ? seconds : null;
    }

    const retryAtMs = Date.parse(trimmedValue);
    if (Number.isNaN(retryAtMs)) {
        return null;
    }

    const retryAfterSeconds = Math.ceil((retryAtMs - nowMs) / 1000);
    return retryAfterSeconds > 0 ? retryAfterSeconds : null;
}

const USAGE_API_HOST = 'api.anthropic.com';
const USAGE_API_PATH = '/api/oauth/usage';
const USAGE_API_TIMEOUT_MS = 5000;

function getUsageApiProxyUrl(): string | null {
    const proxyUrl = process.env.HTTPS_PROXY?.trim();
    if (proxyUrl === '') {
        return null;
    }
    return proxyUrl ?? null;
}

function getUsageApiRequestOptions(token: string): https.RequestOptions | null {
    const proxyUrl = getUsageApiProxyUrl();

    try {
        return {
            hostname: USAGE_API_HOST,
            path: USAGE_API_PATH,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20'
            },
            timeout: USAGE_API_TIMEOUT_MS,
            ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {})
        };
    } catch {
        return null;
    }
}

async function fetchFromUsageApi(token: string): Promise<UsageApiFetchResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: UsageApiFetchResult) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const requestOptions = getUsageApiRequestOptions(token);
        if (!requestOptions) {
            finish({ kind: 'error' });
            return;
        }

        const request = https.request(requestOptions, (response) => {
            let data = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => { data += chunk; });
            response.on('end', () => {
                if (response.statusCode === 200 && data) {
                    finish({ kind: 'success', body: data });
                    return;
                }
                if (response.statusCode === 429) {
                    finish({
                        kind: 'rate-limited',
                        retryAfterSeconds: parseRetryAfterSeconds(response.headers['retry-after']) ?? DEFAULT_RATE_LIMIT_BACKOFF
                    });
                    return;
                }
                finish({ kind: 'error' });
            });
        });

        request.on('error', () => { finish({ kind: 'error' }); });
        request.on('timeout', () => {
            request.destroy();
            finish({ kind: 'error' });
        });
        request.end();
    });
}

export async function fetchUsageData(options: FetchUsageDataOptions = {}): Promise<UsageData> {
    const now = Math.floor(Date.now() / 1000);
    const requiredFields = options.requiredFields ?? [];

    if (cachedUsageData) {
        const cacheAge = now - usageCacheTime;
        if (!cachedUsageData.error && cacheAge < CACHE_MAX_AGE && hasRequiredUsageFields(cachedUsageData, requiredFields)) {
            return cachedUsageData;
        }
        if (cachedUsageData.error && cacheAge < usageErrorCacheMaxAge) {
            return cachedUsageData;
        }
    }

    const token = getUsageToken();
    const currentTokenHash = token ? fingerprintUsageToken(token) : null;

    try {
        const stat = fs.statSync(CACHE_FILE);
        const fileAge = now - Math.floor(stat.mtimeMs / 1000);
        if (fileAge < CACHE_MAX_AGE) {
            const rawCache = fs.readFileSync(CACHE_FILE, 'utf8');
            const fileData = parseCachedUsageData(rawCache);
            if (fileData && !fileData.error
                && tokenHashMatches(readCachedTokenHash(rawCache), currentTokenHash)
                && hasRequiredUsageFields(fileData, requiredFields)) {
                return cacheUsageData(fileData, now);
            }
        }
    } catch {
        // File doesn't exist or read error - continue to API call
    }

    if (!token) {
        return getStaleUsageOrError('no-credentials', now, currentTokenHash, LOCK_MAX_AGE, requiredFields);
    }

    const activeLock = readActiveUsageLock(now);
    if (activeLock) {
        return getStaleUsageOrError(
            activeLock.error,
            now,
            currentTokenHash,
            Math.max(1, activeLock.blockedUntil - now),
            requiredFields
        );
    }

    writeUsageLock(now + LOCK_MAX_AGE, 'timeout');

    try {
        const response = await fetchFromUsageApi(token);

        if (response.kind === 'rate-limited') {
            writeUsageLock(now + response.retryAfterSeconds, 'rate-limited');
            return getStaleUsageOrError('rate-limited', now, currentTokenHash, response.retryAfterSeconds, requiredFields);
        }

        if (response.kind === 'error') {
            return getStaleUsageOrError('api-error', now, currentTokenHash, LOCK_MAX_AGE, requiredFields);
        }

        const usageData = parseUsageApiResponse(response.body);
        if (!usageData) {
            writeUsageLock(now + LOCK_MAX_AGE, 'parse-error');
            return getStaleUsageOrError('parse-error', now, currentTokenHash, LOCK_MAX_AGE, requiredFields);
        }

        if (usageData.sessionUsage === undefined && usageData.weeklyUsage === undefined) {
            writeUsageLock(now + LOCK_MAX_AGE, 'parse-error');
            return getStaleUsageOrError('parse-error', now, currentTokenHash, LOCK_MAX_AGE, requiredFields);
        }

        try {
            ensureCacheDirExists();
            fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...usageData, tokenHash: currentTokenHash ?? undefined }));
        } catch {
            // Ignore cache write errors
        }

        return cacheUsageData(usageData, now);
    } catch {
        writeUsageLock(now + LOCK_MAX_AGE, 'parse-error');
        return getStaleUsageOrError('parse-error', now, currentTokenHash, LOCK_MAX_AGE, requiredFields);
    }
}

/**
 * Read just the file cache (no API fetch, no lock check). Used by tick.ts on
 * hot paths where we never want to block on the network. Returns null if the
 * cache is missing or unparseable.
 */
export function readUsageCacheFile(): UsageData | null {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        return parseCachedUsageData(raw);
    } catch {
        return null;
    }
}

export function getUsageCacheFileAgeSeconds(): number | null {
    try {
        const stat = fs.statSync(CACHE_FILE);
        return Math.floor((Date.now() - stat.mtimeMs) / 1000);
    } catch {
        return null;
    }
}

export const USAGE_CACHE_DIR = CACHE_DIR;
export const USAGE_CACHE_FILE = CACHE_FILE;
export const USAGE_CACHE_MAX_AGE_SECONDS = CACHE_MAX_AGE;
