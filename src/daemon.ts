import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Socket, createServer, connect as netConnect, type Server } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import pkg from "../package.json";
import { BUSY, ENDED, GONE, REFUSED } from "./channel";

/**
 * The server side of the daemon: claude's parent, so a dropped ssh link is only a dropped wire.
 *
 * `cc-remoted attach --stdio` is the door — one ssh connection, one line of preamble, raw bytes after
 * it. The instance table, the spools and the draining live here.
 *
 * Three invariants this file exists to keep:
 *   1. claude's stdout is read to the end, listener or no listener. An unread pipe blocks claude in
 *      its own write, so every chunk goes to the spool first and to a client second.
 *   2. claude is never killed because a client went away. A missing client only means nobody is
 *      listening; the instance keeps running until its linger timer runs out.
 *   3. The jsonl transcript on the server is the truth and the spool is only a cache. Losing the
 *      daemon costs a resume, never a conversation.
 */

/** The protocol between channel.ts and this file: one line of preamble, one line of answer. */
export const PROTOCOL = 1;

export const root = () => join(homedir(), ".cc-remote");
export const runDir = () => join(root(), "run");
export const sockPath = () => join(runDir(), "daemon.sock");
export const pidPath = () => join(runDir(), "daemon.pid");
export const spoolDir = () => join(root(), "spool");
export const logFile = () => join(root(), "daemon.log");

/** Bounds one instance's spool; past it the oldest bytes go and a client that needs them gets gone. */
type Settings = { cap: number; linger: number };
const settings: Settings = { cap: 64 * 1024 * 1024, linger: 30 * 60 * 1000 };

type State = "starting" | "running" | "detached" | "exited";

/** One attached ssh connection. sent is the spool offset of the next byte this client needs. */
type Client = { socket: Socket; sent: number; queue: Buffer[]; replaying: boolean };

type Instance = {
  /** The daemon's own name, in use until claude says which session it is. */
  key: string;
  id?: string;
  argv: string[];
  child: ChildProcess;
  started: number;
  end: number; // bytes of stdout written to the spool
  base: number; // the first byte the spool still holds
  fd: number;
  spool: string;
  state: State;
  client?: Client;
  linger?: ReturnType<typeof setTimeout>;
  head: Buffer; // the start of the stream, until the init line names the session
};

/** Keyed by key and, once known, also by claude's session id. */
const instances = new Map<string, Instance>();
let counter = 0;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Session ids are uuids; this keeps a hostile one out of the spool's file names. */
const name = (id: string) => id.replace(/[^\w.-]/g, "_");

/** The init message claude opens with: it names the session, which outlives any single connection. */
function sessionId(line: string): string | undefined {
  if (!line.includes('"session_id"')) return undefined;
  try {
    const m = JSON.parse(line);
    return m?.type === "system" && m?.subtype === "init" && typeof m.session_id === "string" ? m.session_id : undefined;
  } catch {
    return undefined;
  }
}

