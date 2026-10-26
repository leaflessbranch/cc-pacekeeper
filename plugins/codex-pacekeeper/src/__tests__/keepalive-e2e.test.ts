/**
 * End-to-end keepalive cycle against a fake Codex app-server control socket.
 *
 * The fake speaks the real wire: WebSocket over a Unix socket, the
 * initialize/initialized handshake, then JSON-RPC for loaded threads, the
 * account and rate-limit reads, thread/queue/add and thread/read. The service
 * under test runs its production resolver, eligibility and delivery code.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODEX_DEFAULTS } from '../config';
import { KEEPALIVE_PING } from '../jobs';
import { CodexService } from '../service';
import { CodexStore } from '../storage';

const THREAD = '019a2222-3333-7444-8555-666666666666';
const ACCOUNT = 'acct-e2e';

interface Queued { id: string; clientUserMessageId: string; text: string }

const server = {
  queued: [] as Queued[],
  completed: [] as Array<{ clientUserMessageId: string; reply: string; tools: number }>,
  calls: [] as string[],
  /** account/rateLimits/read reaches OpenAI's backend; live it takes ~0.8-1.1s. */
  rateLimitsDelayMs: 0
};

let home: string;
let listener: ReturnType<typeof Bun.serve> | null = null;
const previous: Record<string, string | undefined> = {};

function reply(method: string, params: Record<string, unknown>): unknown {
  server.calls.push(method);
  switch (method) {
    case 'initialize': return { codexHome: home, platformFamily: 'unix', platformOs: 'linux', userAgent: 'fake/0.160.0' };
    case 'thread/loaded/list': return { data: [THREAD], nextCursor: null };
    case 'account/read': return { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false };
    case 'account/rateLimits/read': return {
      accountId: ACCOUNT,
      ordinaryUsageAllowed: true,
      rateLimits: { planType: 'plus', spendControlReached: false, primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Math.floor((Date.now() + 3_600_000) / 1000) } }
    };
    case 'thread/queue/add': {
      const input = params['input'] as Array<{ text?: string }>;
      const entry = { id: `q-${server.queued.length + 1}`, clientUserMessageId: params['clientUserMessageId'] as string, text: input.map((part) => part.text ?? '').join('') };
      server.queued.push(entry);
      return { queuedSubmission: { id: entry.id, clientUserMessageId: entry.clientUserMessageId, input } };
    }
    case 'thread/queue/list': return { data: [], nextCursor: null };
    case 'thread/read': return {
      thread: {
        id: THREAD,
        turns: server.completed.map((turn, index) => ({
          id: `turn-${index + 1}`,
          status: 'completed',
          itemsView: 'full',
          items: [
            { type: 'userMessage', id: `u-${index}`, clientId: turn.clientUserMessageId, content: [] },
            ...Array.from({ length: turn.tools }, (_, tool) => ({ type: 'commandExecution', id: `c-${index}-${tool}` })),
            { type: 'agentMessage', id: `a-${index}`, text: turn.reply }
          ]
        }))
      }
    };
    default: return {};
  }
}

beforeAll(() => {
  home = mkdtempSync('/tmp/cpk-e2e-') /* short: macOS caps socket paths at 104 bytes */;
  const socketDir = join(home, 'app-server-control');
  mkdirSync(socketDir, { recursive: true });
  for (const key of ['CODEX_HOME', 'CODEX_PACEKEEPER_NATIVE_SOCKET', 'CODEX_PACEKEEPER_OWNER_FILE']) previous[key] = process.env[key];
  process.env['CODEX_HOME'] = home;
  delete process.env['CODEX_PACEKEEPER_NATIVE_SOCKET'];
  process.env['CODEX_PACEKEEPER_OWNER_FILE'] = join(home, 'no-registry.json');
  listener = Bun.serve({
    unix: join(socketDir, 'app-server-control.sock'),
    fetch(request, bunServer) {
      return bunServer.upgrade(request, { data: {} }) ? undefined : new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as { id?: number; method: string; params?: Record<string, unknown> };
        if (message.id === undefined) return;
        const send = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: reply(message.method, message.params ?? {}) }));
        if (message.method === 'account/rateLimits/read' && server.rateLimitsDelayMs > 0) setTimeout(send, server.rateLimitsDelayMs);
        else send();
      }
    }
  });
});

