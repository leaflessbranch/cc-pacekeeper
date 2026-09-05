/**
 * Wire-conformance tests for the native Codex boundary.
 *
 * Every expectation here is derived from the pinned 0.153.4 protocol schema
 * and the pinned release source, not from a hook name or a plausible-looking
 * field. The fixture in `fixtures/native-0.153.4/` records the exact shapes
 * these tests assert against so a protocol drift shows up as a test failure
 * rather than as a silent runtime null.
 */
import { describe, expect, test } from 'bun:test';
import {
  NATIVE_PROTOCOL_VERSION,
  QUEUE_ADD_METHOD,
  RATE_LIMITS_READ_METHOD,
  NativeClient,
  buildQueueAddRequest,
  classifySubscriptionCapacity,
  findExistingOwner,
  normalizeNativeCapabilities,
  parseRateLimitsResponse,
  parseThreadTokenUsage,
  type NativeTransport
} from '../native';

const owner = {
  ownerId: 'owner-1',
  pid: 4242,
  accountId: 'acct-1',
  threadIds: ['thread-a'],
  activeThreadIds: [],
  protocolVersion: NATIVE_PROTOCOL_VERSION
};

function transportReturning(value: unknown): NativeTransport {
  return { request: async () => value };
}

const supported = normalizeNativeCapabilities({
  version: NATIVE_PROTOCOL_VERSION,
  methods: [QUEUE_ADD_METHOD, RATE_LIMITS_READ_METHOD]
});

