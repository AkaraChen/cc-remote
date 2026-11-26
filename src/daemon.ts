import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import pkg from "../package.json";
import { openSpool } from "./spool";
import { BUSY, ENDED, GONE, PROTOCOL, REFUSED, readLine, type Ack, type Control, type Hello, type InstanceInfo, type SpawnSpec } from "./wire";

const envNum = (name: string, fallback: number) => {
  const n = Number(Bun.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const daemonDir = () => join(homedir(), ".cc-remote");
export const selfCmd = () =>
  Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/") ? [process.execPath] : [process.execPath, Bun.main];

const dial = (path: string) => new Promise<Socket>((resolve, reject) => {
  const s = connect({ path, allowHalfOpen: true });
  const fail = (err: Error) => { s.off("connect", ok).destroy(); reject(err); };
  const ok = () => { s.off("error", fail); resolve(s); };
  s.once("error", fail).once("connect", ok);
});

/** Sends one control request to the local daemon and returns the parsed JSON response. */
export function ask<T = any>(req: Control, dir = daemonDir(), timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = connect({ path: join(dir, "daemon.sock"), allowHalfOpen: true });
    let settled = false;
    const done = (err?: Error, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); detach(); s.destroy();
      err ? reject(err) : resolve(value as T);
    };
    const timer = setTimeout(() => done(new Error("daemon control timeout")), timeoutMs);
    const detach = readLine(s, (line, _rest, err) => {
      if (err || line === null) return done(err ?? new Error("daemon closed connection"));
      try { done(undefined, JSON.parse(line) as T); } catch (e) { done(e as Error); }
    });
    s.on("error", done).end(`${JSON.stringify(req)}\n`);
  });
}

/** Spawns a detached daemon process with stdout/stderr redirected to daemon.log. */
export function startDaemon(dir = daemonDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFd = openSync(join(dir, "daemon.log"), "a", 0o600);
  const [cmd, ...args] = selfCmd();
  spawn(cmd!, [...args, "daemon", "serve"], { detached: true, stdio: ["ignore", logFd, logFd] }).unref();
  closeSync(logFd);
}

/** Waits for the daemon socket to answer `{ version: true }`. */
export async function waitDaemon(dir = daemonDir(), timeoutMs = 5000): Promise<void> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await Bun.sleep(50)) {
    try { await ask({ version: true }, dir, 300); return; } catch {}
  }
  throw new Error("daemon did not become ready");
}

function bindSocket(server: Server, sockPath: string, dir: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let retried = false;
    const onListen = () => { server.off("error", onErr); resolve(true); };
    const onErr = async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        try { await ask({ version: true }, dir, 1000); server.off("listening", onListen); return resolve(false); } catch {}
        if (!retried) { retried = true; try { unlinkSync(sockPath); } catch {} return server.listen(sockPath); }
      }
      server.off("listening", onListen); reject(err);
    };
    server.once("listening", onListen).on("error", onErr).listen(sockPath);
  });
}

type Instance = {
  id: string; argv: string[]; cwd: string; child: ChildProcess; started: number;
  end: number; base: number; state: "running" | "detached" | "exited";
  client?: Socket; linger?: ReturnType<typeof setTimeout>;
};

