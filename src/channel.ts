import { type ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { SpawnLike } from "./proxy";

/**
 * A claude session carried over ssh to a host that runs `cc-remoted`.
 *
 * The ssh process is only the wire: the daemon on the far side owns claude, so losing the wire is
 * not losing the session. Each connection says one line about what it wants, the daemon answers with
 * one line, and from then on it is claude's own bytes in both directions — no frames, no sequence
 * numbers, no acknowledgements. ssh brings the authentication, the ordering and the keepalives.
 */
export type ChannelOptions = {
  /** The ssh command from rsh(): transport, authentication and keepalives. */
  ssh: string[];
  host: string;
  /** The command that reaches the daemon, run on the host. */
  remote: string;
  /** What a new connection asks for: the instance we already know, or a fresh claude. */
  open: () => Preamble;
  /** Take an instance over from another client instead of being refused (CC_REMOTE_STEAL). */
  steal?: boolean;
  /** The SDK's abort signal; aborting ends the session as killing it does. */
  signal?: AbortSignal;
};

/** Either a new claude on the host, or an instance that is already running there. */
export type Preamble =
  | { spawn: { argv: string[]; cwd: string; env: Record<string, string> } }
  | { attach: string; since: number; steal?: boolean };

/** The daemon's answer. `from` is the spool offset of the first byte it will send. */
type Ack = { ok?: boolean; from?: number; id?: string; gone?: boolean; busy?: boolean; error?: string };

/**
 * Exit codes of `cc-remoted attach --stdio`, which ssh hands on as its own. Anything else means the
 * wire failed, and that a reconnect is worth trying.
 */
export const ENDED = 0; // claude exited; every byte it wrote has been delivered
export const GONE = 20; // no such instance, or its spool no longer reaches back to `since`
export const BUSY = 21; // another client is attached to that instance
export const REFUSED = 22; // the daemon would not take the preamble

/** Reconnect delays: half a second doubling to eight, with jitter so a rebooted host isn't hammered. */
const wait = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);

