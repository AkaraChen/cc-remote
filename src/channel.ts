import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, openSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { SpawnLike } from "./proxy";
import { REMOTE_PATH } from "./ssh";
import { BUSY, ENDED, GONE, PROTOCOL, REFUSED, readLine, type Ack, type Hello, type SpawnSpec } from "./wire";

export type ChannelOptions = {
  ssh: string[]; spawn: SpawnSpec; signal?: AbortSignal; steal?: boolean;
  remoteCommand?: string; upload?: { cmd: string[]; file: string };
};

/** Reconnecting SSH channel to the remote `cc-remoted attach` door with byte-offset resume. */
export function channel(opts: ChannelOptions): SpawnLike {
  const id = randomUUID();
  const steal = opts.steal ?? (Bun.env.CC_REMOTE_STEAL === "1" || Bun.env.CC_REMOTE_STEAL === "true");
  const stdin = new PassThrough(), stdout = new PassThrough(), events = new EventEmitter();
  let since = 0, connectedOnce = false, ready = false, ended = false, finished = false, killed = false;
  let exitCode: number | null = null, signalCode: NodeJS.Signals | null = null, attempt = 0;
  let queued: Buffer[] = [], child: ChildProcess | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (code: number | null, signal: NodeJS.Signals | null = null, err?: Error) => {
    if (finished) return;
    finished = true; ready = false;
    clearTimeout(reconnectTimer); reconnectTimer = undefined;
    opts.signal?.removeEventListener("abort", onAbort);
    exitCode = code; signalCode = signal; stdout.end();
    err ? events.emit("error", err) : events.emit("exit", code, signal);
  };
  const stop = (sig: NodeJS.Signals = "SIGTERM", err?: Error) => {
    if (finished) return false;
    killed = true;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(sig);
    finish(null, sig, err);
    return true;
  };
  const onAbort = () => {
    const r = opts.signal?.reason;
    stop("SIGTERM", r instanceof Error ? r : Object.assign(new Error("Aborted"), { name: "AbortError" }));
  };

  stdin.on("data", (raw: Buffer | Uint8Array | string) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (ready && child?.stdin?.writable) child.stdin.write(chunk);
    else queued.push(chunk);
  }).on("end", () => {
    ended = true;
    if (ready && child?.stdin?.writable) child.stdin.end();
  }).on("error", () => {});

  const scheduleReconnect = () => {
    if (finished) return;
    const delay = Math.min(3000, 500 * 2 ** attempt++) * (0.75 + Math.random() / 2);
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, delay);
  };

  const connect = () => {
    if (finished) return;
    const [cmd, ...baseArgs] = opts.ssh;
    const proc = spawn(cmd!, [...baseArgs, opts.remoteCommand ?? `${REMOTE_PATH} exec cc-remoted attach`], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    let acked = false;
    proc.stdin!.on("error", () => {});
    proc.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    const hello: Hello = connectedOnce
      ? { id, since, ...(steal ? { steal: true } : {}) }
      : { id, since: 0, spawn: opts.spawn, ...(steal ? { steal: true } : {}) };
    proc.stdin!.write(`${JSON.stringify(hello)}\n`);

    const forward = (chunk: Buffer) => { if (chunk.length && !finished) { since += chunk.length; stdout.write(chunk); } };
    const reject = (msg: string, code: number) => {
      console.error(`cc-remote: ${msg}`);
      try { proc.kill(); } catch {}
      finish(code, null);
    };

    const detachLine = readLine(proc.stdout!, (line, rest, err) => {
      if (finished || child !== proc) return;
      if (err || line === null) { if (err) reject(`daemon handshake failed: ${err.message}`, 1); return; }
      let ack: Ack;
      try { ack = JSON.parse(line) as Ack; } catch { return reject(`invalid daemon ack: ${line}`, REFUSED); }
      if (!("ok" in ack) || !ack.ok) {
        if ("gone" in ack) return reject("remote session is gone (expired or trimmed)", GONE);
        if ("busy" in ack) return reject("remote session is already attached (set CC_REMOTE_STEAL=1 to take over)", BUSY);
        return reject(`daemon refused session: ${"error" in ack ? ack.error : line}`, REFUSED);
      }
      if (ack.protocol !== PROTOCOL) {
        return reject(`daemon protocol mismatch (expected ${PROTOCOL}, got ${ack.protocol}); reinstall or restart cc-remoted on the host`, 1);
      }
      acked = true; connectedOnce = true; attempt = 0; ready = true; since = ack.from;
      const pending = queued; queued = [];
      for (const q of pending) if (proc.stdin!.writable) proc.stdin!.write(q);
      if (ended && proc.stdin!.writable) proc.stdin!.end();
      proc.stdout!.on("data", forward);
      forward(rest);
    });

    proc.on("error", (err) => {
      if (finished || child !== proc) return;
      detachLine(); ready = false; child = undefined;
      if (!connectedOnce && (err as NodeJS.ErrnoException).code === "ENOENT") return finish(null, null, err);
      scheduleReconnect();
    });
    proc.on("close", (code, sig) => {
      if (finished || child !== proc) return;
      detachLine(); ready = false; child = undefined;
      if (acked && code === ENDED) return finish(ENDED, sig);
      if (code === GONE || code === BUSY || code === REFUSED) return finish(code, null);
      scheduleReconnect();
    });
  };

  if (opts.signal?.aborted) {
    queueMicrotask(onAbort);
  } else {
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.upload) {
      const fd = openSync(opts.upload.file, "r");
      const [uCmd, ...uArgs] = opts.upload.cmd;
      const up = spawn(uCmd!, uArgs, { stdio: [fd, "ignore", "inherit"], windowsHide: true });
      closeSync(fd); child = up;
      let started = false;
      const go = () => { if (!started) { started = true; if (child === up) child = undefined; connect(); } };
      up.on("close", go).on("error", go);
    } else connect();
  }

  return {
    stdin, stdout,
    get killed() { return killed; }, get exitCode() { return exitCode; }, get signalCode() { return signalCode; },
    kill: (signal) => stop(signal),
    on: (e, l) => events.on(e, l), once: (e, l) => events.once(e, l), off: (e, l) => events.off(e, l),
  };
}
