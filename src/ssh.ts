import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { channel } from "./channel";
import { WINDOWS } from "./platform";
import { proxy } from "./proxy";
import { localTranscript } from "./sessions";

/** Single-quotes a word for a POSIX shell. */
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Client keepalives, so a silent dead link fails in about a minute instead of hanging the protocol.
 * Passed on the command line, so nothing in ~/.ssh/config has to change. OpenSSH keeps the first
 * value it sees: an earlier `-o` in `CC_REMOTE_SSH` still wins, and these beat the config file.
 */
const KEEPALIVE = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

/**
 * The ssh command, like rsync's RSYNC_RSH: `CC_REMOTE_SSH="ssh -p 2222"`, plus keepalives when
 * that command is ssh. By default sessions share one connection, since an ACP client may open
 * several at once and probe besides. Windows' OpenSSH can't multiplex, so there each session has
 * its own.
 */
export const rsh = () => {
  const custom = Bun.env.CC_REMOTE_SSH?.split(/\s+/).filter(Boolean);
  if (custom?.length) return /^ssh(\.exe)?$/i.test(custom[0]!.split(/[\\/]/).pop()!) ? [...custom, ...KEEPALIVE] : custom;
  if (WINDOWS) return ["ssh", ...KEEPALIVE];
  const socket = `/tmp/cc-remote-${userInfo().uid}-%C`;
  return ["ssh", "-o", "ControlMaster=auto", "-o", `ControlPath=${socket}`, "-o", "ControlPersist=10m", ...KEEPALIVE];
};

/** Native installs of claude live in ~/.local/bin, which non-interactive ssh shells often leave off PATH. */
export const REMOTE_PATH = `PATH="$HOME/.local/bin:$PATH"`;

/** A local path as a POSIX path for the host: `C:\Users\me` becomes `/C/Users/me`. */
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "/$1");

/** The host folder a local directory maps to, relative to the host's home. */
export const hostDir = (cwd: string) => `.cc-remote/ws/${hostname()}${posix(cwd)}`;

/** Enters a stable per-directory folder on the host, so sessions and --continue have a home. */
const enter = (cwd: string) => {
  const dir = `"$HOME"/${quote(hostDir(cwd))}`;
  return `mkdir -p ${dir} && cd ${dir}`;
};

/** The shell command the host runs: enter the folder, then exec claude. */
export function remoteCommand(args: string[], env: Record<string, string>, cwd: string): string {
  const vars = Object.entries(env).map(([k, v]) => quote(`${k}=${v}`));
  return `${enter(cwd)} && ${REMOTE_PATH} exec env ${vars.join(" ")} claude ${args.map(quote).join(" ")}`;
}

/**
 * Copies a transcript from stdin into claude's projects folder on the host, unless one is there.
 * The folder name is claude's: the real path with every non-alphanumeric turned to `-`.
 */
export function uploadCommand(sessionId: string, cwd: string): string {
  const projects = `"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd -P | sed 's/[^a-zA-Z0-9]/-/g')"`;
  const file = `"$P"/${quote(`${sessionId}.jsonl`)}`;
  return `${enter(cwd)} && P=${projects} && mkdir -p "$P" && if [ -f ${file} ]; then cat >/dev/null; else cat >${file}; fi`;
}

/** Runs claude on the host with these arguments, for `cc-remote --cli`. */
export function runRemote(host: string, args: string[], cwd: string): Promise<number> {
  const [ssh, ...flags] = rsh();
  const tty = process.stdin.isTTY && process.stdout.isTTY ? "-t" : "-T";
  const child = spawn(ssh!, [...flags, tty, host, remoteCommand(args, {}, cwd)], { stdio: "inherit" });
  return new Promise((done) => child.on("exit", (code) => done(code ?? 1)));
}

/** CC_REMOTE_DAEMON=off keeps every session on a direct ssh, even where the daemon is installed. */
export const daemonEnabled = () => (Bun.env.CC_REMOTE_DAEMON ?? "auto").toLowerCase() !== "off";

/** A failed probe is worth retrying, but not on every session: a minute between them is enough. */
const PROBE_DELAY = 60_000;
const probes = new Map<string, { at: number; version?: string; ms: number }>();

