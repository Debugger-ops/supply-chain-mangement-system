// A minimal Redis client interface, decoupled from any specific driver.
//
// Why this exists: InventoryService only needs EVAL/GET/SET/DEL. Keeping the
// interface narrow means:
//   - production code wires up `ioredis` (see IoRedisClient below) against a
//     real Redis / Redis Cluster deployment,
//   - CI / offline environments (e.g. this repo's own sandbox verification
//     script, which has no network access to npm) can run against a real
//     local `redis-server` process using RawRespClient, a ~120-line
//     zero-dependency RESP client, without pulling in ioredis at all.
//
// Both implementations talk to a *real* Redis instance — nothing here is a
// stub or fake. Swapping between them is a one-line change (see api/server.ts).

export interface RedisLike {
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<"OK">;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<void>;
}

/**
 * Zero-dependency Redis client speaking raw RESP2 over a TCP socket
 * (Node's built-in `net` module only). Supports exactly the commands
 * InventoryService needs. Not meant to replace ioredis in production —
 * see IoRedisClient below for that — but it talks to a genuinely real
 * Redis server, which is what matters for correctness testing.
 */
import { connect, Socket } from "node:net";

export class RawRespClient implements RedisLike {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private pending: Array<(v: unknown) => void> = [];
  private ready: Promise<void>;

  constructor(private host = "127.0.0.1", private port = 6379) {
    this.socket = connect({ host, port });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let progressed = true;
    while (progressed) {
      progressed = false;
      const result = tryParseReply(this.buffer);
      if (result) {
        this.buffer = this.buffer.subarray(result.consumed);
        const resolve = this.pending.shift();
        if (resolve) resolve(result.value);
        progressed = true;
      }
    }
  }

  private async send(...args: (string | number)[]): Promise<unknown> {
    await this.ready;
    const encoded = encodeCommand(args.map(String));
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.socket.write(encoded);
    });
  }

  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown> {
    return this.send("EVAL", script, numKeys, ...keysAndArgs);
  }
  get(key: string): Promise<string | null> {
    return this.send("GET", key) as Promise<string | null>;
  }
  set(key: string, value: string): Promise<"OK"> {
    return this.send("SET", key, value) as Promise<"OK">;
  }
  del(...keys: string[]): Promise<number> {
    return this.send("DEL", ...keys) as Promise<number>;
  }
  async quit(): Promise<void> {
    await this.send("QUIT");
    this.socket.end();
  }
}

function encodeCommand(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return out;
}

// Parses exactly one RESP2 reply from the front of `buf`, if a complete one
// is present. Returns null if more bytes are needed. Handles simple strings,
// errors, integers, bulk strings, and (one level of) arrays — sufficient for
// GET/SET/DEL/EVAL replies.
function tryParseReply(buf: Buffer, offset = 0): { value: unknown; consumed: number } | null {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf("\r\n", offset + 1);
  if (lineEnd === -1) return null;
  const line = buf.subarray(offset + 1, lineEnd).toString();

  switch (type) {
    case "+": // simple string
      return { value: line, consumed: lineEnd + 2 - offset };
    case "-": // error
      throw new Error(line);
    case ":": // integer
      return { value: Number(line), consumed: lineEnd + 2 - offset };
    case "$": { // bulk string
      const len = Number(line);
      if (len === -1) return { value: null, consumed: lineEnd + 2 - offset };
      const start = lineEnd + 2;
      if (buf.length < start + len + 2) return null;
      const value = buf.subarray(start, start + len).toString();
      return { value, consumed: start + len + 2 - offset };
    }
    case "*": { // array
      const count = Number(line);
      if (count === -1) return { value: null, consumed: lineEnd + 2 - offset };
      let cursor = lineEnd + 2;
      const values: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const item = tryParseReply(buf, cursor);
        if (!item) return null;
        values.push(item.value);
        cursor += item.consumed;
      }
      return { value: values, consumed: cursor - offset };
    }
    default:
      throw new Error(`Unsupported RESP type byte: ${type}`);
  }
}

/**
 * Production adapter: thin wrapper matching the same RedisLike interface,
 * backed by `ioredis`. This is what src/api/server.ts uses when
 * REDIS_DRIVER=ioredis (the default outside this repo's own sandbox).
 * Requires `npm install` to have pulled in ioredis.
 */
export async function createIoRedisClient(url: string): Promise<RedisLike> {
  const { default: IORedis } = await import("ioredis");
  const client = new IORedis(url);
  return {
    eval: (script, numKeys, ...rest) => client.eval(script, numKeys, ...(rest as string[])) as Promise<unknown>,
    get: (key) => client.get(key),
    set: async (key, value) => { await client.set(key, value); return "OK"; },
    del: (...keys) => client.del(...keys),
    quit: async () => { await client.quit(); },
  };
}
