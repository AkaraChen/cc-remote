import type { Readable } from "node:stream";

export const PROTOCOL = 1;
export const ENDED = 0, GONE = 20, BUSY = 21, REFUSED = 22;

export type SpawnSpec = { argv: string[]; cwd: string; env: Record<string, string> };
export type Hello = { id: string; since: number; spawn?: SpawnSpec; steal?: boolean };
export type Ack = { ok: true; protocol: number; id: string; from: number } | { gone: true } | { busy: true } | { error: string };
export type InstanceInfo = { id: string; state: "running" | "detached" | "exited"; pid?: number; cwd: string; started: number; base: number; end: number };
export type Control = { version: true } | { status: true } | { kill: string } | { stop: true };

/** Reads one `\n`-delimited line, then detaches and passes the line plus any coalesced tail bytes. */
export function readLine(stream: Readable, onLine: (line: string | null, rest: Buffer, error?: Error) => void, maxBytes = 64 * 1024): () => void {
  const chunks: Buffer[] = [];
  let len = 0, done = false;
  const detach = () => { done = true; stream.off("data", onData).off("end", onEnd).off("close", onEnd).off("error", onError); };
  const finish = (line: string | null, rest: Buffer, error?: Error) => { if (!done) { detach(); onLine(line, rest, error); } };
  const onData = (raw: Buffer | Uint8Array | string) => {
    const c = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const nl = c.indexOf(10);
    if (nl >= 0) {
      if (len + nl > maxBytes) return finish(null, Buffer.alloc(0), new Error(`line exceeds ${maxBytes} bytes`));
      const head = chunks.length ? Buffer.concat([...chunks, c.subarray(0, nl)]) : c.subarray(0, nl);
      return finish((head.at(-1) === 13 ? head.subarray(0, -1) : head).toString("utf8"), c.subarray(nl + 1));
    }
    if ((len += c.length) > maxBytes) return finish(null, Buffer.alloc(0), new Error(`line exceeds ${maxBytes} bytes`));
    if (c.length) chunks.push(c);
  };
  const onEnd = () => finish(null, Buffer.alloc(0));
  const onError = (err: Error) => finish(null, Buffer.alloc(0), err);
  stream.on("data", onData).on("end", onEnd).on("close", onEnd).on("error", onError);
  return detach;
}
