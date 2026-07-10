import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let TMP_HOME = '';
const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
    TMP_HOME = path.join(os.tmpdir(), `cc-pacekeeper-cfg-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(TMP_HOME, { recursive: true });
    process.env.HOME = TMP_HOME;
});

afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('loadConfig', () => {
    test('returns defaults when no file exists', async () => {
        const { loadConfig, DEFAULT_CONFIG } = await import('../config');
        expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    });

    test('merges partial user config with defaults', async () => {
        const { configFile, loadConfig } = await import('../config');
        const file = configFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            thresholds: { context: { notify: 50, warn: 70, critical: 85 } },
            debounce_seconds: 30
        }));
        const cfg = loadConfig();
        expect(cfg.thresholds.context).toEqual({ notify: 50, warn: 70, critical: 85 });
        expect(cfg.thresholds.five_hour).toEqual({ notify: 70, warn: 85, critical: 95 });
        expect(cfg.debounce_seconds).toBe(30);
        expect(cfg.context_window_size).toBe(200_000);
    });

    test('falls back to defaults on invalid JSON', async () => {
        const { configFile, loadConfig, DEFAULT_CONFIG } = await import('../config');
        const file = configFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'this is not json{{');
        expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    });

    test('falls back to defaults on schema violation and warns', async () => {
        const { configFile, loadConfig, DEFAULT_CONFIG } = await import('../config');
        const file = configFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            thresholds: { context: { notify: -50, warn: 70, critical: 85 } }
        }));
        const errs: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => { errs.push(args.join(' ')); };
        try {
            expect(loadConfig()).toEqual(DEFAULT_CONFIG);
        } finally {
            console.error = original;
        }
        // The invalid key is named, so a one-value typo doesn't fail silently.
        expect(errs.some(e => e.includes('thresholds.context.notify'))).toBe(true);
    });

    test('keepalive.max_idle_hours defaults to 12', async () => {
        const { loadConfig } = await import('../config');
        expect(loadConfig().keepalive.max_idle_hours).toBe(12);
    });

    test('keepalive.max_idle_hours can be overridden', async () => {
        const { configFile, loadConfig } = await import('../config');
        const file = configFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ keepalive: { max_idle_hours: 2 } }));
        const cfg = loadConfig();
        expect(cfg.keepalive.max_idle_hours).toBe(2);
        expect(cfg.keepalive.interval_min).toBe(30);
    });

    test('auto block defaults are upgraded into pre-0.4 configs', async () => {
        const { configFile, loadConfig } = await import('../config');
        const file = configFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // A config written before the auto block existed.
        fs.writeFileSync(file, JSON.stringify({ debounce_seconds: 45 }));
        const cfg = loadConfig();
        expect(cfg.auto).toEqual({ enabled: true, five_hour_pct: 85, subagent_pause_pct: 75, wake_delay_min: 3 });
        expect(cfg.debounce_seconds).toBe(45);
    });

    test('auto block partial override merges with defaults', async () => {
        const { configFile, loadConfig } = await import('../config');
        const file = configFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ auto: { enabled: false, subagent_pause_pct: 60 } }));
        const cfg = loadConfig();
        expect(cfg.auto.enabled).toBe(false);
        expect(cfg.auto.subagent_pause_pct).toBe(60);
        expect(cfg.auto.five_hour_pct).toBe(85);
        expect(cfg.auto.wake_delay_min).toBe(3);
    });

    test('bootstrapConfigIfMissing creates default file', async () => {
        const { bootstrapConfigIfMissing, configFile } = await import('../config');
        const file = configFile();
        expect(fs.existsSync(file)).toBe(false);
        bootstrapConfigIfMissing();
        expect(fs.existsSync(file)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(parsed.thresholds.context.notify).toBe(60);
    });
});

describe('isProjectDenied', () => {
    test('matches exact and prefix', async () => {
        const { isProjectDenied, DEFAULT_CONFIG } = await import('../config');
        const cfg = { ...DEFAULT_CONFIG, project_denylist: ['/home/u/scratch'] };
        expect(isProjectDenied('/home/u/scratch', cfg)).toBe(true);
        expect(isProjectDenied('/home/u/scratch/sub', cfg)).toBe(true);
        expect(isProjectDenied('/home/u/scratchpad', cfg)).toBe(false);
        expect(isProjectDenied('/home/u/other', cfg)).toBe(false);
    });
});
