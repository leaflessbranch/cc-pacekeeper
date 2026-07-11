import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { z } from 'zod';
import { getUsageToken } from './vendor/usage-fetch';

/**
 * Per-model info cache. The only field we actually need today is
 * `max_input_tokens` — the authoritative context window size returned by
 * Anthropic's `GET /v1/models/{model_id}` endpoint. A model's window size
 * is immutable for the life of the id, so the cache is functionally eternal;
 * we still timestamp entries in case Anthropic ever revises one and the
 * user wants to purge with a single `rm`.
 */

const CACHE_DIR = path.join(os.homedir(), '.cache', 'cc-pacekeeper');
const CACHE_FILE = path.join(CACHE_DIR, 'model-info.json');
const API_HOST = 'api.anthropic.com';
const API_TIMEOUT_MS = 4000;

const ModelInfoEntrySchema = z.object({
    max_input_tokens: z.number().int().positive(),
    fetched_at: z.string()
});

const ModelInfoFileSchema = z.record(z.string(), ModelInfoEntrySchema);

type ModelInfoFile = z.infer<typeof ModelInfoFileSchema>;

function readCache(): ModelInfoFile {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const parsed = ModelInfoFileSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

function writeCache(data: ModelInfoFile): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
    } catch {
        // Best-effort.
    }
}

/**
 * Synchronous cache read. Returns `max_input_tokens` for `modelId` if a
 * cached entry exists, else null. The hot-path hook calls this before
 * deciding to kick off an async refetch.
 */
export function readCachedMaxInputTokens(modelId: string): number | null {
    const cache = readCache();
    const entry = cache[modelId];
    return entry ? entry.max_input_tokens : null;
}

const ModelApiResponseSchema = z.object({
    max_input_tokens: z.number().int().positive()
}).passthrough();

type FetchResult = { kind: 'success'; maxInputTokens: number } | { kind: 'error' };

export type ModelInfoAuth = { kind: 'oauth'; token: string } | { kind: 'api-key'; key: string };

/** OAuth (subscription) first; ANTHROPIC_API_KEY as fallback so API-key-only
 *  setups still resolve real context windows instead of the 200k default. */
export function resolveModelInfoAuth(
    env: NodeJS.ProcessEnv = process.env,
    getToken: () => string | null = getUsageToken
): ModelInfoAuth | null {
    const token = getToken();
    if (token) return { kind: 'oauth', token };
    const key = env.ANTHROPIC_API_KEY?.trim();
    return key ? { kind: 'api-key', key } : null;
}

export function authHeaders(auth: ModelInfoAuth): Record<string, string> {
    if (auth.kind === 'oauth') {
        return {
            'Authorization': `Bearer ${auth.token}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20'
        };
    }
    return { 'x-api-key': auth.key, 'anthropic-version': '2023-06-01' };
}

async function fetchModelInfoOnce(modelId: string, auth: ModelInfoAuth): Promise<FetchResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v: FetchResult) => { if (!settled) { settled = true; resolve(v); } };
        const proxyUrl = process.env.HTTPS_PROXY?.trim() || null;
        const req = https.request({
            hostname: API_HOST,
            path: `/v1/models/${encodeURIComponent(modelId)}`,
            method: 'GET',
            headers: authHeaders(auth),
            timeout: API_TIMEOUT_MS,
            ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {})
        }, (response) => {
            let data = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => { data += chunk; });
            response.on('end', () => {
                if (response.statusCode !== 200 || !data) { finish({ kind: 'error' }); return; }
                try {
                    const parsed = ModelApiResponseSchema.safeParse(JSON.parse(data));
                    if (!parsed.success) { finish({ kind: 'error' }); return; }
                    finish({ kind: 'success', maxInputTokens: parsed.data.max_input_tokens });
                } catch {
                    finish({ kind: 'error' });
                }
            });
        });
        req.on('error', () => finish({ kind: 'error' }));
        req.on('timeout', () => { req.destroy(); finish({ kind: 'error' }); });
        req.end();
    });
}

/**
 * Fetch and cache `max_input_tokens` for `modelId`. Returns the value on
 * success, null on failure (no creds, network error, unknown id, etc.).
 * Safe to call from a detached background script.
 */
export async function fetchAndCacheMaxInputTokens(modelId: string): Promise<number | null> {
    const auth = resolveModelInfoAuth();
    if (!auth) return null;
    const result = await fetchModelInfoOnce(modelId, auth);
    if (result.kind !== 'success') return null;
    const cache = readCache();
    cache[modelId] = {
        max_input_tokens: result.maxInputTokens,
        fetched_at: new Date().toISOString()
    };
    writeCache(cache);
    return result.maxInputTokens;
}

export const MODEL_INFO_CACHE_FILE = CACHE_FILE;
