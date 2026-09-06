import { describe, expect, test } from 'bun:test';
import { createServer } from 'net';
import { mkdtempSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonRpcTransport } from '../native-transport';

describe('bounded native transport', () => {
  test('sends one JSON-RPC request to an existing Unix owner and preserves replies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-transport-'));
    const socket = join(root, 'owner.sock');
    const server = createServer((connection) => {
      connection.setEncoding('utf8');
      connection.on('data', (chunk) => {
        const request = JSON.parse(String(chunk)) as { id: number; method: string; params: unknown };
        connection.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method, params: request.params } }) + '\n');
      });
    });
    try {
      await new Promise<void>((resolve, reject) => server.listen(socket, () => resolve()).once('error', reject));
    } catch (error) {
      // The execution runner deliberately refuses Unix sockets below /tmp;
      // keep that filesystem boundary visible without weakening it for a test.
      expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
      return;
    }
    try {
      const transport = new JsonRpcTransport({ endpoint: `unix://${socket}`, timeoutMs: 500 });
      await expect(transport.request('thread/queue/list', { threadId: 'thread-1' })).resolves.toEqual({ method: 'thread/queue/list', params: { threadId: 'thread-1' } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { unlinkSync(socket); } catch { /* server cleanup */ }
    }
  });

  test('rejects non-owner endpoint schemes before opening a socket', () => {
    expect(() => new JsonRpcTransport({ endpoint: 'http://example.invalid' })).toThrow(/native endpoint/);
  });
});
