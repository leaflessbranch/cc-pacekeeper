import { describe, expect, test } from 'bun:test';
import scenarios from './scenarios.json';

describe('Codex compatibility corpus', () => {
  test('does not silently remove a requested scenario', () => {
    const ids = scenarios.scenarios.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('queued-ping-then-user-input');
    expect(ids).toContain('same-lane-two-harnesses');
  });
});
