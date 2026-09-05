import { describe, expect, test } from 'bun:test';
import {
  NATIVE_PROTOCOL_VERSION,
  buildQueueAddRequest,
  normalizeNativeCapabilities,
  parseRateLimitSnapshot
} from '../native';

describe('native Codex boundary', () => {
  test('builds the pinned queue request with caller-owned identity', () => {
    expect(buildQueueAddRequest({
      threadId: 'thread-a',
      message: '[pacekeeper-keepalive] ping',
      clientUserMessageId: 'msg-a'
    })).toEqual({
      method: 'thread/queue/add',
      params: {
        threadId: 'thread-a',
        input: [{ type: 'text', text: '[pacekeeper-keepalive] ping' }],
        clientUserMessageId: 'msg-a'
      }
    });
  });

  test('preserves unsupported native controls as explicit capabilities', () => {
    expect(normalizeNativeCapabilities({
      version: '0.153.4',
      methods: ['thread/queue/add', 'account/rateLimits/read']
    })).toEqual({
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      queue: 'supported',
      accountRateLimits: 'supported',
      toolDisable: 'unsupported',
      preModelSuppression: 'unsupported',
      saveBarrier: 'unsupported'
    });
  });

  test('normalizes native rate limits without trusting primary position', () => {
    const result = parseRateLimitSnapshot({
      planType: 'plus',
      primary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1_700_000_000 }
    }, 1_700_000_100_000);
    expect(result.buckets.map((bucket) => bucket.kind)).toEqual(['five_hour', 'weekly']);
    expect(result.buckets.map((bucket) => bucket.usedPercent)).toEqual([17, 32]);
  });
});
