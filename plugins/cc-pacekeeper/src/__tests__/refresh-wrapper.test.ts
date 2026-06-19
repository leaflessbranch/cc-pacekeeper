import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WRAPPER = path.join(import.meta.dir, '..', '..', 'bin', 'pacekeeper-refresh');

/**
 * Regression guard for the bug where the PostToolUse wrapper discarded its
 * stdin (`cat > /dev/null` + `< /dev/null`), starving refresh.ts of the
 * model / transcript_path it needs to populate the per-model context-window
 * cache. With no payload the model cache never filled, so any model first
 * seen mid-session stayed pinned to the 200k fallback and over-reported
 * context %.
 *
 * We don't want the test to hit the network, so we shim the detached child:
 * the wrapper invokes `bun run <DIR>/../src/refresh.ts`, so we run it with a
 * cwd-independent override that captures whatever stdin the wrapper forwards.
 */
describe('pacekeeper-refresh wrapper', () => {
    test('forwards the hook payload to the detached child instead of /dev/null', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-refresh-'));
        const sink = path.join(tmpDir, 'received-stdin.json');
        // Stub child: records its stdin, so we can prove the wrapper forwarded it.
        const stub = path.join(tmpDir, 'refresh-stub.sh');
        fs.writeFileSync(stub, `#!/usr/bin/env bash\ncat > "${sink}"\n`, { mode: 0o755 });

        const payload = JSON.stringify({
            hook_event_name: 'PostToolUse',
            model: 'claude-opus-4-8',
            transcript_path: '/tmp/whatever.jsonl'
        });

        // Run the real wrapper but redirect its child command to our stub by
        // overriding the bun invocation via PATH shim: the wrapper calls
        // `bun run --silent <refresh.ts>`. We intercept `bun` with a shim that
        // ignores its args and execs the stub, reading the same forwarded stdin.
        const binDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(binDir);
        const bunShim = path.join(binDir, 'bun');
        fs.writeFileSync(bunShim, `#!/usr/bin/env bash\nexec "${stub}"\n`, { mode: 0o755 });

        const res = spawnSync('bash', [WRAPPER], {
            input: payload,
            env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
            encoding: 'utf8'
        });

        // Wrapper must still return exactly '{}' so the hook never disrupts Claude.
        expect(res.stdout.trim()).toBe('{}');

        // Give the detached child a moment to flush its captured stdin.
        const deadline = Date.now() + 3000;
        while (!fs.existsSync(sink) && Date.now() < deadline) {
            spawnSync('sleep', ['0.05']);
        }

        expect(fs.existsSync(sink)).toBe(true);
        const received = JSON.parse(fs.readFileSync(sink, 'utf8'));
        expect(received.model).toBe('claude-opus-4-8');
        expect(received.transcript_path).toBe('/tmp/whatever.jsonl');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
