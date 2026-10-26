/**
 * Codex configuration.
 *
 * The existing `cc-pacekeeper` config is read as a COMPATIBILITY INPUT only:
 * never written, bootstrapped or migrated, so a Codex install cannot change
 * what the Claude runtime reads. Precedence is defaults, then valid legacy
 * values, then `adapters.codex` overrides.
 *
 * Invalid values are diagnosed and fall back to the default for that field.
 * They are never silently accepted, and a single bad field never discards the
 * rest of the file.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

const ThresholdLevelsSchema = z
  .object({
    notify: z.number().min(0).max(100),
    warn: z.number().min(0).max(100),
    critical: z.number().min(0).max(100)
  })
  // A ladder that is out of order would make a higher meter reading report a
  // lower severity, so it is rejected rather than sorted into shape.
  .refine((levels) => levels.notify <= levels.warn && levels.warn <= levels.critical, {
    message: 'threshold levels must be ordered notify <= warn <= critical'
  });

const CodexConfigSchema = z.object({
  thresholds: z.object({
    context: ThresholdLevelsSchema,
    five_hour: ThresholdLevelsSchema,
    weekly: ThresholdLevelsSchema
  }),
  debounce_seconds: z.number().int().nonnegative(),
  usage_freshness_seconds: z.number().int().positive(),
  checkpoint_dir_name: z.string().min(1).refine((value) => isSafeSegment(value), {
    message: 'checkpoint directory name must be a single relative path segment'
  }),
  /** Codex checkpoints live in their own subtree of the shared root. */
  checkpoint_subdir: z.string().min(1).refine((value) => isSafeSegment(value), {
    message: 'checkpoint subdir must be a single relative path segment'
  }),
  checkpoint: z.object({
    stale_after_days: z.number().int().positive(),
    archive_keep_days: z.number().int().positive()
  }),
  time: z.object({
    idle_threshold_min: z.number().int().positive(),
    tool_tick_min: z.number().int().positive()
  }),
  keepalive: z.object({
    enabled: z.boolean(),
    interval_min: z.number().int().positive(),
    max_idle_hours: z.number().positive(),
    require_pending: z.boolean()
  }),
  bridge: z.object({
    enabled: z.boolean(),
    max_wait_min: z.number().int().positive()
  }),
  auto: z.object({
    enabled: z.boolean(),
    five_hour_pct: z.number().min(0).max(100),
    subagent_pause_pct: z.number().min(0).max(100),
    wake_delay_min: z.number().int().positive()
  }),
  presence: z.object({
    enabled: z.boolean(),
    idle_minutes: z.number().int().positive(),
    probes: z.object({
      tmux: z.boolean(),
      tty: z.boolean(),
      ssh: z.boolean(),
      loginctl: z.boolean()
    })
  })
});

export type CodexConfig = z.infer<typeof CodexConfigSchema>;

/**
 * Defaults match the shipped Claude values where the behavior is the same, so
 * a shared scenario means the same thing on both sides. Two deliberately
 * differ: there is no `context_window_size` fallback, because Claude's 200,000
 * is not a Codex truth and the window must come from native model metadata or
 * stay unknown; and `checkpoint_subdir` isolates Codex lanes.
 */
export const CODEX_DEFAULTS: CodexConfig = {
  thresholds: {
    context: { notify: 60, warn: 75, critical: 90 },
    five_hour: { notify: 70, warn: 85, critical: 95 },
    weekly: { notify: 50, warn: 70, critical: 85 }
  },
  debounce_seconds: 60,
  usage_freshness_seconds: 180,
  checkpoint_dir_name: '.claude-checkpoints',
  checkpoint_subdir: 'codex',
  checkpoint: { stale_after_days: 14, archive_keep_days: 90 },
  time: { idle_threshold_min: 10, tool_tick_min: 5 },
  keepalive: { enabled: true, interval_min: 30, max_idle_hours: 12, require_pending: true },
  bridge: { enabled: true, max_wait_min: 60 },
  auto: { enabled: true, five_hour_pct: 85, subagent_pause_pct: 75, wake_delay_min: 3 },
  presence: {
    enabled: true,
    idle_minutes: 10,
    probes: { tmux: true, tty: true, ssh: true, loginctl: true }
  }
};

function isSafeSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !path.isAbsolute(value)
    && !value.includes('/')
    && !value.includes('\\');
}

/**
 * Fields never inherited from the legacy config. `channels` is deferred for
 * Codex (capability 21) and holds a user's private destination; the Claude
 * cache settings would let one harness read the other's state.
 */
const NOT_INHERITED = new Set(['channels', 'cache_ttl_seconds', 'context_window_size', 'adapters']);

export type ConfigSource = 'defaults' | 'legacy';

export interface LoadedCodexConfig {
  config: CodexConfig;
  source: ConfigSource;
  diagnostics: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge `overlay` onto `base`, treating only plain objects as mergeable. */
function merge(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    // `undefined` means "not specified", but an explicit null or 0 is a value.
    if (value === undefined) continue;
    result[key] = key in base ? merge(base[key], value) : value;
  }
  return result;
}

