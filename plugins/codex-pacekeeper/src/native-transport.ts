/** Minimal JSON-RPC transport for an already-running Codex app server. */
import { createHash, randomBytes } from 'crypto';
import { createConnection, type Socket } from 'net';
import { NativeClient, type NativeOwnerEndpoint, type NativeCapabilities } from './native';

export interface JsonRpcTransportOptions {
  endpoint: string;
  timeoutMs?: number;
  /** Injectable only for deterministic protocol fixtures; production uses net.createConnection. */
  socketFactory?: (socketPath: string) => Socket;
}

interface JsonRpcReply {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

const INITIALIZE_METHOD = 'initialize';
const INITIALIZED_METHOD = 'initialized';
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const CLIENT_INFO = {
  name: 'codex-pacekeeper',
  title: 'Codex Pacekeeper',
  version: '0.1.0'
} as const;

function initializeParams(): Record<string, unknown> {
  return {
    clientInfo: CLIENT_INFO,
    capabilities: { experimentalApi: true }
  };
}

function isInitializeResponse(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row['codexHome'] === 'string'
    && typeof row['platformFamily'] === 'string'
    && typeof row['platformOs'] === 'string'
    && typeof row['userAgent'] === 'string';
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

  public constructor(private readonly socketPath: string, private readonly timeoutMs: number, private readonly socketFactory: (socketPath: string) => Socket = createConnection) {}

  public request(method: string, params: unknown): Promise<unknown> {
    const initializeId = this.nextId++;
    const requestId = this.nextId++;
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
        socket = this.socketFactory(this.socketPath);
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
            if (reply.id === initializeId) {
              if (reply.error !== undefined) {
                finish(errorWithCode(reply.error));
              } else if (!isInitializeResponse(reply.result)) {
                finish(new Error('native initialize returned an invalid response'));
              } else {
                socket?.write(`${JSON.stringify({ jsonrpc: '2.0', method: INITIALIZED_METHOD })}\n`);
                socket?.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
              }
              continue;
            }
            if (reply.id !== requestId) continue;
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
          socket?.write(`${JSON.stringify({ jsonrpc: '2.0', id: initializeId, method: INITIALIZE_METHOD, params: initializeParams() })}\n`);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

/** Codex 0.160 Unix control sockets speak WebSocket over the Unix stream. */
class UnixWebSocketJsonRpcTransport {
  private nextId = 1;

  public constructor(private readonly socketPath: string, private readonly timeoutMs: number) {}

  public request(method: string, params: unknown): Promise<unknown> {
    const initializeId = this.nextId++;
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      let socket: Socket | null = null;
      let buffer = Buffer.alloc(0);
      let handshakeComplete = false;
      let handshakeKey = '';
      let fragmented = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        reject(new Error(`native websocket request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.destroy();
        if (error !== undefined) reject(error);
        else resolve(result);
      };
      const sendFrame = (payload: string | Buffer, opcode = 0x1): void => {
        if (!socket) return;
        const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
        if (body.length > MAX_FRAME_BYTES) {
          finish(new Error('native websocket frame is too large'));
          return;
        }
        const mask = randomBytes(4);
        let header: Buffer;
        if (body.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
        else if (body.length <= 0xffff) {
          header = Buffer.alloc(4);
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(body.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(body.length), 2);
        }
        const masked = Buffer.alloc(body.length);
        for (let i = 0; i < body.length; i += 1) masked[i] = (body[i] ?? 0) ^ (mask[i % 4] ?? 0);
        socket.write(Buffer.concat([header, mask, masked]));
      };
      const handleMessage = (text: string): void => {
        let reply: JsonRpcReply;
        try { reply = JSON.parse(text) as JsonRpcReply; } catch { return; }
        if (reply.id === initializeId) {
          if (reply.error !== undefined) finish(errorWithCode(reply.error));
          else if (!isInitializeResponse(reply.result)) finish(new Error('native initialize returned an invalid response'));
          else {
            sendFrame(JSON.stringify({ jsonrpc: '2.0', method: INITIALIZED_METHOD }));
            sendFrame(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
          }
          return;
        }
        if (reply.id !== requestId) return;
        if (reply.error !== undefined) finish(errorWithCode(reply.error));
        else finish(undefined, reply.result);
      };
      const parseFrames = (): void => {
        while (buffer.length >= 2) {
          const first = buffer[0] ?? 0;
          const second = buffer[1] ?? 0;
          const fin = (first & 0x80) !== 0;
          const opcode = first & 0x0f;
          const masked = (second & 0x80) !== 0;
          let length = second & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (buffer.length < 10) return;
            const wide = buffer.readBigUInt64BE(2);
            if (wide > BigInt(Number.MAX_SAFE_INTEGER)) { finish(new Error('native websocket frame is too large')); return; }
            length = Number(wide);
            offset = 10;
          }
          if (length > MAX_FRAME_BYTES) { finish(new Error('native websocket frame is too large')); return; }
          const maskOffset = masked ? 4 : 0;
          if (buffer.length < offset + maskOffset + length) return;
          const mask = masked ? buffer.subarray(offset, offset + 4) : null;
          const start = offset + maskOffset;
          const payload = Buffer.from(buffer.subarray(start, start + length));
          buffer = buffer.subarray(start + length);
          if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
          if (opcode === 0x8) { finish(new Error('native websocket closed before the JSON-RPC response')); return; }
          if (opcode === 0x9) { sendFrame(payload, 0xA); continue; }
          if (opcode !== 0x0 && opcode !== 0x1) continue;
          fragmented = opcode === 0x1 ? payload : Buffer.concat([fragmented, payload]);
          if (fragmented.length > MAX_FRAME_BYTES) { finish(new Error('native websocket message is too large')); return; }
          if (!fin) continue;
          const text = fragmented.toString('utf8');
          fragmented = Buffer.alloc(0);
          handleMessage(text);
          if (settled) return;
        }
      };
      try {
        socket = createConnection(this.socketPath);
        socket.on('data', (chunk: Buffer | string) => {
          buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
          if (!handshakeComplete) {
            const marker = buffer.indexOf(Buffer.from('\r\n\r\n'));
            if (marker < 0) return;
            const header = buffer.subarray(0, marker + 4).toString('ascii');
            buffer = buffer.subarray(marker + 4);
            const accept = /\bsec-websocket-accept:\s*([^\s]+)\s/im.exec(header)?.[1];
            const expectedAccept = createHash('sha1').update(`${handshakeKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
            if (!/^HTTP\/1\.1 101\s/m.test(header)
              || !/\bupgrade:\s*websocket\b/im.test(header)
              || accept !== expectedAccept) {
              finish(new Error('native Unix endpoint did not accept WebSocket upgrade'));
              return;
            }
            handshakeComplete = true;
            sendFrame(JSON.stringify({ jsonrpc: '2.0', id: initializeId, method: INITIALIZE_METHOD, params: initializeParams() }));
          }
          parseFrames();
        });
        socket.once('error', (error: Error) => finish(error));
        socket.once('close', () => { if (!settled) finish(new Error('native websocket closed before the JSON-RPC response')); });
        socket.once('connect', () => {
          handshakeKey = randomBytes(16).toString('base64');
          socket?.write([
            'GET / HTTP/1.1',
            'Host: localhost',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${handshakeKey}`,
            'Sec-WebSocket-Version: 13',
            '',
            ''
          ].join('\r\n'));
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
    const initializeId = this.nextId++;
    const requestId = this.nextId++;
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
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: initializeId, method: INITIALIZE_METHOD, params: initializeParams() }));
      });
      ws.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        let reply: JsonRpcReply;
        try { reply = JSON.parse(data) as JsonRpcReply; } catch { return; }
        if (reply.id === initializeId) {
          if (reply.error !== undefined) {
            finish(errorWithCode(reply.error));
          } else if (!isInitializeResponse(reply.result)) {
            finish(new Error('native initialize returned an invalid response'));
          } else {
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: INITIALIZED_METHOD }));
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
          }
          return;
        }
        if (reply.id !== requestId) return;
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
  private readonly delegate: UnixJsonRpcTransport | UnixWebSocketJsonRpcTransport | WebSocketJsonRpcTransport;

  public constructor(options: JsonRpcTransportOptions) {
    const endpoint = parseEndpoint(options.endpoint);
    const timeoutMs = options.timeoutMs ?? 2000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('native transport timeout must be positive');
    this.delegate = endpoint.kind === 'unix'
      ? options.socketFactory !== undefined
        ? new UnixJsonRpcTransport(endpoint.value, timeoutMs, options.socketFactory)
        : new UnixWebSocketJsonRpcTransport(endpoint.value, timeoutMs)
      : new WebSocketJsonRpcTransport(endpoint.value, timeoutMs);
  }

  public request(method: string, params: unknown): Promise<unknown> {
    return this.delegate.request(method, params);
  }
}

/** Construct a client only for an owner record that already supplied an endpoint. */
export function clientForExistingOwner(owner: NativeOwnerEndpoint, capabilities: NativeCapabilities, timeoutMs = 2000): NativeClient | null {
  const endpoint = owner.socketPath ?? owner.endpoint;
  if (!endpoint) return null;
  return new NativeClient(new JsonRpcTransport({ endpoint, timeoutMs }), capabilities, owner);
}