/** Starts claude for a client that asked for one. */
function start(argv: string[], cwd: string, env: Record<string, string>): Instance {
  const key = `p${process.pid.toString(36)}${(counter++).toString(36)}`;
  const dir = isAbsolute(cwd) ? cwd : join(homedir(), cwd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
  const spool = join(spoolDir(), `${key}.log`);
  const fd = openSync(spool, "a+", 0o600);
  // The daemon's PATH first, so claude installed in ~/.local/bin is found as it is over a plain ssh.
  const path = [join(homedir(), ".local/bin"), process.env.PATH ?? ""].filter(Boolean).join(":");
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: dir,
    env: { ...process.env, ...env, PATH: path },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const inst: Instance = { key, argv, child, started: Date.now(), end: 0, base: 0, fd, spool, state: "starting", head: Buffer.alloc(0) };
  instances.set(key, inst);
  child.stdout!.on("data", (chunk: Buffer) => append(inst, chunk));
  child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stdin!.on("error", () => {});
  child.on("exit", () => exited(inst));
  return inst;
}

/** Drains claude's stdout: always into the spool, then to whoever is attached. */
function append(inst: Instance, chunk: Buffer) {
  if (inst.state === "exited") return;
  try {
    writeSync(inst.fd, chunk);
  } catch (e) {
    // A full disk must not stop the drain: claude would block on its next write and the session with it.
    process.stderr.write("cc-remoted: cannot write " + inst.spool + ": " + (e as Error).message + "\n");
  }
  const from = inst.end;
  inst.end += chunk.length;
  learn(inst, chunk);
  if (inst.client) send(inst.client, chunk, from);
  if (inst.end - inst.base > settings.cap) trim(inst);
}

/** Reads the first init line out of the stream and gives the instance claude's own name. */
function learn(inst: Instance, chunk: Buffer) {
  if (inst.id) return;
  inst.head = Buffer.concat([inst.head, chunk]);
  for (let nl = inst.head.indexOf(10); nl >= 0; nl = inst.head.indexOf(10)) {
    const line = inst.head.subarray(0, nl).toString("utf8");
    inst.head = inst.head.subarray(nl + 1);
    const id = sessionId(line);
    if (!id) continue;
    inst.id = name(id);
    if (inst.state === "starting") inst.state = "running";
    instances.set(inst.id, inst);
    // The spool answers to claude's session id too, which is what `daemon logs` and the docs use.
    const named = join(spoolDir(), `${inst.id}.log`);
    try {
      if (existsSync(named)) unlinkSync(named);
      linkSync(inst.spool, named);
    } catch {} // A different filesystem: the key still names it.
    break;
  }
  if (inst.head.length > 64 * 1024) inst.head = Buffer.alloc(0);
}

/** Hands a live chunk to a client, or holds it if the client is still catching up from the spool. */
function send(c: Client, chunk: Buffer, from: number) {
  if (c.socket.destroyed) return;
  if (c.replaying || c.sent !== from) {
    c.queue.push(chunk);
    return;
  }
  c.sent += chunk.length;
  c.socket.write(chunk);
}

/** Drops all but the newest cap bytes: a client that asks for older ones is told they are gone. */
function trim(inst: Instance) {
  const keep = settings.cap;
  const tail = Buffer.allocUnsafe(keep);
  let pos = inst.end - keep;
  let got = 0;
  while (got < keep) {
    const n = readSync(inst.fd, tail, got, keep - got, pos - inst.base);
    if (n <= 0) break;
    got += n;
    pos += n;
  }
  truncateSync(inst.spool, 0);
  writeSync(inst.fd, tail.subarray(0, got));
  inst.base = inst.end - got;
}

/** claude is gone. Everyone attached hears the end of the stream, and the spool keeps the last bytes. */
function exited(inst: Instance) {
  if (inst.state === "exited") return;
  clearTimeout(inst.linger);
  inst.linger = undefined;
  inst.state = "exited";
  inst.client?.socket.end();
  inst.client = undefined;
  // Keep the instance reachable for a while, so a client that reconnects just after gets the tail.
  setTimeout(() => forget(inst), settings.linger).unref?.();
}

function forget(inst: Instance) {
  if (inst.state !== "exited") return;
  if (instances.get(inst.key) === inst) instances.delete(inst.key);
  if (inst.id && instances.get(inst.id) === inst) instances.delete(inst.id);
  try {
    closeSync(inst.fd);
  } catch {}
}

function kill(inst: Instance) {
  if (inst.state === "exited") return;
  inst.child.kill("SIGTERM");
}

function drop(inst: Instance) {
  const c = inst.client;
  inst.client = undefined;
  c?.socket.end();
}

/** Sends the one line a connection starts with, then everything the client has not seen yet. */
function open(socket: Socket, inst: Instance, since: number) {
  socket.write(JSON.stringify({ ok: true, from: since, id: inst.key, session: inst.id }) + "\n");
  const client: Client = { socket, sent: since, queue: [], replaying: true };
  inst.client = client;
  clearTimeout(inst.linger);
  inst.linger = undefined;
  if (inst.state === "detached") inst.state = "running";
  replay(inst, client);
  const leave = () => {
    if (inst.client !== client) return;
    inst.client = undefined;
    client.socket.end(); // the client is done writing; nothing it reads from here matters
    detach(inst);
  };
  socket.on("close", leave);
  socket.on("end", leave);
}

/** Everything from since to what the spool has now, then the live stream. Synchronous: no interleaving. */
function replay(inst: Instance, c: Client) {
  const upto = inst.end;
  const buf = Buffer.allocUnsafe(64 * 1024);
  while (c.sent < upto) {
    const n = readSync(inst.fd, buf, 0, Math.min(buf.length, upto - c.sent), c.sent - inst.base);
    if (n <= 0) break;
    c.socket.write(buf.subarray(0, n));
    c.sent += n;
  }
  c.replaying = false;
  for (const chunk of c.queue.splice(0)) {
    c.sent += chunk.length;
    c.socket.write(chunk);
  }
  // An instance that ended while nobody listened says so by closing: the client turns that into an exit.
  if (inst.state === "exited") c.socket.end();
}

/** A client is gone. claude keeps running and keeps being drained; only the linger clock starts. */
function detach(inst: Instance) {
  if (inst.state !== "running" && inst.state !== "starting") return;
  inst.state = "detached";
  clearTimeout(inst.linger);
  inst.linger = setTimeout(() => kill(inst), settings.linger);
  inst.linger.unref?.();
}

/** The one-line answer that ends a connection instead of carrying claude's bytes. */
const refuse = (socket: Socket, answer: object): undefined => {
  socket.write(JSON.stringify(answer) + "\n");
  socket.end();
  return undefined;
};

function attach(socket: Socket, id: string, since: number, steal: boolean): Instance | undefined {
  const inst = instances.get(id);
  if (!inst) return refuse(socket, { gone: true });
  if (since < inst.base) return refuse(socket, { gone: true }); // the spool no longer reaches back that far
  if (inst.state === "exited" && since >= inst.end) return refuse(socket, { gone: true }); // nothing left to send
  if (inst.client && !steal) return refuse(socket, { busy: true });
  if (inst.client) drop(inst); // --steal: the other wire is closed, its claude is left alone
  open(socket, inst, since);
  return inst;
}

function spawnFor(socket: Socket, request: { argv?: string[]; cwd?: string; env?: Record<string, string> }): Instance | undefined {
  const { argv, cwd = ".", env = {} } = request;
  if (!Array.isArray(argv) || !argv.length) return refuse(socket, { error: "spawn needs argv" });
  // A connection that died before it read the answer comes back as a spawn: pick its own instance up
  // instead of starting a second claude. The answer's id still names it from here on.
  const twin = [...instances.values()].find((i) => i.state === "starting" && !i.client && i.argv.join("\0") === argv.join("\0"));
  const inst = twin ?? start(argv, cwd, env);
  open(socket, inst, inst.end);
  return inst;
}

/** One ssh connection: a line of preamble, an answer, then claude's bytes in both directions. */
function serveSocket(socket: Socket) {
  let head = Buffer.alloc(0);
  let inst: Instance | undefined;

  socket.on("error", () => {});

  const onData = (chunk: Buffer) => {
    if (inst) {
      if (inst.child.stdin?.writable) inst.child.stdin.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const nl = head.indexOf(10);
    if (nl < 0) {
      if (head.length > 64 * 1024) socket.destroy();
      return;
    }
    const rest = head.subarray(nl + 1);
    // The same listener stays: once an instance is attached, its chunks go to claude.

    let p: any;
    try {
      p = JSON.parse(head.subarray(0, nl).toString("utf8"));
    } catch {
      return refuse(socket, { error: "unreadable preamble" });
    }

    if (p.version) return refuse(socket, { version: pkg.version, protocol: PROTOCOL, pid: process.pid });
    if (p.status) return refuse(socket, status());
    if (typeof p.kill === "string") {
      const target = instances.get(p.kill);
      if (!target) return refuse(socket, { error: "no such instance" });
      kill(target);
      return refuse(socket, { ok: true });
    }
    if (p.spawn) inst = spawnFor(socket, p.spawn);
    else if (typeof p.attach === "string") inst = attach(socket, p.attach, Number(p.since) || 0, Boolean(p.steal));
    else return refuse(socket, { error: "unknown request" });
    if (inst && rest.length && inst.child.stdin?.writable) inst.child.stdin.write(rest);
  };

  socket.on("data", onData);
}

function status() {
  const now = Date.now();
  return {
    version: pkg.version,
    protocol: PROTOCOL,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    instances: [...new Set(instances.values())].map((i) => ({
      id: i.id ?? i.key,
      key: i.key,
      state: i.state,
      attached: Boolean(i.client),
      bytes: i.end,
      age: Math.round((now - i.started) / 1000),
      spool: i.spool,
      argv: i.argv,
    })),
  };
}

/** Listens on the unix socket, taking over one left behind by a daemon that died. */
async function listen(): Promise<Server | undefined> {
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const server = createServer(serveSocket);
  for (let tries = 0; tries < 2; tries++) {
    const failure = await new Promise<NodeJS.ErrnoException | undefined>((done) => {
      const failed = (e: NodeJS.ErrnoException) => {
        server.off("listening", ready);
        done(e);
      };
      const ready = () => {
        server.off("error", failed);
        done(undefined);
      };
      server.once("error", failed);
      server.once("listening", ready);
      server.listen(sockPath());
    });
    if (!failure) return server;
    if (failure.code !== "EADDRINUSE" || (await ask({ version: true }))) throw failure;
    unlinkSync(sockPath()); // left behind by a daemon that died
  }
  throw new Error(`cannot listen on ${sockPath()}`);
}

/**
 * The daemon. It holds every instance, drains every claude and answers on the unix socket until it is
 * told to stop; the commands in main.ts start, inspect and stop it.
 */
export async function serve(opts: Partial<Settings> = {}): Promise<number> {
  Object.assign(settings, opts);
  const server = await listen();
  if (!server) {
    process.stderr.write("cc-remoted: another daemon is already running\n");
    return 0;
  }
  chmodSync(sockPath(), 0o600);
  writeFileSync(pidPath(), `${process.pid}\n`);
  const stop = async () => {
    for (const inst of new Set(instances.values())) kill(inst);
    await sleep(50);
    server.close();
    cleanup();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // A hangup is not a reason to stop: the whole point is that claude outlives the shell that started it.
  process.on("SIGHUP", () => {});
  // The daemon is claude's parent, so its death must take claude with it rather than leave an orphan
  // writing into nobody's pipe.
  process.on("uncaughtException", (e) => {
    process.stderr.write("cc-remoted: " + (e as Error).stack + "\n");
    for (const inst of new Set(instances.values())) kill(inst);
    cleanup();
    process.exit(1);
  });
  process.on("exit", cleanup);
  return new Promise<number>(() => {}); // until a signal ends it
}

function cleanup() {
  try {
    if (readFileSync(pidPath(), "utf8").trim() === String(process.pid)) unlinkSync(pidPath());
  } catch {}
  try {
    unlinkSync(sockPath());
  } catch {}
}

/** One line over the unix socket, for the commands in main.ts: status, version, kill. */
export async function ask(request: object, timeout = 3000): Promise<any | undefined> {
  const socket = await reachable(800);
  if (!socket) return undefined;
  return new Promise((done) => {
    let buf = Buffer.alloc(0);
    const finish = (answer: any) => {
      clearTimeout(timer);
      socket.destroy();
      done(answer);
    };
    const timer = setTimeout(() => finish(undefined), timeout);
    socket.on("error", () => finish(undefined));
    socket.on("close", () => finish(undefined));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.subarray(0, nl).toString("utf8")));
      } catch {
        finish(undefined);
      }
    });
    socket.write(JSON.stringify(request) + "\n");
  });
}

