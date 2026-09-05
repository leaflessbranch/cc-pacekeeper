import { describe, expect, test } from 'bun:test';
import scenarios from './scenarios.json';

describe('Claude compatibility corpus', () => {
  test('keeps the shipped Claude rows and explicit deferrals visible', () => {
    expect(scenarios.version).toBe(1);
    expect(scenarios.scenarios.length).toBeGreaterThanOrEqual(20);
    expect(scenarios.scenarios.filter((row) => row.codex === 'deferred').map((row) => row.id))
      .toEqual(['deferred-model-arbitrage', 'deferred-away-routing']);
  });
});
