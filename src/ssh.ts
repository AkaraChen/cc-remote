import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { hostname } from "node:os";

/** Single-quotes a word for a POSIX shell. */
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The ssh command, like rsync's RSYNC_RSH: `CC_REMOTE_SSH="ssh -p 2222"`. */
export const rsh = () => (process.env.CC_REMOTE_SSH ?? "ssh").split(/\s+/).filter(Boolean);

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
    const [ssh, ...flags] = rsh();
    return spawn(ssh!, [...flags, "-T", host, remoteCommand(options.args, { ...added, ...env }, cwd)], {
      stdio: ["pipe", "pipe", "inherit"],
      signal: options.signal,
    });
  };
}
