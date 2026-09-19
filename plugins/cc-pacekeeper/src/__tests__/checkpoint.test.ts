import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { execFileSync } from 'child_process';

import {
    archiveCheckpoint,
    goalSection,
    laneGoalAnchor,
    laneOf,
    listActive,
    listArchive,
    listLive,
    newestSince,
    normalizeGoal,
    readCheckpoint,
    resolveLaneName,
    sanitizeLaneName,
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

    test('worktree frontmatter round-trips', () => {
        const { path: written } = saveCheckpoint({
            cwd: CWD,
            checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { trigger: 'x', worktree: '/home/x/wt-feature', git_branch: 'feature' },
            body: '## Goal\nWt\n'
        });
        const back = readCheckpoint(written);
        expect(back!.frontmatter.worktree).toBe('/home/x/wt-feature');
        expect(back!.frontmatter.git_branch).toBe('feature');
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

describe('sanitizeLaneName', () => {
    test('lowercases and collapses non-alphanumeric runs to a single dash', () => {
        expect(sanitizeLaneName('Feature/Foo_Bar 123')).toBe('feature-foo-bar-123');
    });

    test('trims leading/trailing dashes', () => {
        expect(sanitizeLaneName('--weird--')).toBe('weird');
    });

    test('falls back to default when nothing usable remains', () => {
        expect(sanitizeLaneName('___')).toBe('default');
    });
});

describe('resolveLaneName', () => {
    test('explicit name wins over branch', () => {
        execFileSync('git', ['init', '-q'], { cwd: CWD });
        expect(resolveLaneName('My Lane', CWD)).toBe('my-lane');
    });

    test('falls back to sanitized current branch when no name given', () => {
        execFileSync('git', ['init', '-q', '-b', 'Feature/Thing'], { cwd: CWD });
        execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: CWD });
        expect(resolveLaneName(undefined, CWD)).toBe('feature-thing');
    });

    test('falls back to default outside a git repo', () => {
        expect(resolveLaneName(undefined, CWD)).toBe('default');
    });
});

describe('laneOf (legacy compatibility)', () => {
    test('uses frontmatter name when present', () => {
        expect(laneOf({ status: 'active', created_at: '2026-01-01T00:00:00Z', name: 'My Lane' })).toBe('my-lane');
    });

    test('derives from git_branch when name is absent (legacy files)', () => {
        expect(laneOf({ status: 'active', created_at: '2026-01-01T00:00:00Z', git_branch: 'Feature/X' })).toBe('feature-x');
    });

    test('falls back to default when neither name nor git_branch present', () => {
        expect(laneOf({ status: 'active', created_at: '2026-01-01T00:00:00Z' })).toBe('default');
    });
});

describe('lane-scoped supersede', () => {
    test('saving in a new lane leaves other lanes active', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a' }, body: '## Goal\nA1\n'
        });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-b' }, body: '## Goal\nB1\n'
        });
        const active = listActive(CWD, CHECKPOINT_DIR);
        expect(active).toHaveLength(2);
        const lanes = active.map(c => laneOf(c.frontmatter)).sort();
        expect(lanes).toEqual(['lane-a', 'lane-b']);
    });

    test('saving again in the same lane supersedes only that lane', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a' }, body: '## Goal\nA1\n'
        });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-b' }, body: '## Goal\nB1\n'
        });
        const second = saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a' }, body: '## Goal\nA2\n'
        });
        expect(second.supersededPaths).toHaveLength(1);
        const active = listActive(CWD, CHECKPOINT_DIR);
        expect(active).toHaveLength(2);
        const laneA = active.find(c => laneOf(c.frontmatter) === 'lane-a');
        const laneB = active.find(c => laneOf(c.frontmatter) === 'lane-b');
        expect(laneA?.body).toContain('A2');
        expect(laneB?.body).toContain('B1');
    });

    test('filename is prefixed with the lane name', () => {
        const { path: written } = saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'My Lane' }, body: '## Goal\nX\n'
        });
        expect(path.basename(written).startsWith('my-lane-')).toBe(true);
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