export function legacyConfigPath(configHome: string): string {
  return path.join(configHome, 'cc-pacekeeper', 'config.json');
}

function defaultConfigHome(): string {
  return process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
}

function cloneConfig(config: CodexConfig): CodexConfig {
  return JSON.parse(JSON.stringify(config)) as CodexConfig;
}

/**
 * Try the whole candidate; if it fails, re-check each top-level section so one
 * bad field costs only its own section rather than the entire file.
 */
function validate(candidate: unknown, diagnostics: string[]): CodexConfig {
  const whole = CodexConfigSchema.safeParse(candidate);
  if (whole.success) return whole.data;

  const result = cloneConfig(CODEX_DEFAULTS) as unknown as Record<string, unknown>;
  const sections = isPlainObject(candidate) ? candidate : {};

  const addIssues = (probe: z.SafeParseError<unknown>, fallbackPath: string): void => {
    for (const issue of probe.error.issues) {
      const rendered = issue.path.length > 0 ? issue.path.join('.') : fallbackPath;
      const line = `${rendered}: ${issue.message}`;
      if (!diagnostics.includes(line)) diagnostics.push(line);
    }
  };

  const setPath = (target: Record<string, unknown>, pathParts: string[], value: unknown): void => {
    let cursor: Record<string, unknown> = target;
    for (const part of pathParts.slice(0, -1)) {
      const next = cursor[part];
      if (!isPlainObject(next)) cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    const last = pathParts[pathParts.length - 1];
    if (last !== undefined) cursor[last] = value;
  };

  const candidateAt = (pathParts: string[]): unknown => {
    let value: unknown = candidate;
    for (const part of pathParts) {
      if (!isPlainObject(value)) return undefined;
      value = value[part];
    }
    return value;
  };

  const defaultAt = (pathParts: string[]): unknown => {
    let value: unknown = CODEX_DEFAULTS;
    for (const part of pathParts) {
      if (!isPlainObject(value)) return undefined;
      value = value[part];
    }
    return value;
  };

  const copyIfValid = (pathParts: string[]): void => {
    const value = candidateAt(pathParts);
    if (value === undefined) return;
    const probeCandidate = cloneConfig(CODEX_DEFAULTS) as unknown as Record<string, unknown>;
    setPath(probeCandidate, pathParts, value);
    const probe = CodexConfigSchema.safeParse(probeCandidate);
    if (probe.success) {
      setPath(result, pathParts, value);
      return;
    }
    const defaultValue = defaultAt(pathParts);
    // Threshold ladders are atomic: an out-of-order triple must not be
    // partially accepted as a different policy. Other nested objects can be
    // safely decomposed to preserve valid sibling fields.
    if (pathParts[0] === 'thresholds' && pathParts.length === 2) {
      addIssues(probe, pathParts.join('.'));
      if (defaultValue !== undefined) setPath(result, pathParts, defaultValue);
      return;
    }
    if (isPlainObject(value) && isPlainObject(defaultValue)) {
      for (const child of Object.keys(defaultValue)) copyIfValid([...pathParts, child]);
      return;
    }
    addIssues(probe, pathParts.join('.'));
  };

  for (const key of Object.keys(CODEX_DEFAULTS)) {
    if (!(key in sections)) continue;
    copyIfValid([key]);
  }
  const merged = CodexConfigSchema.safeParse(result);
  if (merged.success) return merged.data;
  diagnostics.push('configuration could not be validated; using defaults');
  return CODEX_DEFAULTS;
}

/**
 * Load the effective Codex configuration. `configHome` defaults to the real
 * XDG config directory; tests pass a disposable one.
 */
export function loadCodexConfig(configHome: string = defaultConfigHome()): LoadedCodexConfig {
  const diagnostics: string[] = [];
  const file = legacyConfigPath(configHome);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      diagnostics.push(
        `legacy config could not be read as JSON: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
    return { config: CODEX_DEFAULTS, source: 'defaults', diagnostics };
  }

  if (!isPlainObject(raw)) {
    diagnostics.push(`${file} is not a JSON object`);
    return { config: CODEX_DEFAULTS, source: 'defaults', diagnostics };
  }

  const inherited: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (NOT_INHERITED.has(key)) continue;
    if (!(key in CODEX_DEFAULTS)) continue;
    inherited[key] = value;
  }

  const adapters = raw['adapters'];
  let codexOverrides: Record<string, unknown> = {};
  if (adapters !== undefined) {
    if (!isPlainObject(adapters)) {
      diagnostics.push('adapters: expected an object; Codex overrides were ignored');
    } else if (adapters['codex'] !== undefined) {
      if (isPlainObject(adapters['codex'])) codexOverrides = adapters['codex'];
      else diagnostics.push('adapters.codex: expected an object; Codex overrides were ignored');
    }
  }

  const candidate = merge(merge(CODEX_DEFAULTS, inherited), codexOverrides);
  return { config: validate(candidate, diagnostics), source: 'legacy', diagnostics };
}
