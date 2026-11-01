import { tool } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, root } from "./util";

const MAX_OUTPUT = 30_000;
const PWD_FILE = join(tmpdir(), `cc-remote-pwd-${process.pid}`);

/** Like Claude Code's Bash: the working directory persists between calls. */
let cwd = root;

/** Every command runs in its own process group so a timeout kills its children too. */
const groups = new Set<number>();
export const killAll = () => {
  for (const pid of groups) try { process.kill(-pid, "SIGKILL"); } catch {}
};

function run(command: string, timeoutMs: number, signal?: AbortSignal) {
  // The trap records where the command left us; `exec 2>&1` interleaves stderr like a terminal would.
  const script = `trap 'pwd -P >| "$__CC_REMOTE_PWD"' EXIT\nexec 2>&1\n${command}`;
  return new Promise<{ out: string; code: number | null; timedOut: boolean }>((resolve) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, __CC_REMOTE_PWD: PWD_FILE },
    });
    groups.add(child.pid!);
    let out = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => { if (out.length <= MAX_OUTPUT) out += chunk; };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener("abort", kill);

    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ out, code, timedOut });
    };
    child.on("close", finish);
    // A backgrounded child (`cmd &`) can hold the pipe open after bash exits. Don't wait for it.
    child.on("exit", (code) => setTimeout(() => finish(code), 200));
  });
}

export const bash = tool(
  "Bash",
  `Executes a bash command on the user's local machine and returns its combined stdout and stderr.

- The working directory persists between commands (cd carries over); environment variables and shell functions do not
- Prefer absolute paths so you don't depend on the current directory
- Default timeout is 120000ms (2 minutes); max is 600000ms (10 minutes)
- Output over ${MAX_OUTPUT} characters is truncated
- The command gets no stdin; avoid interactive commands
- Prefer Read, Edit, Write, Glob and Grep over cat, sed, echo >, find and grep for file work
- Chain dependent commands with &&; make independent calls in parallel in one response`,
  {
    command: z.string().describe("The command to execute"),
    timeout: z.number().optional().describe("Optional timeout in milliseconds (max 600000)"),
    description: z.string().optional().describe("Clear, concise description of what this command does in 5-10 words"),
  },
  async ({ command, timeout }, extra) => {
    const limit = Math.min(Math.max(timeout ?? 120_000, 1_000), 600_000);
    const { out, code, timedOut } = await run(command, limit, (extra as { signal?: AbortSignal })?.signal);

    const newCwd = (await Bun.file(PWD_FILE).text().catch(() => "")).trim();
    if (newCwd) cwd = newCwd;

    let text = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n\n... [output truncated]` : out.trimEnd();
    if (timedOut) text += `\nCommand timed out after ${limit}ms`;
    if (code !== 0 && code !== null) text += `${text ? "\n" : ""}Exit code ${code}`;
    if (timedOut || code !== 0) return err(text || "Command failed");
    return ok(text || "(No output)");
  },
);