describe('newestSince', () => {
    const SID = 'sess-1';

    test('returns null with no checkpoints or only older ones', () => {
        expect(newestSince(CWD, CHECKPOINT_DIR, Date.now(), SID)).toBeNull();
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'old', created_at: '2026-01-01T00:00:00.000Z' }, body: '## Goal\nOld\n'
        });
        expect(newestSince(CWD, CHECKPOINT_DIR, Date.parse('2026-06-01T00:00:00.000Z'), SID)).toBeNull();
    });

    test('picks the newest by created_at across live and archive, any status', () => {
        const since = Date.parse('2026-06-01T00:00:00.000Z');
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-06-01T01:00:00.000Z' }, body: '## Goal\nFirst\n'
        });
        // Superseded by a later save in the same lane → moves to archive/.
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-06-01T02:00:00.000Z' }, body: '## Goal\nSecond\n'
        });
        // Resume the active one → archived as resumed; it must STILL be found.
        const active = listActive(CWD, CHECKPOINT_DIR)[0]!;
        archiveCheckpoint(active, 'resumed', CWD, CHECKPOINT_DIR, { resumed_at: '2026-06-01T02:05:00.000Z' });
        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(0);

        const found = newestSince(CWD, CHECKPOINT_DIR, since, SID)!;
        expect(found.body).toContain('Second');
        expect(found.frontmatter.status).toBe('resumed');
    });

    // Yesterday's checkpoint, resumed this morning, IS this session's record.
    // Goal lock refuses a paraphrased re-save, so without this the
    // post-compaction context would have nothing left to re-inject.
    test('a checkpoint created before `since` but resumed after it still counts', () => {
        const since = Date.parse('2026-06-01T00:00:00.000Z');
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-05-31T09:00:00.000Z' }, body: '## Goal\nYesterday\n'
        });
        archiveCheckpoint(listActive(CWD, CHECKPOINT_DIR)[0]!, 'resumed', CWD, CHECKPOINT_DIR, { resumed_at: '2026-06-01T01:00:00.000Z' });
        const found = newestSince(CWD, CHECKPOINT_DIR, since, SID);
        expect(found).not.toBeNull();
        expect(found!.body).toContain('Yesterday');
    });

    test('skips another session\'s checkpoint but keeps an unstamped one', () => {
        const since = Date.parse('2026-06-01T00:00:00.000Z');
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'mine', created_at: '2026-06-01T01:00:00.000Z', session_id: SID },
            body: '## Goal\nMine\n'
        });
        // A concurrent session in the same project saves later — not "this session".
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'theirs', created_at: '2026-06-01T02:00:00.000Z', session_id: 'sess-2' },
            body: '## Goal\nTheirs\n'
        });
        expect(newestSince(CWD, CHECKPOINT_DIR, since, SID)!.body).toContain('Mine');

        // Saved without --session-id: kept, since it cannot be attributed away.
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'unstamped', created_at: '2026-06-01T03:00:00.000Z' },
            body: '## Goal\nUnstamped\n'
        });
        expect(newestSince(CWD, CHECKPOINT_DIR, since, SID)!.body).toContain('Unstamped');
    });

    // What every checkpoint saved before the skill named the real env var has
    // on disk: the key with an empty value, from a flag that expanded to
    // nothing. It is this session's record as much as an unstamped one.
    test('keeps a checkpoint whose session_id line is present but empty', () => {
        const since = Date.parse('2026-06-01T00:00:00.000Z');
        const dir = path.join(CWD, CHECKPOINT_DIR);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lane-2026-06-01T01-00-00.md'),
            '---\nstatus: active\ncreated_at: 2026-06-01T01:00:00.000Z\nname: lane\nsession_id:\n---\n\n## Goal\nBlank-stamped\n'
        );
        const found = newestSince(CWD, CHECKPOINT_DIR, since, SID);
        expect(found).not.toBeNull();
        expect(found!.body).toContain('Blank-stamped');
    });

    // `claude --continue` can hand the Bash tool the startup id while the hooks
    // see the resumed one, so a stamp mismatch must never leave a session with
    // nothing to re-orient from — the concurrent-session guard only decides
    // WHICH candidate wins when this session has one of its own.
    test('falls back to the newest candidate when no stamp matches this session', () => {
        const since = Date.parse('2026-06-01T00:00:00.000Z');
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-06-01T01:00:00.000Z', session_id: 'other' },
            body: '## Goal\nOnly candidate\n'
        });
        expect(newestSince(CWD, CHECKPOINT_DIR, since, SID)!.body).toContain('Only candidate');
    });

    test('prefers this session\'s stamped save over a newer one from another session', () => {
        const since = Date.parse('2026-06-01T00:00:00.000Z');
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'mine', created_at: '2026-06-01T01:00:00.000Z', session_id: SID },
            body: '## Goal\nMine\n'
        });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'theirs', created_at: '2026-06-01T02:00:00.000Z', session_id: 'other' },
            body: '## Goal\nTheirs\n'
        });
        expect(newestSince(CWD, CHECKPOINT_DIR, since, SID)!.body).toContain('Mine');
    });

    test('skips a checkpoint the user explicitly discarded', () => {
        const since = Date.parse('2026-06-01T00:00:00.000Z');
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-06-01T01:00:00.000Z', session_id: SID },
            body: '## Goal\nDropped\n'
        });
        archiveCheckpoint(listActive(CWD, CHECKPOINT_DIR)[0]!, 'superseded', CWD, CHECKPOINT_DIR, { discard_reason: 'wrong track' });
        expect(newestSince(CWD, CHECKPOINT_DIR, since, SID)).toBeNull();
    });
});