/** The daemon answers on its socket, so it is running. */
const reachable = (wait: number) =>
  new Promise<Socket | undefined>((done) => {
    if (!existsSync(sockPath())) return done(undefined);
    const socket = netConnect(sockPath());
    const timer = setTimeout(() => {
      socket.destroy();
      done(undefined);
    }, wait);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      done(undefined);
    });
  });

/** How to run this same cc-remote again: a compiled binary runs itself, a script needs bun in front. */
const self = () => (Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/") ? [] : [Bun.main]);

/** The local cc-remote command line, for a unit file or a wrapper script. */
export const selfCommand = () => [process.execPath, ...self()].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");

/** Starts the daemon in the background, for hosts where nobody ran daemon install. */
export function startDaemon(): void {
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const log = openSync(logFile(), "a", 0o600);
  const child = spawn(process.execPath, [...self(), "daemon", "serve"], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  closeSync(log);
}

/**
 * The door: what an ssh connection runs on the host. It is deliberately dumb — one connection to the
 * daemon's socket, the client's preamble straight through, then bytes. Its exit code is how the client
 * tells claude exiting from the wire dying.
 */
export async function door(argv: string[]): Promise<number> {
  const steal = argv.includes("--steal");
  let socket = await reachable(500);
  if (!socket) {
    startDaemon();
    for (let i = 0; i < 60 && !socket; i++) {
      await sleep(50);
      socket = await reachable(500);
    }
  }
  const link = socket;
  if (!link) {
    process.stderr.write("cc-remoted: cannot reach the daemon\n");
    return REFUSED;
  }

  let head = Buffer.alloc(0);
  let sent = false;
  process.stdin.on("data", (chunk: Buffer) => {
    if (sent) return link.write(chunk);
    head = Buffer.concat([head, chunk]);
    const nl = head.indexOf(10);
    if (nl < 0) return;
    let line = head.subarray(0, nl).toString("utf8");
    if (steal) {
      try {
        line = JSON.stringify({ ...JSON.parse(line), steal: true });
      } catch {} // A preamble we cannot read is the daemon's to refuse.
    }
    link.write(line + "\n");
    sent = true;
    if (head.length > nl + 1) link.write(head.subarray(nl + 1));
  });
  process.stdin.on("end", () => link.end());
  process.stdin.on("error", () => link.end());

  let ack = Buffer.alloc(0);
  let code = REFUSED;
  link.on("data", (chunk: Buffer) => {
    if (code === ENDED) return process.stdout.write(chunk);
    ack = Buffer.concat([ack, chunk]);
    const nl = ack.indexOf(10);
    if (nl < 0) return;
    const line = ack.subarray(0, nl).toString("utf8");
    process.stdout.write(line + "\n");
    let answer: any = {};
    try {
      answer = JSON.parse(line);
    } catch {}
    if (!answer.ok) {
      code = answer.gone ? GONE : answer.busy ? BUSY : REFUSED;
      link.end();
      return;
    }
    code = ENDED; // from here on, a closed socket means claude exited
    if (ack.length > nl + 1) process.stdout.write(ack.subarray(nl + 1));
  });
  link.on("error", () => {});
  link.on("close", () => {
    process.stdin.pause();
    process.stdin.destroy();
    process.stdout.write("", () => process.exit(code));
    setTimeout(() => process.exit(code), 1000).unref();
  });
  return new Promise<number>(() => {});
}
