import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeHandoff } from '../agent-budget';
import { archiveCheckpoint, listActive, saveCheckpoint } from '../checkpoint';
import { DEFAULT_CONFIG } from '../config';
import { computeSnapshot } from '../thresholds';
import { buildPostCompactContext, buildResumeOrientation, buildSessionStartContext, POST_COMPACT_BODY_CAP } from '../tick';

const CHECKPOINT_DIR = '.claude-checkpoints';

let CWD: string;

beforeEach(() => {
    CWD = path.join(os.tmpdir(), `cc-pacekeeper-banner-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(CWD, { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('buildSessionStartContext', () => {
    test('returns empty string when there are no active checkpoints', () => {
        expect(buildSessionStartContext(CWD, CHECKPOINT_DIR)).toBe('');
    });

    test('renders single-lane wording for exactly one active lane', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a' }, body: '## Goal\nDo the thing\n'
        });
        const out = buildSessionStartContext(CWD, CHECKPOINT_DIR);
        expect(out).toContain('Active checkpoint found');
        expect(out).toContain('Do the thing');
        expect(out).toContain('/cc-pacekeeper:checkpoint resume');
        // Single-lane wording should not mention lane-picking.
        expect(out).not.toContain('lanes found');
    });

    test('renders one line per lane for multiple active lanes', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-a', git_branch: 'feature-a' }, body: '## Goal\nGoal A\n'
        });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-b', git_branch: 'feature-b' }, body: '## Goal\nGoal B\n'
        });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane-c', git_branch: 'feature-c' }, body: '## Goal\nGoal C\n'
        });

        const out = buildSessionStartContext(CWD, CHECKPOINT_DIR);
        expect(out).toContain('3 active checkpoint lanes');
        expect(out).toContain('lane-a · feature-a');
        expect(out).toContain('Goal A');
        expect(out).toContain('lane-b · feature-b');
        expect(out).toContain('Goal B');
        expect(out).toContain('lane-c · feature-c');
        expect(out).toContain('Goal C');
        expect(out).toContain('resume <name>');
    });
});

describe('buildResumeOrientation', () => {
    const snap = computeSnapshot({ contextPercent: null, usage: null }, DEFAULT_CONFIG);

    test('with nothing pending, says so and asks for a one-word reply', () => {
        const out = buildResumeOrientation(CWD, DEFAULT_CONFIG, snap);
        expect(out).toContain('[pacekeeper-resume]');
        expect(out).toContain('nothing is pending');
        expect(out).toContain('single word');
        expect(out).not.toContain('Run `pacekeeper-checkpoint resume');
    });

    test('with an active lane, still instructs resume', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: DEFAULT_CONFIG.checkpoint_dir_name,
            frontmatter: { name: 'lane' }, body: '## Goal\nGo\n'
        });
        const out = buildResumeOrientation(CWD, DEFAULT_CONFIG, snap);
        expect(out).toContain('Run `pacekeeper-checkpoint resume');
        expect(out).toContain('Active lane(s): lane');
    });
});

describe('buildPostCompactContext', () => {
    const since = Date.parse('2026-06-01T00:00:00.000Z');
    const SID = 'sess-1';

    test('with no checkpoint this session, says so and asks for a restated goal', () => {
        const out = buildPostCompactContext(CWD, CHECKPOINT_DIR, since, SID);
        expect(out).toContain('Context was just compacted');
        expect(out).toContain('no checkpoint was saved this session');
        expect(out).toContain('/cc-pacekeeper:checkpoint save');
    });

    test('a checkpoint saved before this session does not count', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-01-01T00:00:00.000Z' }, body: '## Goal\nAncient\n'
        });
        const out = buildPostCompactContext(CWD, CHECKPOINT_DIR, since, SID);
        expect(out).toContain('no checkpoint was saved this session');
        expect(out).not.toContain('Ancient');
    });

    test('injects the full body of this session\'s checkpoint, even after it was resumed', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-06-01T01:00:00.000Z' },
            body: '## Goal\nShip the thing\n\n## Next\n1. Run the tests\n'
        });
        archiveCheckpoint(listActive(CWD, CHECKPOINT_DIR)[0]!, 'resumed', CWD, CHECKPOINT_DIR, {});
        const out = buildPostCompactContext(CWD, CHECKPOINT_DIR, since, SID, Date.parse('2026-06-01T03:00:00.000Z'));
        expect(out).toContain('Context was just compacted');
        expect(out).toContain('lane');
        expect(out).toContain('2h ago');
        expect(out).toContain('## Goal\nShip the thing');
        expect(out).toContain('1. Run the tests');
        // It is orientation, not an instruction to run resume again.
        expect(out).not.toContain('checkpoint resume');
    });

    test('caps an oversized body and points at the file', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-06-01T01:00:00.000Z' },
            body: '## Goal\n' + 'x'.repeat(POST_COMPACT_BODY_CAP + 500)
        });
        const out = buildPostCompactContext(CWD, CHECKPOINT_DIR, since, SID);
        expect(out.length).toBeLessThan(POST_COMPACT_BODY_CAP + 1000);
        expect(out).toContain('truncated');
        expect(out).toContain(CHECKPOINT_DIR);
    });

    test('a long handoff list eats into the body budget, not into the 10K ceiling', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'lane', created_at: '2026-06-01T01:00:00.000Z' },
            body: '## Goal\n' + 'x'.repeat(POST_COMPACT_BODY_CAP + 500)
        });
        for (let i = 0; i < 20; i++) {
            writeHandoff({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, agentId: `agent-${i}`, agentType: 'general-purpose', trigger: 'budget_pause', body: '## Goal\nsub\n' });
        }
        const out = buildPostCompactContext(CWD, CHECKPOINT_DIR, since, SID);
        expect(out.length).toBeLessThan(POST_COMPACT_BODY_CAP + 1000);
        expect(out).toContain('truncated');
        expect(out).toContain('agent-19');
    });

    // With a save of our own, a concurrent session's newer one must not win.
    // (With none of our own it is still injected — a stamp mismatch is more
    // often `--continue` handing Bash the startup id than a second session.)
    test('a concurrent session\'s newer checkpoint does not displace this session\'s', () => {
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'mine', created_at: '2026-06-01T01:00:00.000Z', session_id: SID },
            body: '## Goal\nShip the thing\n'
        });
        saveCheckpoint({
            cwd: CWD, checkpointDirName: CHECKPOINT_DIR,
            frontmatter: { name: 'theirs', created_at: '2026-06-01T02:00:00.000Z', session_id: 'sess-2' },
            body: '## Goal\nRefactor auth\n'
        });
        const out = buildPostCompactContext(CWD, CHECKPOINT_DIR, since, SID);
        expect(out).toContain('Ship the thing');
        expect(out).not.toContain('Refactor auth');
    });

    test('lists pending handoffs after the checkpoint', () => {
        writeHandoff({ cwd: CWD, checkpointDirName: CHECKPOINT_DIR, agentId: 'agent-42', agentType: 'general-purpose', trigger: 'budget_pause', body: '## Goal\nsub\n' });
        const out = buildPostCompactContext(CWD, CHECKPOINT_DIR, since, SID);
        expect(out).toContain('paused subagent handoff');
        expect(out).toContain('agent-42');
    });
});