/** The init message claude starts with; it names the session both sides key on. */
function sessionId(line: string): string | undefined {
  if (!line.includes('"session_id"')) return undefined;
  try {
    const m = JSON.parse(line);
    return m?.type === "system" && m?.subtype === "init" && typeof m.session_id === "string" ? m.session_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps an ssh session to the host's daemon in what proxy() needs: stdin and stdout as claude's own,
 * an offset that survives a dropped link, and an exit event only when claude itself is gone.
 */
export function channel(o: ChannelOptions): SpawnLike {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const listeners = { exit: new Set<(...args: any[]) => void>(), error: new Set<(...args: any[]) => void>() };
  const queued: Buffer[] = []; // what the SDK wrote while the wire was down
  let id: string | undefined; // what an attach names: claude's session, or the daemon's key before that
  let since = 0; // bytes of claude's stdout handed to the SDK; where a reconnect resumes
  let attempt = 0; // reconnects in a row, for the backoff
  let head = Buffer.alloc(0); // the start of the stream, until the init line names the session
  let child: ChildProcess | undefined;
  let ready = false; // this connection got its ack and is carrying claude's bytes
  let stopped = false;
  let done = false;
  let ended = false; // the SDK closed its side while the wire was down
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;

  const emit = (event: "exit" | "error", ...args: any[]) => {
    for (const listener of listeners[event]) listener(...args);
  };

  const deliver = (chunk: Buffer) => {
    since += chunk.length;
    stdout.write(chunk);
    if (id) return;
    head = Buffer.concat([head, chunk]);
    for (let nl = head.indexOf(10); nl >= 0; nl = head.indexOf(10)) {
      const line = head.subarray(0, nl).toString("utf8");
      head = head.subarray(nl + 1);
      id = sessionId(line);
      if (id) break;
    }
    // No init message in the first 64 KiB: give up on finding the session id and stop holding bytes.
    if (head.length > 64 * 1024) head = Buffer.alloc(0);
  };

  /**
   * The session is over: claude exited, or the daemon has nothing left to attach us to. The stream
   * ends first, so the SDK reads the last line before it hears about the exit.
   */
  const finish = (status: number, why?: NodeJS.Signals | null) => {
    if (done) return;
    done = true;
    code = status;
    signal = why ?? null;
    stdout.end();
    setImmediate(() => emit("exit", code, signal));
  };

  const write = (to: ChildProcess, chunk: Buffer) => {
    if (to.stdin?.writable) to.stdin.write(chunk);
  };

  /** Whatever the SDK said while we were away goes out now, before anything new. */
  const flush = () => {
    if (!ready || !child) return;
    for (const chunk of queued.splice(0)) write(child, chunk);
  };

  const connect = () => {
    ready = false;
    head = Buffer.alloc(0);
    const preamble: Preamble = id ? { attach: id, since, ...(o.steal ? { steal: true } : {}) } : o.open();
    const proc = spawn(o.ssh[0]!, [...o.ssh.slice(1), "-T", o.host, o.remote], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    // A write racing the end of the wire must not crash us; the exit event is how we find out.
    proc.stdin?.on("error", () => {});
    proc.stdout?.on("error", () => {});
    write(proc, Buffer.from(JSON.stringify(preamble) + "\n"));

    let ack = Buffer.alloc(0);
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (ready) return deliver(chunk);
      ack = Buffer.concat([ack, chunk]);
      const nl = ack.indexOf(10);
      if (nl < 0) return; // the answer is still arriving
      let answer: Ack;
      try {
        answer = JSON.parse(ack.subarray(0, nl).toString("utf8"));
      } catch {
        answer = { error: "unreadable answer from the daemon" };
      }
      if (!answer.ok) {
        if (answer.busy) process.stderr.write("cc-remote: another client is attached to that session; --steal takes it over\n");
        else if (answer.error) process.stderr.write(`cc-remote: daemon: ${answer.error}\n`);
        return; // the exit event ends the session; there is nothing to reconnect to
      }
      ready = true;
      attempt = 0;
      id = id ?? answer.id;
      since = answer.from ?? since;
      const rest = ack.subarray(nl + 1);
      if (rest.length) deliver(rest);
      flush();
      if (ended) proc.stdin?.end();
    });

    proc.on("exit", (status, why) => {
      child = undefined;
      if (stopped || done) return;
      if (status === ENDED || status === GONE) return finish(0);
      if (status === BUSY || status === REFUSED) return finish(1);
      // The wire went away, not claude: wait, then ask the daemon for the bytes after `since`.
      const delay = wait(attempt++);
      process.stderr.write(`cc-remote: ssh to ${o.host} dropped (${status ?? why}); reconnecting in ${Math.round(delay)} ms\n`);
      setTimeout(() => !stopped && !done && connect(), delay);
    });
    proc.on("error", (e: Error) => {
      if (!stopped) process.stderr.write(`cc-remote: ssh: ${e.message}\n`);
    });
  };

  stdin.on("data", (chunk: Buffer) => {
    if (ready && child) write(child, chunk);
    else queued.push(chunk);
  });
  // The SDK closing its side ends the session for us; the daemon keeps claude until its linger runs out.
  stdin.on("end", () => {
    ended = true;
    child?.stdin?.end();
  });

  const stop = (why?: NodeJS.Signals) => {
    if (stopped) return;
    stopped = true;
    child?.kill(why ?? "SIGTERM");
    finish(0, why);
  };
  o.signal?.addEventListener("abort", () => stop("SIGTERM"), { once: true });

  connect();

  return {
    stdin,
    stdout,
    get killed() {
      return stopped;
    },
    get exitCode() {
      return done ? code : null;
    },
    get signalCode() {
      return signal;
    },
    kill: (why) => {
      stop(why);
      return true;
    },
    on: (event, listener) => listeners[event].add(listener),
    once: (event, listener) => {
      const once = (...args: any[]) => {
        listeners[event].delete(once);
        listener(...args);
      };
      listeners[event].add(once);
    },
    off: (event, listener) => {
      listeners[event].delete(listener);
    },
  } as SpawnLike;
}
