import * as fs from 'fs';
import * as path from 'path';
import { configDir, configFile, configValidationIssues, loadConfig } from './config';
import { crashLogFile, readCrashLog } from './crash-log';
import { readContextTokens, readMostRecentModel } from './ctx-tokens';
import { MODEL_INFO_CACHE_FILE, resolveModelInfoAuth } from './model-info';
import { stateDir } from './state';
import { USAGE_ERROR_HINTS } from './thresholds';
import { getClaudeConfigDir } from './vendor/claude-config-dir';
import { DEFAULT_CONTEXT_WINDOW_SIZE } from './vendor/model-context';
import { fetchUsageData, getUsageCacheFileAgeSeconds, getUsageToken, readUsageCacheFile, USAGE_CACHE_FILE } from './vendor/usage-fetch';

export interface DoctorCheck {
    name: string;
    severity: 'ok' | 'warn' | 'fail';
    detail: string;
}

const GLYPH: Record<DoctorCheck['severity'], string> = { ok: '✓', warn: '⚠', fail: '✗' };

export function formatDoctorReport(checks: DoctorCheck[]): string {
    return checks.map(c => `${GLYPH[c.severity]} ${c.name} — ${c.detail}`).join('\n');
}

function writableDir(dir: string): boolean {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.doctor-probe');
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe);
        return true;
    } catch {
        return false;
    }
}

