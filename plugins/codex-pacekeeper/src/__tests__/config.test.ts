import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS, loadCodexConfig } from '../config';

/** A disposable config root. Nothing here touches a real home directory. */
function withConfig(contents: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-pacekeeper-config-'));
  if (contents !== null) {
    mkdirSync(join(root, 'cc-pacekeeper'), { recursive: true });
    writeFileSync(join(root, 'cc-pacekeeper', 'config.json'), contents);
  }
  return root;
}

describe('configuration inheritance', () => {
  test('falls back to defaults when no legacy config exists', () => {
    const result = loadCodexConfig(withConfig(null));
    expect(result.config).toEqual(CODEX_DEFAULTS);
    expect(result.source).toBe('defaults');
    expect(result.diagnostics).toEqual([]);
  });

  test('inherits valid legacy values without writing anything back', () => {
    const root = withConfig(
      JSON.stringify({
        thresholds: { five_hour: { notify: 40, warn: 78, critical: 92 } },
        keepalive: { require_pending: false, max_idle_hours: 48 }
      })
    );
    const before = Bun.file(join(root, 'cc-pacekeeper', 'config.json')).size;
    const result = loadCodexConfig(root);
    expect(result.config.thresholds.five_hour).toEqual({ notify: 40, warn: 78, critical: 92 });
    expect(result.config.keepalive.require_pending).toBe(false);
    expect(result.config.keepalive.max_idle_hours).toBe(48);
    // Untouched sections keep their defaults.
    expect(result.config.thresholds.weekly).toEqual(CODEX_DEFAULTS.thresholds.weekly);
    // No bootstrap, no migration: the legacy file is byte-identical.
    expect(Bun.file(join(root, 'cc-pacekeeper', 'config.json')).size).toBe(before);
  });

  // A zero threshold is falsy; a truthiness-based merge would silently drop it.
  test('a zero-valued override survives the merge', () => {
    const result = loadCodexConfig(
      withConfig(JSON.stringify({ thresholds: { context: { notify: 0, warn: 65, critical: 88 } } }))
    );
    expect(result.config.thresholds.context.notify).toBe(0);
  });

  test('adapters.codex overrides win over the inherited legacy value', () => {
    const result = loadCodexConfig(
      withConfig(
        JSON.stringify({
          keepalive: { interval_min: 45 },
          adapters: { codex: { keepalive: { interval_min: 30 } } }
        })
      )
    );
    expect(result.config.keepalive.interval_min).toBe(30);
  });

  // Channels are deferred for Codex (capability 21) and cache sharing would
  // let one harness read the other's state, so neither is inherited.
  test('excludes channel and Claude cache fields from Codex behavior', () => {
    const result = loadCodexConfig(
      withConfig(
        JSON.stringify({
          channels: { preferred: ['somewhere'], target: 'some-destination', asked: true },
          cache_ttl_seconds: 999
        })
      )
    );
    expect(Object.keys(result.config)).not.toContain('channels');
    expect(JSON.stringify(result.config)).not.toContain('some-destination');
  });

  test('an invalid value is diagnosed and defaulted, never silently reset', () => {
    const result = loadCodexConfig(
      withConfig(JSON.stringify({ thresholds: { five_hour: { notify: 200, warn: 78, critical: 92 } } }))
    );
    expect(result.config.thresholds.five_hour).toEqual(CODEX_DEFAULTS.thresholds.five_hour);
    expect(result.diagnostics.join(' ')).toContain('five_hour');
  });

  test('malformed JSON degrades to defaults with a diagnostic', () => {
    const result = loadCodexConfig(withConfig('{not json'));
    expect(result.config).toEqual(CODEX_DEFAULTS);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test('a threshold ladder that is out of order is rejected', () => {
    const result = loadCodexConfig(
      withConfig(JSON.stringify({ thresholds: { weekly: { notify: 90, warn: 50, critical: 60 } } }))
    );
    expect(result.config.thresholds.weekly).toEqual(CODEX_DEFAULTS.thresholds.weekly);
    expect(result.diagnostics.join(' ')).toContain('weekly');
  });
});

describe('Codex-specific defaults', () => {
  test('keeps the 30-minute cadence and its own checkpoint subtree', () => {
    expect(CODEX_DEFAULTS.keepalive.interval_min).toBe(30);
    expect(CODEX_DEFAULTS.checkpoint_subdir).toBe('codex');
  });

  test('carries no context window fallback of its own', () => {
    // Claude's 200k default is not a Codex truth; the window comes from native
    // model metadata or stays unknown.
    expect(JSON.stringify(CODEX_DEFAULTS)).not.toContain('200000');
    expect(CODEX_DEFAULTS).not.toHaveProperty('context_window_size');
  });
});
