import { describe, expect, test } from 'bun:test';
import { CODEX_DEFAULTS } from '../config';
import { PAUSE_MARKER, buildContract, dispatchAdvice, shouldPause } from '../agent-budget';

const spawn = { fiveHourPercentAtSpawn: 20 };

describe('budget contracts', () => {
  test('the pause threshold comes from configuration, not a literal', () => {
    const contract = buildContract({
      agentId: 'agent-1',
      agentType: 'general-purpose',
      cliPath: '/opt/pacekeeper/bin/pacekeeper-checkpoint',
      ...spawn
    }, CODEX_DEFAULTS);
    expect(contract.pausePercent).toBe(CODEX_DEFAULTS.auto.subagent_pause_pct);
  });

  // A subagent's Bash does not see the PATH shim, so a bare command name in
  // the contract would simply fail when the agent tried to run it.
  test('the contract embeds an absolute CLI path', () => {
    const contract = buildContract({
      agentId: 'agent-1',
      agentType: 'general-purpose',
      cliPath: '/opt/pacekeeper/bin/pacekeeper-checkpoint',
      ...spawn
    }, CODEX_DEFAULTS);
    expect(contract.text).toContain('/opt/pacekeeper/bin/pacekeeper-checkpoint');
    expect(contract.text).toContain(PAUSE_MARKER);
    expect(contract.text).toContain('agent-1');
  });

  test('a relative CLI path is rejected rather than embedded', () => {
    expect(() =>
      buildContract({
        agentId: 'agent-1',
        agentType: 'general-purpose',
        cliPath: 'pacekeeper-checkpoint',
        ...spawn
      }, CODEX_DEFAULTS)
    ).toThrow();
  });

  // The account window is shared, so a delta is an estimate of account usage
  // during the agent's life, never per-agent billing.
  test('the contract labels consumption as a shared-account estimate', () => {
    const contract = buildContract({
      agentId: 'agent-1',
      agentType: 'general-purpose',
      cliPath: '/opt/pacekeeper/bin/pacekeeper-checkpoint',
      ...spawn
    }, CODEX_DEFAULTS);
    expect(contract.text.toLowerCase()).toContain('estimate');
  });
});

describe('pause decisions', () => {
  test('pauses once the configured share of the block is reached', () => {
    expect(shouldPause({ fiveHourPercent: 76, ...spawn }, CODEX_DEFAULTS).pause).toBe(true);
  });

  test('does not pause below the threshold', () => {
    expect(shouldPause({ fiveHourPercent: 50, ...spawn }, CODEX_DEFAULTS).pause).toBe(false);
  });

  test('any critical meter pauses immediately regardless of the threshold', () => {
    const result = shouldPause(
      { fiveHourPercent: 30, contextLevel: 'critical', ...spawn },
      CODEX_DEFAULTS
    );
    expect(result.pause).toBe(true);
    expect(result.reason).toContain('critical');
  });

  // A rolled-over block makes the spawn-time anchor meaningless; the estimate
  // must rebase rather than produce a negative consumption.
  test('a reset rollover rebases instead of reporting negative consumption', () => {
    const result = shouldPause(
      { fiveHourPercent: 5, fiveHourPercentAtSpawn: 80, rolledOver: true },
      CODEX_DEFAULTS
    );
    expect(result.pause).toBe(false);
    expect(result.consumedEstimate).toBe(0);
  });

  test('an unreadable meter never triggers a pause on a guess', () => {
    const result = shouldPause({ fiveHourPercent: null, ...spawn }, CODEX_DEFAULTS);
    expect(result.pause).toBe(false);
    expect(result.reason).toContain('unreadable');
  });
});

describe('dispatch advisory', () => {
  // An advisory must never become a denial: refusing an ordinary spawn would
  // break the user's work to save budget they did not ask us to save.
  test('advice is returned without denying the dispatch', () => {
    const advice = dispatchAdvice({ fiveHourPercent: 90, plannedAgents: 6 }, CODEX_DEFAULTS);
    expect(advice.deny).toBe(false);
    expect(advice.message).not.toBeNull();
  });

  test('an ordinary dispatch with headroom produces no message', () => {
    const advice = dispatchAdvice({ fiveHourPercent: 10, plannedAgents: 1 }, CODEX_DEFAULTS);
    expect(advice.deny).toBe(false);
    expect(advice.message).toBeNull();
  });

  test('an unreadable meter advises caution without denying', () => {
    const advice = dispatchAdvice({ fiveHourPercent: null, plannedAgents: 4 }, CODEX_DEFAULTS);
    expect(advice.deny).toBe(false);
  });
});