/**
 * Asks the host whether it runs the daemon ('cc-remoted version') and how long the round trip takes.
 * Cached per host: a version for as long as we run, a failure for a minute, so a host without the
 * daemon costs one probe a minute and sees nothing else change.
 */
export function probeDaemon(host: string, fresh = false): { version?: string; ms: number } {
  const known = probes.get(host);
  if (!fresh && known && (known.version || Date.now() - known.at < PROBE_DELAY)) return known;
  const [ssh, ...flags] = rsh();
  const started = performance.now();
  const probe = spawnSync(ssh!, [...flags, "-T", host, REMOTE_PATH + " cc-remoted version"], {
    encoding: "utf8",
    timeout: 4000,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const out = probe.status === 0 ? (probe.stdout ?? "").trim() : "";
  const version = /^cc-remote \S+ daemon \d+$/.test(out) ? out : undefined;
  const result = { at: Date.now(), version, ms: Math.round(performance.now() - started) };
  probes.set(host, result);
  return result;
}

const argument = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * The SDK normally spawns claude locally and talks to it over stdin/stdout. We hand it ssh
 * instead; the protocol, tool calls included, rides over the same two pipes.
 */
export function spawner(host: string, cwd: string, env: Record<string, string>) {
  return (options: SpawnOptions): SpawnedProcess => {
    // ssh forwards no environment, so pass along what the SDK and ACP added for claude.
    const added = Object.fromEntries(
      Object.entries(options.env).filter(
        (e): e is [string, string] => e[1] !== undefined && process.env[e[0]] !== e[1] && e[0] !== "CLAUDE_CONFIG_DIR",
      ),
    );
    const [ssh, ...flags] = rsh();
    const base = [ssh!, ...flags, "-T", host];
    const main = [...base, remoteCommand(options.args, { ...added, ...env }, cwd)];

    // A session the host has never seen (a fork, or one a local claude wrote) goes up first.
    const resume = argument(options.args, "--resume");
    const transcript = resume ? localTranscript(resume, cwd) : undefined;
    const upload = transcript && resume ? [...base, uploadCommand(resume, cwd)] : undefined;
    // With the daemon installed on the host, the ssh process is only a wire: claude belongs to the
    // daemon, so a dropped link is reconnected and the bytes resume where they stopped. Without it,
    // everything below is exactly what it was.
    if (daemonEnabled() && probeDaemon(host).version) {
      if (upload) {
        // The daemon starts claude itself, so a transcript the host lacks goes up first, as on Windows.
        const fd = openSync(transcript!, "r");
        spawnSync(upload[0]!, upload.slice(1), { stdio: [fd, "ignore", "inherit"], windowsHide: true });
        closeSync(fd);
      }
      const held = channel({
        ssh: [ssh!, ...flags],
        host,
        remote: REMOTE_PATH + " cc-remoted attach --stdio",
        steal: Boolean(Bun.env.CC_REMOTE_STEAL),
        signal: options.signal,
        // claude runs in the host folder; the daemon makes it and starts claude there.
        open: () => ({ spawn: { argv: ["claude", ...options.args], cwd: hostDir(cwd), env: { ...added, ...env } } }),
      });
      return proxy(held, { cwd, hostDir: hostDir(cwd), mode: argument(options.args, "--permission-mode") ?? "default" });
    }

    let command = main;
    if (transcript && upload) {
      if (WINDOWS) {
        // Windows has no sh to chain the two; there the upload finishes before claude starts.
        const fd = openSync(transcript, "r");
        spawnSync(ssh!, upload.slice(1), { stdio: [fd, "ignore", "inherit"], windowsHide: true });
        closeSync(fd);
      } else {
        command = ["sh", "-c", `${upload.map(quote).join(" ")} <${quote(transcript)}; exec ${main.map(quote).join(" ")}`];
      }
    }

    const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"], signal: options.signal, windowsHide: true });
    child.stderr!.on("data", (chunk) => process.stderr.write(chunk));
    return proxy(child, { cwd, hostDir: hostDir(cwd), mode: argument(options.args, "--permission-mode") ?? "default" });
  };
}
