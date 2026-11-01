import { tool } from "@anthropic-ai/claude-agent-sdk";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { WINDOWS } from "../platform";
import { err, ok, type Workspace } from "./util";

export const MAX_OUTPUT = 30_000;
export const TMP = tmpdir();
let calls = 0;

/**
 * Every command runs in its own process group (a process tree on Windows), so a timeout kills
 * everything it started. Ctrl-C doesn't reach other groups, so whatever is still running dies
 * with cc-remote.
 */
const groups = new Set<number>();
const kill = (pid: number) => {
  if (WINDOWS) Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
  else try { process.kill(-pid, "SIGKILL"); } catch {}
};
export const killAll = () => {
  for (const pid of groups) kill(pid);
};

/** How one shell runs a command. The script it runs writes its final directory to $__CC_REMOTE_PWD, unless that is empty. */
export type Shell = {
  name: string;
  description: string;
  argv: (command: string) => string[];
  /** Files argv wrote for the command, to remove once it exits if it didn't remove them itself. */
  cleanup?: (argv: string[]) => void;
  stopHint: (pid: number) => string;
};

const spawn = (argv: string[], ws: Workspace, pwdFile: string, dest: "pipe" | number) =>
  Bun.spawn(argv, {
    cwd: ws.cwd,
    detached: !WINDOWS,
    windowsHide: true,
    stdin: "ignore",
    stdout: dest,
    stderr: dest,
    env: { ...Bun.env, __CC_REMOTE_PWD: pwdFile },
  });

/** Like Claude Code's Bash: the working directory persists between calls, through ws.cwd. */
async function run(shell: Shell, ws: Workspace, command: string, timeoutMs: number, signal?: AbortSignal) {
  const pwdFile = join(TMP, `cc-remote-pwd-${process.pid}-${++calls}`);
  const argv = shell.argv(command);
  const proc = spawn(argv, ws, pwdFile, "pipe");
  groups.add(proc.pid);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; kill(proc.pid); }, timeoutMs);
  signal?.addEventListener("abort", () => kill(proc.pid));

  // Both streams land in one buffer in the order they arrive, as a terminal would show them.
  let out = "";
  const readers = [proc.stdout, proc.stderr].map((s) => (s as ReadableStream<Uint8Array>).getReader());
  const reading = Promise.all(readers.map(async (reader) => {
    const decoder = new TextDecoder();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if (out.length <= MAX_OUTPUT) out += decoder.decode(r.value, { stream: true });
    }
  }));
  const code = await proc.exited;
  clearTimeout(timer);
  groups.delete(proc.pid);
  shell.cleanup?.(argv);
  // A backgrounded child (`cmd &`) can hold the pipe open after the shell exits. Don't wait for it.
  await Promise.race([reading, Bun.sleep(200)]);
  await Promise.all(readers.map((r) => r.cancel()));
  const pwd = Bun.file(pwdFile);
  const newCwd = (await pwd.text().catch(() => "")).trim();
  if (newCwd) ws.cwd = newCwd;
  await pwd.delete().catch(() => {});
  return { out, code, timedOut };
}

/** run_in_background: output goes to a file the model can Read; the command dies with cc-remote. */
function background(shell: Shell, ws: Workspace, command: string) {
  const output = join(TMP, `cc-remote-bg-${process.pid}-${Date.now()}.log`);
  const argv = shell.argv(command);
  const fd = openSync(output, "a");
  const proc = spawn(argv, ws, "", fd);
  closeSync(fd);
  proc.unref();
  groups.add(proc.pid);
  proc.exited.then(() => {
    groups.delete(proc.pid);
    shell.cleanup?.(argv);
  });
  return ok(
    `Command running in background with ID: ${proc.pid}. Output is being written to: ${output}. Read that file to check its output. Stop it with ${shell.name}: ${shell.stopHint(proc.pid)}. It stops when this session ends.`,
  );
}

export const shellTool = (shell: Shell) => (ws: Workspace) => tool(
  shell.name,
  shell.description,
  {
    command: z.string().describe("The command to execute"),
    timeout: z.number().optional().describe("Optional timeout in milliseconds (max 600000)"),
    description: z.string().optional().describe("Clear, concise description of what this command does in 5-10 words"),
    run_in_background: z.boolean().optional().describe("Set to true to run this command in the background. Read the output file it returns to check on it."),
  },
  async ({ command, timeout, run_in_background }, extra) => {
    if (run_in_background) return background(shell, ws, command);
    const limit = Math.min(Math.max(timeout ?? 120_000, 1_000), 600_000);
    const { out, code, timedOut } = await run(shell, ws, command, limit, (extra as { signal?: AbortSignal })?.signal);

    let text = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n\n... [output truncated]` : out.trimEnd();
    if (timedOut) text += `${text ? "\n" : ""}Command timed out after ${limit}ms`;
    else if (code !== 0) text += `${text ? "\n" : ""}Exit code ${code}`;
    if (timedOut || code !== 0) return err(text);
    return ok(text || "(No output)");
  },
);