afterAll(() => {
  listener?.stop(true);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function serviceFor(store: CodexStore, nowMs: number): CodexService {
  return new CodexService({ config: CODEX_DEFAULTS, store, now: () => nowMs });
}

describe('keepalive end to end through the control socket (review #4)', () => {
  test('an idle thread with pending work is pinged, the pong is observed, and the next ping is scheduled', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-e2e-store-')));
    const now = Date.now();
    store.write({ accountId: null, threadId: THREAD }, 'timeline', { threadId: THREAD, accountId: ACCOUNT, pendingWork: true, sessionStartedAtMs: now - 3_600_000, lastEventAtMs: now - 31 * 60_000 });

    const first = await serviceFor(store, now).runDueJobs();
    const sent = first.find((job) => job.kind === 'keepalive');
    expect(sent?.state).toBe('queued');
    expect(server.queued.at(-1)?.text).toBe(KEEPALIVE_PING);
    expect(server.calls).toContain('account/rateLimits/read');

    // Codex runs the queued ping when the thread is idle; the model answers.
    server.completed.push({ clientUserMessageId: server.queued.at(-1)?.clientUserMessageId as string, reply: 'pong', tools: 0 });
    const second = await serviceFor(store, now + 60_000).runDueJobs();
    const done = second.find((job) => job.kind === 'keepalive');
    expect(done?.state).toBe('completed');
    expect(done?.pongVerified).toBe(true);

    const successor = serviceFor(store, now + 60_000).jobs().find((job) => job.kind === 'keepalive');
    expect(successor?.state).toBe('scheduled');
    expect(successor?.dueAtMs).toBe(now + 60_000 + CODEX_DEFAULTS.keepalive.interval_min * 60_000);
  });

  test('a rate-limits read as slow as the live backend still delivers the ping', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-e2e-store-slow-')));
    const now = Date.now();
    store.write({ accountId: null, threadId: THREAD }, 'timeline', { threadId: THREAD, accountId: ACCOUNT, pendingWork: true, sessionStartedAtMs: now - 3_600_000, lastEventAtMs: now - 31 * 60_000 });
    server.rateLimitsDelayMs = 1_100;
    try {
      const sent = (await serviceFor(store, now).runDueJobs()).find((job) => job.kind === 'keepalive');
      expect(sent?.state).toBe('queued');
    } finally { server.rateLimitsDelayMs = 0; }
  }, 15_000);

  test('a non-exact reply or a tool call keeps the chain alive and is recorded for doctor', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-e2e-store-loose-')));
    const now = Date.now();
    store.write({ accountId: null, threadId: THREAD }, 'timeline', { threadId: THREAD, accountId: ACCOUNT, pendingWork: true, sessionStartedAtMs: now - 3_600_000, lastEventAtMs: now - 31 * 60_000 });
    await serviceFor(store, now).runDueJobs();
    server.completed.push({ clientUserMessageId: server.queued.at(-1)?.clientUserMessageId as string, reply: 'Pong!', tools: 1 });
    const done = (await serviceFor(store, now + 60_000).runDueJobs()).find((job) => job.kind === 'keepalive');
    expect(done?.state).toBe('completed');
    expect(done?.pongVerified).toBe(false);
    const successor = serviceFor(store, now + 60_000).jobs().find((job) => job.kind === 'keepalive');
    expect(successor?.state).toBe('scheduled');
    expect(successor?.failureReason).toContain('"Pong!" with 1 tool call(s)');
  });

  test('recent activity defers the ping instead of sending it into a live session', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-e2e-store-active-')));
    const now = Date.now();
    store.write({ accountId: null, threadId: THREAD }, 'timeline', { threadId: THREAD, accountId: ACCOUNT, pendingWork: true, sessionStartedAtMs: now - 3_600_000, lastEventAtMs: now - 5 * 60_000 });
    const before = server.queued.length;
    await serviceFor(store, now).runDueJobs();
    expect(server.queued.length).toBe(before);
    const job = serviceFor(store, now).jobs().find((candidate) => candidate.kind === 'keepalive');
    expect(job?.state).toBe('scheduled');
    expect(job?.dueAtMs).toBe(now - 5 * 60_000 + CODEX_DEFAULTS.keepalive.interval_min * 60_000);
  });

  test('no pending work and no idle-stretch past the ceiling means no ping', async () => {
    const store = new CodexStore(mkdtempSync(join(tmpdir(), 'codex-e2e-store-none-')));
    const now = Date.now();
    store.write({ accountId: null, threadId: THREAD }, 'timeline', { threadId: THREAD, accountId: ACCOUNT, pendingWork: false, sessionStartedAtMs: now - 3_600_000, lastEventAtMs: now - 31 * 60_000 });
    await serviceFor(store, now).runDueJobs();
    expect(serviceFor(store, now).jobs()).toHaveLength(0);
    store.write({ accountId: null, threadId: THREAD }, 'timeline', { threadId: THREAD, accountId: ACCOUNT, pendingWork: true, sessionStartedAtMs: now - 20 * 3_600_000, lastEventAtMs: now - 13 * 3_600_000 });
    await serviceFor(store, now).runDueJobs();
    expect(serviceFor(store, now).jobs()).toHaveLength(0);
    expect(serviceFor(store, now).hasWork(now)).toBe(false);
  });
});
