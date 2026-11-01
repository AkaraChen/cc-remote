import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { err, ok, root } from "./util";

const MAX_OUTPUT = 30_000;
const TMP = (Bun.env.TMPDIR ?? "/tmp").replace(/\/$/, "");
const PWD_FILE = `${TMP}/cc-remote-pwd-${process.pid}`;

/** Like Claude Code's Bash: the working directory persists between calls. */
let cwd = root;

/**
 * Every command runs in its own process group, so a timeout kills everything it started.
 * Ctrl-C doesn't reach other groups, so whatever is still running dies with cc-remote.
 */
const groups = new Set<number>();
export const killAll = () => {
  for (const pid of groups) try { process.kill(-pid, "SIGKILL"); } catch {}
};
const kill = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch {} };

/** The trap records where the command left us; `exec 2>&1` interleaves stderr like a terminal would. */
const script = (command: string) => `exec 2>&1\ntrap 'pwd -P >| "$__CC_REMOTE_PWD"' EXIT\n${command}`;

async function run(command: string, timeoutMs: number, signal?: AbortSignal) {
  const proc = Bun.spawn(["bash", "-c", script(command)], {
    cwd,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...Bun.env, __CC_REMOTE_PWD: PWD_FILE },
  });
  groups.add(proc.pid);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; kill(proc.pid); }, timeoutMs);
  signal?.addEventListener("abort", () => kill(proc.pid));

  let out = "";
  const reader = proc.stdout.getReader();
  const reading = (async () => {
    const decoder = new TextDecoder();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if (out.length <= MAX_OUTPUT) out += decoder.decode(r.value, { stream: true });
    }
  })();
  const code = await proc.exited;
  clearTimeout(timer);
  // A backgrounded child (`cmd &`) can hold the pipe open after bash exits. Don't wait for it.
  await Promise.race([reading, Bun.sleep(200)]);
  await reader.cancel();
  return { out, code, timedOut };
}

/** run_in_background: output goes to a file the model can Read; the command dies with cc-remote. */
function background(command: string) {
  const output = `${TMP}/cc-remote-bg-${process.pid}-${Date.now()}.log`;
  const proc = Bun.spawn(["bash", "-c", script(command)], {
    cwd,
    detached: true,
    stdin: "ignore",
    stdout: Bun.file(output),
    stderr: "ignore",
    env: { ...Bun.env, __CC_REMOTE_PWD: `${PWD_FILE}-bg` },
  });
  proc.unref();
  groups.add(proc.pid);
  return ok(
    `Command running in background with ID: ${proc.pid}. Output is being written to: ${output}. Read that file to check its output. Stop it with Bash: kill -- -${proc.pid}. It stops when this session ends.`,
  );
}

export const bash = tool(
  "Bash",
  `Executes a bash command on the user's local machine and returns its combined stdout and stderr.

- The working directory persists between commands (cd carries over); environment variables and shell functions do not
- Prefer absolute paths so you don't depend on the current directory
- Default timeout is 120000ms (2 minutes); max is 600000ms (10 minutes)
- Output over ${MAX_OUTPUT} characters is truncated
- The command gets no stdin; avoid interactive commands
- Set run_in_background for long-running processes such as dev servers. You get back an ID and an output file to Read; the process stops when the session ends
- Prefer Read, Edit, Write, Glob and Grep over cat, sed, echo >, find and grep for file work
- Chain dependent commands with &&; make independent calls in parallel in one response`,
  {
    command: z.string().describe("The command to execute"),
    timeout: z.number().optional().describe("Optional timeout in milliseconds (max 600000)"),
    description: z.string().optional().describe("Clear, concise description of what this command does in 5-10 words"),
    run_in_background: z.boolean().optional().describe("Set to true to run this command in the background. Read the output file it returns to check on it."),
  },
  async ({ command, timeout, run_in_background }, extra) => {
    if (run_in_background) return background(command);
    const limit = Math.min(Math.max(timeout ?? 120_000, 1_000), 600_000);
    const { out, code, timedOut } = await run(command, limit, (extra as { signal?: AbortSignal })?.signal);

    const newCwd = (await Bun.file(PWD_FILE).text().catch(() => "")).trim();
    if (newCwd) cwd = newCwd;

    let text = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n\n... [output truncated]` : out.trimEnd();
    if (timedOut) text += `${text ? "\n" : ""}Command timed out after ${limit}ms`;
    else if (code !== 0) text += `${text ? "\n" : ""}Exit code ${code}`;
    if (timedOut || code !== 0) return err(text);
    return ok(text || "(No output)");
  },
);