describe('thread/queue/add response parsing', () => {
  // ThreadQueueAddResponse requires `queuedSubmission`, an object carrying
  // `id`, `clientUserMessageId` and `input`. A flat `id` never appears.
  test('reads the submission id from the nested queuedSubmission object', async () => {
    const client = new NativeClient(
      transportReturning({
        queuedSubmission: {
          id: 'sub-7',
          clientUserMessageId: 'msg-a',
          input: [{ type: 'text', text: '[pacekeeper-keepalive] ping' }]
        }
      }),
      supported,
      owner
    );
    const result = await client.queueExistingThread({
      threadId: 'thread-a',
      message: '[pacekeeper-keepalive] ping',
      clientUserMessageId: 'msg-a'
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('unreachable');
    expect(result.queuedSubmissionId).toBe('sub-7');
  });

  test('treats a response without queuedSubmission as ambiguous, never accepted', async () => {
    const client = new NativeClient(transportReturning({ ok: true }), supported, owner);
    const result = await client.queueExistingThread({
      threadId: 'thread-a',
      message: 'ping',
      clientUserMessageId: 'msg-b'
    });
    expect(result.status).toBe('ambiguous');
  });

  test('rejects an echoed clientUserMessageId that does not match the request', async () => {
    const client = new NativeClient(
      transportReturning({
        queuedSubmission: { id: 'sub-9', clientUserMessageId: 'someone-else', input: [] }
      }),
      supported,
      owner
    );
    const result = await client.queueExistingThread({
      threadId: 'thread-a',
      message: 'ping',
      clientUserMessageId: 'msg-c'
    });
    expect(result.status).toBe('ambiguous');
  });

  test('builds params matching ThreadQueueAddParams exactly', () => {
    const request = buildQueueAddRequest({
      threadId: 'thread-a',
      message: 'ping',
      clientUserMessageId: 'msg-a'
    });
    expect(Object.keys(request.params).sort()).toEqual([
      'clientUserMessageId',
      'input',
      'threadId'
    ]);
    expect(request.params.input).toEqual([{ type: 'text', text: 'ping' }]);
  });
});

describe('native capability probing', () => {
  // These three names appear in no version of the protocol. Reporting them as
  // probeable invents a native control surface that does not exist.
  test('never advertises a control the protocol has no method for', () => {
    const capabilities = normalizeNativeCapabilities({
      version: NATIVE_PROTOCOL_VERSION,
      methods: [
        QUEUE_ADD_METHOD,
        RATE_LIMITS_READ_METHOD,
        'turn/start',
        'turn/start/tools-disabled',
        'turn/input/suppress',
        'turn/compact/save-barrier'
      ]
    });
    expect(capabilities.toolDisable).toBe('unsupported');
    expect(capabilities.preModelSuppression).toBe('unsupported');
    expect(capabilities.saveBarrier).toBe('unsupported');
  });

  test('reports a queue on a newer protocol rather than failing closed on drift', () => {
    const capabilities = normalizeNativeCapabilities({
      version: '0.154.0',
      methods: [QUEUE_ADD_METHOD]
    });
    expect(capabilities.queue).toBe('supported');
    expect(capabilities.protocolVersion).toBe('0.154.0');
    expect(capabilities.versionMatchesPin).toBe(false);
  });

  test('an unknown method list is unavailable, not unsupported', () => {
    const capabilities = normalizeNativeCapabilities({ version: '0.153.4' });
    expect(capabilities.queue).toBe('unavailable');
    expect(capabilities.accountRateLimits).toBe('unavailable');
  });
});

describe('rate limit normalization', () => {
  const response = {
    accountId: 'acct-1',
    rateLimits: {
      planType: 'plus',
      primary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      spendControlReached: false
    }
  };

  test('orders buckets by duration, not by primary/secondary position', () => {
    const parsed = parseRateLimitsResponse(response, 1_700_000_100_000);
    expect(parsed.buckets.map((b) => b.kind)).toEqual(['five_hour', 'weekly']);
    expect(parsed.buckets.map((b) => b.usedPercent)).toEqual([17, 32]);
  });

  test('converts second-precision resetsAt to milliseconds', () => {
    const parsed = parseRateLimitsResponse(response, 1_700_000_100_000);
    expect(parsed.buckets[0]?.resetsAtMs).toBe(1_700_000_000_000);
  });

  // A malformed percentage previously became 0, which reads as "no usage at
  // all" and would authorize spending against a limit we cannot see.
  test('never fabricates a zero percentage for a malformed window', () => {
    const parsed = parseRateLimitsResponse(
      { rateLimits: { primary: { usedPercent: 'not-a-number' } } },
      1_700_000_100_000
    );
    expect(parsed.buckets).toHaveLength(1);
    expect(parsed.buckets[0]?.usedPercent).toBeNull();
    expect(parsed.buckets[0]?.valid).toBe(false);
    expect(parsed.diagnostics.join(' ')).toContain('usedPercent');
  });

  test('retains an unknown-duration bucket instead of dropping it', () => {
    const parsed = parseRateLimitsResponse(
      { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 15 } } },
      1_700_000_100_000
    );
    expect(parsed.buckets[0]?.kind).toBe('unknown');
    expect(parsed.buckets[0]?.durationMinutes).toBe(15);
    expect(parsed.buckets[0]?.valid).toBe(true);
  });

  test('handles primary=weekly with no secondary', () => {
    const parsed = parseRateLimitsResponse(
      { rateLimits: { primary: { usedPercent: 60, windowDurationMins: 10080 } } },
      1_700_000_100_000
    );
    expect(parsed.buckets.map((b) => b.kind)).toEqual(['weekly']);
  });

  // GetAccountRateLimitsResponse carries a multi-bucket map keyed by limit id
  // alongside the single-bucket compatibility view.
  test('parses the multi-bucket rateLimitsByLimitId map', () => {
    const parsed = parseRateLimitsResponse(
      {
        rateLimits: { primary: { usedPercent: 17, windowDurationMins: 300 } },
        rateLimitsByLimitId: {
          codex: {
            planType: 'plus',
            primary: { usedPercent: 17, windowDurationMins: 300 }
          },
          other: {
            primary: { usedPercent: 3, windowDurationMins: 300 }
          }
        }
      },
      1_700_000_100_000
    );
    expect(Object.keys(parsed.byLimitId).sort()).toEqual(['codex', 'other']);
    expect(parsed.byLimitId['codex']?.buckets[0]?.usedPercent).toBe(17);
  });

  test('an absent rateLimits field is a diagnostic, not an empty success', () => {
    const parsed = parseRateLimitsResponse({}, 1_700_000_100_000);
    expect(parsed.buckets).toEqual([]);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('subscription capacity classification', () => {
  test('available credits alone never classify as paid spending', () => {
    expect(
      classifySubscriptionCapacity({
        planType: 'plus',
        spendControlReached: null,
        fresh: true,
        creditsAvailable: true
      })
    ).toBe('unknown');
  });

  test('an authoritative spend-control transition classifies as paid', () => {
    expect(
      classifySubscriptionCapacity({ planType: 'plus', spendControlReached: true, fresh: true })
    ).toBe('paid');
  });

  test('a stale reading is never treated as included capacity', () => {
    expect(
      classifySubscriptionCapacity({ planType: 'plus', spendControlReached: false, fresh: false })
    ).toBe('unknown');
  });

  test('an unauthenticated account is unsupported, never included', () => {
    expect(
      classifySubscriptionCapacity({
        planType: null,
        spendControlReached: false,
        fresh: true,
        authenticated: false
      })
    ).toBe('unsupported');
  });
});

describe('current context from native token usage', () => {
  // ThreadTokenUsage separates `last` (current turn) from `total` (lifetime).
  // Using `total` as the context meter overstates usage without bound.
  test('uses the last turn, not the lifetime total, as current context', () => {
    const context = parseThreadTokenUsage({
      modelContextWindow: 200_000,
      last: {
        inputTokens: 40_000,
        cachedInputTokens: 30_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 500,
        totalTokens: 42_000
      },
      total: {
        inputTokens: 900_000,
        cachedInputTokens: 800_000,
        outputTokens: 50_000,
        reasoningOutputTokens: 9_000,
        totalTokens: 950_000
      }
    });
    expect(context.currentTokens).toBe(42_000);
    expect(context.contextWindow).toBe(200_000);
    expect(context.usedPercent).toBe(21);
  });

  test('a missing model window leaves the percentage unknown rather than assuming 200k', () => {
    const context = parseThreadTokenUsage({
      modelContextWindow: null,
      last: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        totalTokens: 11
      },
      total: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        totalTokens: 11
      }
    });
    expect(context.contextWindow).toBeNull();
    expect(context.usedPercent).toBeNull();
  });

  test('reports observed cache fields and distinguishes missing from zero', () => {
    const context = parseThreadTokenUsage({
      modelContextWindow: 200_000,
      last: {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 105
      },
      total: {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 105
      }
    });
    // cacheWriteInputTokens is optional in the schema: absent must not read 0.
    expect(context.cache.cachedInputTokens).toBe(0);
    expect(context.cache.cacheWriteInputTokens).toBeNull();
  });

  test('a malformed usage payload yields no fabricated context', () => {
    expect(parseThreadTokenUsage(null).currentTokens).toBeNull();
    expect(parseThreadTokenUsage({ last: 'nope' }).currentTokens).toBeNull();
  });
});

describe('existing-owner selection', () => {
  const records = [
    { ...owner, ownerId: 'owner-1', pid: 100 },
    { ownerId: 'owner-2', pid: 200, accountId: 'acct-2', threadIds: ['thread-a'], protocolVersion: NATIVE_PROTOCOL_VERSION }
  ];

  // Defaulting liveness to true means a stale record from a dead process is
  // treated as a live delivery target.
  test('refuses to assume liveness when no predicate is supplied', () => {
    expect(findExistingOwner({ records, threadId: 'thread-a', accountId: 'acct-1' }).status)
      .toBe('unknown');
  });

  test('selects the single live owner for the known account', () => {
    const found = findExistingOwner({
      records,
      threadId: 'thread-a',
      accountId: 'acct-1',
      isAlive: (pid) => pid === 100
    });
    expect(found.status).toBe('found');
    if (found.status !== 'found') throw new Error('unreachable');
    expect(found.owner.ownerId).toBe('owner-1');
  });

  test('a dead process is not a delivery target', () => {
    expect(
      findExistingOwner({
        records,
        threadId: 'thread-a',
        accountId: 'acct-1',
        isAlive: () => false
      }).status
    ).toBe('absent');
  });

  test('two live owners for the same account and thread are ambiguous', () => {
    expect(
      findExistingOwner({
        records: [
          { ...owner, ownerId: 'owner-1', pid: 100 },
          { ...owner, ownerId: 'owner-3', pid: 300 }
        ],
        threadId: 'thread-a',
        accountId: 'acct-1',
        isAlive: () => true
      }).status
    ).toBe('ambiguous');
  });

  test('an unknown local account never selects an owner', () => {
    expect(
      findExistingOwner({ records, threadId: 'thread-a', accountId: null, isAlive: () => true })
        .status
    ).toBe('unknown');
  });
});

describe('delivery failure classification', () => {
  test('a transport timeout is ambiguous and must not authorize a retry', async () => {
    const client = new NativeClient(
      { request: async () => { throw new Error('request timed out'); } },
      supported,
      owner
    );
    const result = await client.queueExistingThread({
      threadId: 'thread-a',
      message: 'ping',
      clientUserMessageId: 'msg-d'
    });
    expect(result.status).toBe('ambiguous');
  });

  // The pinned source treats -32601 and the experimental-required -32600 as
  // "this server does not support the queue" rather than a delivery failure.
  test('a method-not-found error is reported as unsupported', async () => {
    const client = new NativeClient(
      { request: async () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); } },
      supported,
      owner
    );
    const result = await client.queueExistingThread({
      threadId: 'thread-a',
      message: 'ping',
      clientUserMessageId: 'msg-e'
    });
    expect(result.status).toBe('unsupported');
  });

  test('an unsupported queue capability never reaches the transport', async () => {
    let called = false;
    const client = new NativeClient(
      { request: async () => { called = true; return {}; } },
      { ...supported, queue: 'unsupported' },
      owner
    );
    const result = await client.queueExistingThread({
      threadId: 'thread-a',
      message: 'ping',
      clientUserMessageId: 'msg-f'
    });
    expect(result.status).toBe('unsupported');
    expect(called).toBe(false);
  });
});

describe('automation safety invariants', () => {
  // Scope forbids automatic reset-credit consumption. The method exists in the
  // protocol, so its absence from this module is an asserted boundary.
  test('the native module exposes no reset-credit consumption path', async () => {
    const source = await Bun.file(new URL('../native.ts', import.meta.url)).text();
    expect(source).not.toContain('rateLimitResetCredit/consume');
    expect(source).not.toContain('sendAddCreditsNudgeEmail');
  });

  test('control characters in an id are rejected before framing', () => {
    expect(() =>
      buildQueueAddRequest({ threadId: 'a\u0000b', message: 'ping', clientUserMessageId: 'm' })
    ).toThrow();
    expect(() =>
      buildQueueAddRequest({ threadId: 't', message: 'ping', clientUserMessageId: '' })
    ).toThrow();
  });
});
