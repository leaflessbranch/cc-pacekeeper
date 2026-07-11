import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const BIN = path.join(import.meta.dir, '..', '..', 'bin');
// PATH with coreutils but (almost certainly) no bun. If bun IS in /usr/bin
// on some machine, the guard simply doesn't trigger and we skip.
const NO_BUN_PATH = '/usr/bin:/bin';

function run(shim: string) {
    return spawnSync('bash', [path.join(BIN, shim)], {
        input: '{}', encoding: 'utf8', env: { ...process.env, PATH: NO_BUN_PATH }
    });
}

describe('shims without bun on PATH', () => {
    test.each(['pacekeeper-tick', 'pacekeeper-approve', 'pacekeeper-precompact'])(
        'hook shim %s degrades to {} with exit 0', (shim) => {
            const res = run(shim);
            expect(res.status).toBe(0);
            expect(res.stdout.trim()).toBe('{}');
            expect(res.stderr).toContain('bun.sh');
        });

    test.each(['pacekeeper-checkpoint', 'pacekeeper-worktrees'])(
        'CLI shim %s fails loudly with install hint', (shim) => {
            const res = run(shim);
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('bun.sh');
        });
});
