/** Minimal JSON-RPC transport for an already-running Codex app server. */
import { createConnection, type Socket } from 'net';
import { NativeClient, type ExistingOwnerRecord, type NativeCapabilities } from './native';

export interface JsonRpcTransportOptions {
  endpoint: string;
  timeoutMs?: number;
}

interface JsonRpcReply {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

function errorWithCode(error: { code?: unknown; message?: unknown; data?: unknown }): Error & { code?: unknown; data?: unknown } {
  const out = new Error(typeof error.message === 'string' ? error.message : 'native JSON-RPC request failed') as Error & { code?: unknown; data?: unknown };
  out.code = error.code;
  out.data = error.data;
  return out;
}

function parseEndpoint(endpoint: string): { kind: 'unix' | 'ws'; value: string } {
  if (endpoint.startsWith('unix://')) {
    const value = endpoint.slice('unix://'.length);
    if (!value.startsWith('/') || value.includes('\u0000')) throw new Error('native unix endpoint must be an absolute path');
    return { kind: 'unix', value };
  }
  if (/^wss?:\/\/[^\s]+$/.test(endpoint)) return { kind: 'ws', value: endpoint };
  throw new Error('native endpoint must be unix:// or ws://');
}

class UnixJsonRpcTransport {
  private nextId = 1;

  public constructor(private readonly socketPath: string, private readonly timeoutMs: number) {}

  public request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let socket: Socket | null = null;
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        reject(new Error(`native request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.destroy();
        if (error !== undefined) reject(error);
        else resolve(result);
      };
      try {
        socket = createConnection(this.socketPath);
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string | Buffer) => {
          buffer += chunk.toString();
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (line === '') continue;
            let reply: JsonRpcReply;
            try { reply = JSON.parse(line) as JsonRpcReply; } catch { continue; }
            if (reply.id !== id) continue;
            if (reply.error !== undefined) finish(errorWithCode(reply.error));
            else finish(undefined, reply.result);
            return;
          }
        });
        socket.once('error', (error: Error) => finish(error));
        socket.once('close', () => {
          if (!settled) finish(new Error('native endpoint closed before the JSON-RPC response'));
        });
        socket.once('connect', () => {
          socket?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

class WebSocketJsonRpcTransport {
  private nextId = 1;

  public constructor(private readonly endpoint: string, private readonly timeoutMs: number) {}

  public request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error(`native websocket request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        if (error !== undefined) reject(error);
        else resolve(result);
      };
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
      ws.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        let reply: JsonRpcReply;
        try { reply = JSON.parse(data) as JsonRpcReply; } catch { return; }
        if (reply.id !== id) return;
        if (reply.error !== undefined) finish(errorWithCode(reply.error));
        else finish(undefined, reply.result);
      });
      ws.addEventListener('error', () => finish(new Error('native websocket request failed')));
      ws.addEventListener('close', () => {
        if (!settled) finish(new Error('native websocket closed before the JSON-RPC response'));
      });
    });
  }
}

export class JsonRpcTransport {
  private readonly delegate: UnixJsonRpcTransport | WebSocketJsonRpcTransport;

  public constructor(options: JsonRpcTransportOptions) {
    const endpoint = parseEndpoint(options.endpoint);
    const timeoutMs = options.timeoutMs ?? 2000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('native transport timeout must be positive');
    this.delegate = endpoint.kind === 'unix'
      ? new UnixJsonRpcTransport(endpoint.value, timeoutMs)
      : new WebSocketJsonRpcTransport(endpoint.value, timeoutMs);
  }

  public request(method: string, params: unknown): Promise<unknown> {
    return this.delegate.request(method, params);
  }
}

/** Construct a client only for an owner record that already supplied an endpoint. */
export function clientForExistingOwner(owner: ExistingOwnerRecord, capabilities: NativeCapabilities, timeoutMs = 2000): NativeClient | null {
  if (!owner.socketPath) return null;
  return new NativeClient(new JsonRpcTransport({ endpoint: owner.socketPath, timeoutMs }), capabilities, owner);
}
