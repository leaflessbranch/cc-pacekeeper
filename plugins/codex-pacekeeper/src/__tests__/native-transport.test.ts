import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import { JsonRpcTransport } from '../native-transport';

function fixtureSocket(onRequest: (request: { id?: number; method: string; params?: Record<string, unknown>; }) => unknown): Socket {
  const socket = new EventEmitter() as EventEmitter & Partial<Socket>;
  socket.setEncoding = () => socket as unknown as Socket;
  socket.destroy = () => socket as unknown as Socket;
  socket.write = (chunk: string | Uint8Array) => {
    const request = JSON.parse(String(chunk).trim()) as { id?: number; method: string; params?: Record<string, unknown> };
    const reply = onRequest(request);
    if (reply !== undefined) queueMicrotask(() => socket.emit('data', JSON.stringify(reply) + '\n'));
    return true;
  };
  queueMicrotask(() => socket.emit('connect'));
  return socket as unknown as Socket;
}

describe('bounded native transport', () => {
  test('sends one JSON-RPC request to an existing Unix owner and preserves replies', async () => {
    let initialized = false;
    const socket = fixtureSocket((request) => {
      if (request.method === 'initialize') {
        expect(request.params?.['capabilities']).toEqual({ experimentalApi: true });
        expect(request.params?.['clientInfo']).toMatchObject({ name: 'codex-pacekeeper', version: '0.1.0' });
        return { jsonrpc: '2.0', id: request.id, result: { codexHome: '/fixture-codex-home', platformFamily: 'unix', platformOs: 'linux', userAgent: 'codex/0.153.4' } };
      }
      if (request.method === 'initialized') {
        initialized = true;
        expect(request.id).toBeUndefined();
        return undefined;
      }
      expect(initialized).toBe(true);
      return { jsonrpc: '2.0', id: request.id, result: { method: request.method, params: request.params } };
    });
    const transport = new JsonRpcTransport({ endpoint: 'unix:///fixture-owner.sock', timeoutMs: 500, socketFactory: () => socket });
    await expect(transport.request('thread/queue/list', { threadId: 'thread-1' })).resolves.toEqual({ method: 'thread/queue/list', params: { threadId: 'thread-1' } });
  });

  test('rejects an owner that does not return the native initialize shape', async () => {
    const socket = fixtureSocket((request) => ({ jsonrpc: '2.0', id: request.id, result: {} }));
    const transport = new JsonRpcTransport({ endpoint: 'unix:///fixture-invalid.sock', timeoutMs: 500, socketFactory: () => socket });
    await expect(transport.request('thread/queue/list', { threadId: 'thread-1' })).rejects.toThrow(/initialize/);
  });

  test('rejects non-owner endpoint schemes before opening a socket', () => {
    expect(() => new JsonRpcTransport({ endpoint: 'http://example.invalid' })).toThrow(/native endpoint/);
  });
});
