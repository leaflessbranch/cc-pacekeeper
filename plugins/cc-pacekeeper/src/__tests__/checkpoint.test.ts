import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    archiveCheckpoint,
    listActive,
    listArchive,
    listLive,
    readCheckpoint,
    saveCheckpoint
} from '../checkpoint';

const CHECKPOINT_DIR = '.claude-checkpoints';

let CWD: string;

beforeEach(() => {
    CWD = path.join(os.tmpdir(), `cc-pacekeeper-ckpt-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(CWD, { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('saveCheckpoint / readCheckpoint round-trip', () => {
    test('writes file with frontmatter and body, parses back', () => {
        const body = '## Goal\nDo a thing\n\n## Status\nIn progress\n';
        const { path: written } = saveCheckpoint({
            cwd: CWD,
            checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { session_id: 'abc', trigger: 'user_invoked' },
            body
        });
        expect(fs.existsSync(written)).toBe(true);
        const back = readCheckpoint(written);
        expect(back).not.toBeNull();
        expect(back!.frontmatter.status).toBe('active');
        expect(back!.frontmatter.session_id).toBe('abc');
        expect(back!.frontmatter.trigger).toBe('user_invoked');
        expect(back!.body).toContain('Do a thing');
    });

    test('demotes existing active checkpoint to superseded on new save', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { trigger: 'a' },
            body: '## Goal\nFirst\n'
        });
        const second = saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { trigger: 'b' },
            body: '## Goal\nSecond\n'
        });
        expect(second.supersededPaths).toHaveLength(1);
        // The first checkpoint's content was moved to archive/.
        const archived = listArchive(CWD, CHECKPOINT_DIR);
        expect(archived).toHaveLength(1);
        expect(archived[0]?.frontmatter.status).toBe('superseded');
        expect(archived[0]?.body).toContain('First');
        // The remaining live checkpoint is the new one.
        const live = listActive(CWD, CHECKPOINT_DIR);
        expect(live).toHaveLength(1);
        expect(live[0]?.body).toContain('Second');
    });
});

describe('archiveCheckpoint', () => {
    test('moves file to archive/ with new status, removes original', () => {
        const { path: written } = saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { trigger: 'x' },
            body: '## Goal\nA\n'
        });
        const ckpt = readCheckpoint(written)!;
        const moved = archiveCheckpoint(ckpt, 'resumed', CWD, CHECKPOINT_DIR);
        expect(moved).not.toBeNull();
        expect(fs.existsSync(written)).toBe(false);
        expect(fs.existsSync(moved!)).toBe(true);
        const back = readCheckpoint(moved!)!;
        expect(back.frontmatter.status).toBe('resumed');
    });

    test('handles filename collisions in archive/', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { created_at: '2026-01-01T00:00:00Z' },
            body: '## Goal\nOne\n'
        });
        const c2 = saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { created_at: '2026-01-01T00:00:00Z' },
            body: '## Goal\nTwo\n'
        });
        // Now archive c2 with same base name — collision against the already-archived first.
        const ckpt = readCheckpoint(c2.path)!;
        const moved = archiveCheckpoint(ckpt, 'resumed', CWD, CHECKPOINT_DIR);
        expect(moved).not.toBeNull();
        const archived = listArchive(CWD, CHECKPOINT_DIR);
        expect(archived.length).toBe(2);
        // No file collisions: distinct paths in archive.
        const archivePaths = new Set(archived.map(c => c.path));
        expect(archivePaths.size).toBe(2);
    });
});

describe('listLive / listActive', () => {
    test('listLive excludes archive/ files', () => {
        const c1 = saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: {}, body: '## Goal\nA\n'
        });
        archiveCheckpoint(readCheckpoint(c1.path)!, 'resumed', CWD, CHECKPOINT_DIR);
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: {}, body: '## Goal\nB\n'
        });
        const live = listLive(CWD, CHECKPOINT_DIR);
        expect(live).toHaveLength(1);
        expect(live[0]?.body).toContain('B');
    });

    test('listActive filters by status', () => {
        // Save two; first gets superseded on second save
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: {}, body: '## Goal\nA\n'
        });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: {}, body: '## Goal\nB\n'
        });
        const active = listActive(CWD, CHECKPOINT_DIR);
        expect(active).toHaveLength(1);
        expect(active[0]?.body).toContain('B');
    });
});

describe('frontmatter parser', () => {
    test('handles arrays, nested meters, and quoted strings with colons', () => {
        const { path: written } = saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: {
                trigger: 'a:b',  // contains colon - must be quoted
                meters: { context_pct: 78, five_hour_pct: 91 },
                files_touched: ['src/main.ts', 'src/foo:bar.ts']
            },
            body: '## Goal\nX\n'
        });
        const back = readCheckpoint(written)!;
        expect(back.frontmatter.trigger).toBe('a:b');
        expect((back.frontmatter.meters as Record<string, number>)?.context_pct).toBe(78);
        expect(back.frontmatter.files_touched).toEqual(['src/main.ts', 'src/foo:bar.ts']);
    });
});