/** Runs the long-lived daemon process listening on `~/.cc-remote/daemon.sock`. */
export async function serve(dir = daemonDir()): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sockPath = join(dir, "daemon.sock"), pidPath = join(dir, "daemon.pid");
  const cap = envNum("CC_REMOTE_SPOOL_BYTES", 64 * 1024 * 1024), keepBytes = Math.max(1, Math.floor(cap / 2));
  const lingerMs = envNum("CC_REMOTE_LINGER_MS", 30 * 60 * 1000);
  const server = createServer({ allowHalfOpen: true });
  if (!(await bindSocket(server, sockPath, dir))) return;
  chmodSync(sockPath, 0o600);
  writeFileSync(pidPath, String(process.pid));

  const spool = openSpool(join(dir, "daemon.db")), instances = new Map<string, Instance>();
  let stopping = false;

  const cleanup = () => { try { if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) { unlinkSync(pidPath); unlinkSync(sockPath); } } catch {} };
  const dropClient = (inst: Instance) => { const c = inst.client; inst.client = undefined; c?.end(); };
  const setLinger = (inst: Instance, fn: () => void) => { clearTimeout(inst.linger); inst.linger = stopping ? undefined : setTimeout(fn, lingerMs); };
  const forget = (inst: Instance) => { clearTimeout(inst.linger); if (instances.get(inst.id) === inst) instances.delete(inst.id); try { spool.drop(inst.id); } catch {} };
  const exited = (inst: Instance) => { if (inst.state !== "exited") { inst.state = "exited"; dropClient(inst); setLinger(inst, () => forget(inst)); } };
  const stopInstance = (inst: Instance) => {
    dropClient(inst);
    if (inst.state !== "exited") {
      inst.state = "exited";
      try { inst.child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { if (inst.child.exitCode === null && inst.child.signalCode === null) inst.child.kill("SIGKILL"); } catch {} }, 3000).unref();
    }
    forget(inst);
  };
  const append = (inst: Instance, chunk: Buffer) => {
    if (!chunk.length) return;
    const offset = inst.end; inst.end += chunk.length;
    try {
      spool.append(inst.id, offset, chunk);
      if (inst.end - inst.base > cap) inst.base = spool.trim(inst.id, keepBytes, inst.end, cap);
    } catch (err) { console.error(`cc-remoted: spool write failed for ${inst.id}:`, err); inst.base = inst.end; }
    if (inst.client && !inst.client.destroyed && inst.client.writable) inst.client.write(chunk);
  };

  const start = (id: string, spec: SpawnSpec): Instance | { error: string } => {
    if (!Array.isArray(spec?.argv) || typeof spec.argv[0] !== "string" || typeof spec.cwd !== "string") return { error: "invalid spawn spec" };
    const cwd = isAbsolute(spec.cwd) ? spec.cwd : join(homedir(), spec.cwd);
    const env: Record<string, string | undefined> = { ...process.env, ...spec.env, PATH: `${join(homedir(), ".local", "bin")}:${spec.env?.PATH ?? process.env.PATH ?? ""}` };
    let child: ChildProcess;
    try { mkdirSync(cwd, { recursive: true }); child = spawn(spec.argv[0], spec.argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
    const inst: Instance = { id, argv: spec.argv, cwd, child, started: Date.now(), end: 0, base: 0, state: "detached" };
    instances.set(id, inst);
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (c: Buffer) => append(inst, c));
    child.stderr!.on("data", (c: Buffer) => process.stderr.write(c));
    child.on("error", (err) => { console.error(`cc-remoted: spawn error for ${id}:`, err.message); exited(inst); });
    child.on("close", () => exited(inst));
    return inst;
  };

  const connectInstance = (inst: Instance, since: number, steal: boolean, socket: Socket, rest: Buffer, reply: (o: object) => void) => {
    if (!Number.isInteger(since) || since < inst.base || since > inst.end) return reply({ gone: true });
    if (inst.state === "exited" && since === inst.end) return reply({ gone: true });
    if (inst.client && !inst.client.destroyed) { if (!steal) return reply({ busy: true }); dropClient(inst); }
    clearTimeout(inst.linger);
    socket.write(`${JSON.stringify({ ok: true, protocol: PROTOCOL, id: inst.id, from: since })}\n`);
    try { spool.replay(inst.id, since, (c) => socket.write(c)); } catch (err) { console.error(`cc-remoted: replay failed for ${inst.id}:`, err); }
    if (inst.state === "exited") { socket.end(); return setLinger(inst, () => forget(inst)); }
    if (socket.readableEnded || socket.destroyed) { socket.end(); inst.state = "detached"; return setLinger(inst, () => stopInstance(inst)); }

    inst.state = "running"; inst.client = socket;
    const toChild = (buf: Buffer) => { if (inst.client === socket && buf.length && inst.child.stdin?.writable) inst.child.stdin.write(buf); };
    toChild(rest);
    // End socket on EOF so dead clients detach even when claude is silent, without closing claude's stdin.
    socket.on("data", toChild).on("end", () => socket.end());
    const detach = () => { if (inst.client === socket) { inst.client = undefined; if (inst.state === "running") { inst.state = "detached"; setLinger(inst, () => stopInstance(inst)); } } };
    socket.on("close", detach).on("error", detach);
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    for (const inst of [...instances.values()]) stopInstance(inst);
    server.close();
    try { spool.close(); } catch {}
    cleanup();
    process.exit(0);
  };

  server.on("connection", (socket) => {
    socket.on("error", () => {});
    readLine(socket, (line, rest, err) => {
      if (err || line === null) return socket.destroy();
      const reply = (obj: object) => socket.end(`${JSON.stringify(obj)}\n`);
      let req: Record<string, any>;
      try { req = JSON.parse(line); } catch { return reply({ error: "invalid json" }); }
      if (req.version) return reply({ version: pkg.version, protocol: PROTOCOL, pid: process.pid });
      if (req.status) return reply({ version: pkg.version, protocol: PROTOCOL, pid: process.pid, instances: [...instances.values()].map(({ id, state, child, cwd, started, base, end }): InstanceInfo => ({ id, state, pid: child.pid, cwd, started, base, end })) });
      if (typeof req.kill === "string") { const inst = instances.get(req.kill); if (!inst) return reply({ gone: true }); stopInstance(inst); return reply({ ok: true }); }
      if (req.stop) { socket.once("close", shutdown); return socket.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`, shutdown); }
      if (typeof req.id !== "string" || !req.id || typeof req.since !== "number") return reply({ error: "invalid request" });

      const hello = req as Hello;
      let inst = instances.get(hello.id);
      if (!inst) {
        if (!hello.spawn) return reply({ gone: true });
        const created = start(hello.id, hello.spawn);
        if ("error" in created) return reply(created);
        inst = created;
      }
      connectInstance(inst, hello.since, Boolean(hello.steal), socket, rest, reply);
    });
  });

  process.on("SIGHUP", () => {}).on("SIGTERM", shutdown).on("SIGINT", shutdown);
  await new Promise<void>(() => {});
}

/** Remote door invoked by `cc-remoted attach`: bridges stdio to the local daemon socket. */
export async function door(dir = daemonDir()): Promise<void> {
  const sockPath = join(dir, "daemon.sock");
  let socket: Socket | undefined;
  try { socket = await dial(sockPath); } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT" && e.code !== "ECONNREFUSED") throw err;
    startDaemon(dir);
    for (const end = Date.now() + 5000; Date.now() < end && !socket; await Bun.sleep(50)) try { socket = await dial(sockPath); } catch {}
    if (!socket) { console.error("cc-remoted: daemon did not start"); process.exit(1); }
  }

  let code = 1, done = false;
  const finish = () => {
    if (done) return;
    done = true; socket.destroy();
    if (!process.stdout.writable || process.stdout.isTTY) process.exit(code);
    else process.stdout.end(() => process.exit(code));
  };
  const writeOut = (chunk: Buffer) => { if (!process.stdout.write(chunk)) { socket.pause(); process.stdout.once("drain", () => socket.resume()); } };

  readLine(socket, (line, rest, err) => {
    if (err || line === null) return finish();
    try {
      const ack = JSON.parse(line) as Ack;
      // Once acked, socket close can only mean claude ended, --steal took over, or daemon stopped; never reconnect.
      code = "ok" in ack && ack.ok ? ENDED : "gone" in ack ? GONE : "busy" in ack ? BUSY : REFUSED;
    } catch { code = REFUSED; }
    process.stdout.write(`${line}\n`);
    socket.on("data", writeOut);
    if (rest.length) writeOut(rest);
  });

  socket.on("end", finish).on("close", finish).on("error", finish);
  process.stdout.on("error", () => { if (!done) { done = true; socket.destroy(); process.exit(code); } });
  process.stdin.on("data", (c) => { if (socket.writable) socket.write(c); }).on("end", () => socket.end()).on("error", () => {}).resume();
  await new Promise<void>(() => {});
}
