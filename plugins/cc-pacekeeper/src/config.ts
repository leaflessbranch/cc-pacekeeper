import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

const ThresholdLevelsSchema = z.object({
    notify: z.number().min(0).max(100),
    warn: z.number().min(0).max(100),
    critical: z.number().min(0).max(100)
});

const ConfigSchema = z.object({
    thresholds: z.object({
        context: ThresholdLevelsSchema,
        five_hour: ThresholdLevelsSchema,
        weekly: ThresholdLevelsSchema
    }),
    debounce_seconds: z.number().int().nonnegative(),
    cache_ttl_seconds: z.number().int().positive(),
    context_window_size: z.number().int().positive(),
    project_denylist: z.array(z.string()),
    checkpoint_dir_name: z.string(),
    checkpoint: z.object({
        stale_after_days: z.number().int().positive(),
        archive_keep_days: z.number().int().positive()
    }),
    share_ccstatusline_cache: z.boolean()
});

export type Config = z.infer<typeof ConfigSchema>;
export type ThresholdLevels = z.infer<typeof ThresholdLevelsSchema>;

export const DEFAULT_CONFIG: Config = {
    thresholds: {
        context:   { notify: 60, warn: 75, critical: 90 },
        five_hour: { notify: 70, warn: 85, critical: 95 },
        weekly:    { notify: 50, warn: 70, critical: 85 }
    },
    debounce_seconds: 60,
    cache_ttl_seconds: 180,
    context_window_size: 200_000,
    project_denylist: [],
    checkpoint_dir_name: '.claude-checkpoints',
    checkpoint: {
        stale_after_days: 14,
        archive_keep_days: 90
    },
    share_ccstatusline_cache: false
};

function home(): string {
    return process.env.HOME ?? os.homedir();
}

export function configDir(): string {
    return path.join(home(), '.config', 'cc-pacekeeper');
}

export function configFile(): string {
    return path.join(configDir(), 'config.json');
}

// Back-compat re-exports as getter-style constants for tests/consumers.
export const CONFIG_DIR: string = configDir();
export const CONFIG_FILE: string = configFile();

function deepMergeDefaults<T>(value: unknown, defaults: T): T {
    if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
        return (value === undefined ? defaults : value as T);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return defaults;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(defaults as Record<string, unknown>)) {
        out[key] = deepMergeDefaults(
            (value as Record<string, unknown>)[key],
            (defaults as Record<string, unknown>)[key]
        );
    }
    // Preserve unknown user keys (forward-compat).
    for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!(key in out)) {
            out[key] = (value as Record<string, unknown>)[key];
        }
    }
    return out as T;
}

export function loadConfig(): Config {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    } catch {
        return DEFAULT_CONFIG;
    }
    const merged = deepMergeDefaults(raw, DEFAULT_CONFIG);
    const parsed = ConfigSchema.safeParse(merged);
    return parsed.success ? parsed.data : DEFAULT_CONFIG;
}

export function bootstrapConfigIfMissing(): void {
    const file = configFile();
    if (fs.existsSync(file)) return;
    try {
        fs.mkdirSync(configDir(), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2));
    } catch {
        // Non-fatal; loadConfig falls back to defaults.
    }
}

export function isProjectDenied(cwd: string, cfg: Config): boolean {
    return cfg.project_denylist.some(prefix => cwd === prefix || cwd.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'));
}
