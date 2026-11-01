import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { hostname } from "node:os";

/** Single-quotes a word for a POSIX shell. */
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The ssh command, like rsync's RSYNC_RSH: `CC_REMOTE_SSH="ssh -p 2222"`. */
export const rsh = () => (process.env.CC_REMOTE_SSH ?? "ssh").split(/\s+/).filter(Boolean);

/**
 * Client keepalives, so a silent dead link fails in about a minute instead of hanging the protocol.
 * Passed on the command line, so nothing in ~/.ssh/config has to change. OpenSSH keeps the first
 * value it sees: an earlier `-o` in `CC_REMOTE_SSH` still wins, and these beat the config file.
 */
const KEEPALIVE = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

/** `$CC_REMOTE_SSH`, plus keepalives when that command is ssh, then `-T`, the host, and the remote command. */
export function sshArgs(host: string, remote: string): string[] {
  const args = rsh();
  const bin = args[0]?.split("/").pop();
  return [...args, ...(bin === "ssh" ? KEEPALIVE : []), "-T", host, remote];
}

/** Native installs of claude live in ~/.local/bin, which non-interactive ssh shells often leave off PATH. */
export const REMOTE_PATH = `PATH="$HOME/.local/bin:$PATH"`;

/** The shell command the remote side runs: cd into a stable per-directory folder, then exec claude. */
export function remoteCommand(args: string[], env: Record<string, string>, cwd: string): string {
  const dir = `"$HOME"/.cc-remote/ws/${quote(hostname() + cwd)}`;
  const vars = Object.entries(env).map(([k, v]) => quote(`${k}=${v}`));
  return `mkdir -p ${dir} && cd ${dir} && ${REMOTE_PATH} exec env ${vars.join(" ")} claude ${args.map(quote).join(" ")}`;
}

/**
 * The SDK normally spawns claude locally and talks to it over stdin/stdout.
 * We hand it ssh instead; the protocol, tool calls included, rides over the same two pipes.
 */
export function spawner(host: string, cwd: string, env: Record<string, string>) {
  return (options: SpawnOptions): SpawnedProcess => {
    // ssh forwards no environment, so pass along what the SDK added for claude.
    const added = Object.fromEntries(
      Object.entries(options.env).filter((e): e is [string, string] => e[1] !== undefined && process.env[e[0]] !== e[1]),
    );
    const [ssh, ...flags] = sshArgs(host, remoteCommand(options.args, { ...added, ...env }, cwd));
    return spawn(ssh!, flags, {
      stdio: ["pipe", "pipe", "inherit"],
      signal: options.signal,
    });
  };
}