export async function runDoctor(opts: { network?: boolean; transcript?: string } = {}): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const cfg = loadConfig();

    // 1. Runtime. If this code runs at all, Bun resolved the deps; report versions.
    const bunV = (process.versions as Record<string, string | undefined>).bun;
    checks.push(bunV
        ? { name: 'runtime', severity: 'ok', detail: `bun ${bunV}` }
        : { name: 'runtime', severity: 'warn', detail: `not running under bun (${process.release.name} ${process.version}) — the shims expect bun` });

    // 2. Credentials.
    const credFile = path.join(getClaudeConfigDir(), '.credentials.json');
    const token = getUsageToken();
    if (token) {
        const source = fs.existsSync(credFile) ? credFile : 'macOS Keychain (service "Claude Code-credentials")';
        checks.push({ name: 'credentials', severity: 'ok', detail: `OAuth token found via ${source}` });
    } else {
        const apiKeyAuth = resolveModelInfoAuth(process.env, () => token);
        checks.push({
            name: 'credentials', severity: apiKeyAuth ? 'warn' : 'fail',
            detail: apiKeyAuth
                ? 'no OAuth token (5h/weekly meters off) but ANTHROPIC_API_KEY present — context windows still resolve'
                : `no OAuth token and no ANTHROPIC_API_KEY. ${USAGE_ERROR_HINTS['no-credentials']}`
        });
    }

    // 3. Usage cache (+ optional live fetch).
    const age = getUsageCacheFileAgeSeconds();
    const cached = readUsageCacheFile();
    if (opts.network && token) {
        const live = await fetchUsageData();
        checks.push(live.error
            ? { name: 'usage cache', severity: 'warn', detail: `live fetch failed: ${live.error} — ${USAGE_ERROR_HINTS[live.error]}` }
            : { name: 'usage cache', severity: 'ok', detail: `live fetch ok (5h ${live.sessionUsage ?? '?'}%, week ${live.weeklyUsage ?? '?'}%)` });
    } else if (cached && age !== null) {
        // cached.error is never written to disk today — defensive display only.
        checks.push({ name: 'usage cache', severity: 'ok', detail: `present, ${age}s old${cached.error ? `, last error: ${cached.error}` : ''}` });
    } else if (age !== null && cached === null) {
        checks.push({ name: 'usage cache', severity: 'fail', detail: `present (${age}s old) but unparseable — possible format drift after a Claude Code update. Delete it to re-fetch: rm ${USAGE_CACHE_FILE}` });
    } else {
        checks.push({ name: 'usage cache', severity: token ? 'warn' : 'fail', detail: 'never written — no successful usage fetch yet (run `doctor --network` to try one now)' });
    }

    // 4. Config validity.
    const issues = configValidationIssues();
    if (issues === null) checks.push({ name: 'config', severity: 'ok', detail: `no ${configFile()} — defaults in use` });
    else if (issues.length === 0) checks.push({ name: 'config', severity: 'ok', detail: `${configFile()} valid` });
    else checks.push({ name: 'config', severity: 'fail', detail: `invalid (ALL settings falling back to defaults): ${issues.join('; ')}` });

    // 5. Context-window override (improvement 6b: the override masks per-model windows).
    checks.push(cfg.context_window_size !== DEFAULT_CONTEXT_WINDOW_SIZE
        ? { name: 'context window override', severity: 'warn', detail: `context_window_size=${cfg.context_window_size} overrides EVERY model's fetched window — ctx% is wrong for models with a different window. Remove it from ${configFile()} unless intentional. (The default ${DEFAULT_CONTEXT_WINDOW_SIZE} means "no override".)` }
        : { name: 'context window override', severity: 'ok', detail: 'none — per-model windows from the API apply' });

    // 6. Model-info cache.
    try {
        const entries = Object.entries(JSON.parse(fs.readFileSync(MODEL_INFO_CACHE_FILE, 'utf8')) as Record<string, { max_input_tokens: number }>);
        checks.push({ name: 'model-info cache', severity: 'ok', detail: entries.length === 0 ? 'empty' : entries.map(([id, e]) => `${id}: ${e.max_input_tokens}`).join(', ') });
    } catch {
        checks.push({ name: 'model-info cache', severity: 'warn', detail: 'never written — context windows fall back to 200k until a model fetch succeeds' });
    }

    // 7. State dirs writable.
    const dirs = [stateDir(), configDir()];
    const bad = dirs.filter(d => !writableDir(d));
    checks.push(bad.length === 0
        ? { name: 'state dirs', severity: 'ok', detail: dirs.join(', ') }
        : { name: 'state dirs', severity: 'fail', detail: `not writable: ${bad.join(', ')}` });

    // 8. Hook crashes (recorded by entrypoint catch handlers — see crash-log.ts).
    const crashes = readCrashLog();
    checks.push(crashes
        ? { name: 'hook crashes', severity: 'warn', detail: `${crashes.count} recorded; last: ${crashes.lastScript} at ${crashes.lastAt} — ${crashes.lastMessage}. Clear with: rm ${crashLogFile()}` }
        : { name: 'hook crashes', severity: 'ok', detail: 'none recorded' });

    // 9. Optional transcript-format probe: validates that Claude Code's
    //    transcript JSONL still has the shape our readers depend on.
    if (opts.transcript !== undefined) {
        const model = readMostRecentModel(opts.transcript);
        const tokens = readContextTokens(opts.transcript);
        if (model !== null || tokens !== null) {
            checks.push({ name: 'transcript format', severity: 'ok', detail: `parsed (model: ${model ?? 'n/a'}, ctx tokens: ${tokens?.contextLength ?? 'n/a'})` });
        } else {
            checks.push({ name: 'transcript format', severity: 'fail', detail: `could not extract model or usage from ${opts.transcript} — the transcript shape may have drifted (or the file is missing/empty). Meters relying on it degrade to defaults.` });
        }
    }

    // 10. Version skew: this copy vs the plugin manager's installed record.
    //     Mismatch usually means "update applied but Claude Code not restarted"
    //     or "running a dev checkout while an older install is active".
    try {
        const ownPkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string };
        const installedRaw = JSON.parse(fs.readFileSync(path.join(getClaudeConfigDir(), 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, Array<{ version?: string }>> };
        const entry = Object.entries(installedRaw.plugins ?? {}).find(([k]) => k.startsWith('cc-pacekeeper@'));
        const installedVersion = entry?.[1]?.[0]?.version;
        if (!ownPkg.version || !installedVersion) {
            checks.push({ name: 'plugin version', severity: 'ok', detail: `this copy: ${ownPkg.version ?? '?'} (no installed record — dev checkout?)` });
        } else if (ownPkg.version === installedVersion) {
            checks.push({ name: 'plugin version', severity: 'ok', detail: `${ownPkg.version} (installed record matches)` });
        } else {
            checks.push({ name: 'plugin version', severity: 'warn', detail: `this copy is ${ownPkg.version} but the installed record says ${installedVersion} — restart Claude Code (or run \`claude plugin update cc-pacekeeper\`) so the running hooks match.` });
        }
    } catch {
        checks.push({ name: 'plugin version', severity: 'ok', detail: 'no installed-plugins record readable (dev checkout or non-standard install)' });
    }

    return checks;
}
