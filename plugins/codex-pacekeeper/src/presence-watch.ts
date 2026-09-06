#!/usr/bin/env bun
/** Independent presence sampler. It never routes a message externally. */
import { loadCodexConfig } from './config';
import { presenceStateFile, readPresenceState, samplePresence } from './presence';

const once = process.argv.includes('--once');
let previous = readPresenceState();

async function main(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const current = samplePresence(loadCodexConfig().config, now, null);
    if (current.state !== 'unknown' && current.state !== previous?.state) {
      process.stdout.write(`[pacekeeper-presence] ${current.state}\n`);
    }
    previous = current;
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
}

if (import.meta.main) {
  main().catch(() => { process.stderr.write(`presence state unavailable at ${presenceStateFile()}\n`); process.exitCode = 1; });
}