describe('goalSection / normalizeGoal', () => {
    test('extracts the whole Goal section, not just its first line', () => {
        const body = '## Goal\nShip the thing.\nUser said: "no ETAs".\n\n## Status\n- step 1\n';
        expect(goalSection(body)).toBe('Ship the thing.\nUser said: "no ETAs".');
    });

    test('null when there is no Goal section; empty section is null too', () => {
        expect(goalSection('## Status\n- x\n')).toBeNull();
        expect(goalSection('## Goal\n\n## Status\n- x\n')).toBeNull();
    });

    test('normalizeGoal collapses whitespace so re-wrapping is not a change', () => {
        expect(normalizeGoal('Ship  the\nthing. ')).toBe('Ship the thing.');
        expect(normalizeGoal('Ship the thing.')).toBe(normalizeGoal('  Ship\n  the thing.\n'));
    });
});

describe('laneGoalAnchor', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.parse('2026-06-15T00:00:00.000Z');

    test('null with no checkpoints, or none in this lane', () => {
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)).toBeNull();
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'other', created_at: '2026-06-14T00:00:00.000Z' }, body: '## Goal\nOther\n' });
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)).toBeNull();
    });

    test('the active checkpoint in the lane is the anchor', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane', created_at: '2026-06-14T00:00:00.000Z' }, body: '## Goal\nA\n' });
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)?.body).toContain('A');
    });

    test('a resumed (archived) checkpoint is still the anchor — the post-compaction case', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane', created_at: '2026-06-14T00:00:00.000Z' }, body: '## Goal\nA\n' });
        archiveCheckpoint(listActive(CWD, CHECKPOINT_DIR)[0]!, 'resumed', CWD, CHECKPOINT_DIR, { resumed_at: '2026-06-14T01:00:00.000Z' });
        expect(listActive(CWD, CHECKPOINT_DIR)).toHaveLength(0);
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)?.frontmatter.status).toBe('resumed');
    });

    test('superseded and stale checkpoints are never anchors; the newest eligible wins', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane', created_at: '2026-06-13T00:00:00.000Z' }, body: '## Goal\nOld\n' });
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane', created_at: '2026-06-14T00:00:00.000Z' }, body: '## Goal\nNew\n' });
        // First is now superseded in archive/; second is active.
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)?.body).toContain('New');
        archiveCheckpoint(listActive(CWD, CHECKPOINT_DIR)[0]!, 'stale', CWD, CHECKPOINT_DIR);
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)).toBeNull();
    });

    test('older than maxAgeDays by created_at is ignored unless resumed recently', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane', created_at: new Date(now - 30 * DAY).toISOString() }, body: '## Goal\nA\n' });
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)).toBeNull();
        archiveCheckpoint(listActive(CWD, CHECKPOINT_DIR)[0]!, 'resumed', CWD, CHECKPOINT_DIR, { resumed_at: new Date(now - 1 * DAY).toISOString() });
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)?.body).toContain('A');
    });

    test('a checkpoint without a Goal section is not an anchor', () => {
        saveCheckpoint({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, frontmatter: { name: 'lane', created_at: '2026-06-14T00:00:00.000Z' }, body: '## Status\n- x\n' });
        expect(laneGoalAnchor(CWD, CHECKPOINT_DIR, 'lane', 14, now)).toBeNull();
    });
});

describe('parseYaml empty scalars', () => {
    test('a key with no value and no children reads back as an empty string, not {}', () => {
        const dir = path.join(CWD, CHECKPOINT_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'lane-2026-06-01T00-00-00Z.md');
        fs.writeFileSync(file, '---\nstatus: active\ncreated_at: "2026-06-01T00:00:00.000Z"\nsession_id:\nname: lane\n---\n\n## Goal\nG\n');
        const ckpt = readCheckpoint(file)!;
        expect(ckpt.frontmatter.session_id).toBe('');
        expect(ckpt.frontmatter.name).toBe('lane');
    });

    test('a key followed by indented children is still an object or array', () => {
        const dir = path.join(CWD, CHECKPOINT_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'lane-2026-06-01T00-00-01Z.md');
        fs.writeFileSync(file, '---\nstatus: active\ncreated_at: "2026-06-01T00:00:00.000Z"\nmeters:\n  five_hour_pct: 37\nfiles_touched:\n  - a.ts\n---\n\nbody\n');
        const fm = readCheckpoint(file)!.frontmatter;
        expect(fm.meters).toEqual({ five_hour_pct: 37 });
        expect(fm.files_touched).toEqual(['a.ts']);
    });
});
