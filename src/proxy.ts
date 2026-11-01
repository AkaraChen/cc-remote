import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcess } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";
import { EDITS, LOCAL, PREFIX, strip } from "./names";
import { SHELL } from "./platform";
import { projectKey, projectsDir } from "./sessions";

/** What one claude process needs to have its messages read as if it ran in `cwd` on this machine. */
export type Session = {
  /** The local working directory. */
  cwd: string;
  /** The folder claude runs in on the host, relative to the host's home. */
  hostDir: string;
  /** claude's permission mode, followed through the SDK's requests. */
  mode: string;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const jsonText = (s: string) => JSON.stringify(s).slice(1, -1);

const inside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Shell command prefixes the user said not to ask about again, per directory, for as long as
 * cc-remote runs. claude can't keep these for us: it matches command rules only on its own shell tools.
 */
const bashRules = new Map<string, Set<string>>();

/** Chaining, pipes, substitution and redirection can hide a second command behind an approved one. */
const COMPOUND = /[;&|`<>\n]|\$\(/;

/** The prefix claude would suggest approving: the command, plus its subcommand when it has one. */
export function commandPrefix(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  if (COMPOUND.test(command) || !/^[\w.@/-]+$/.test(words[0] ?? "")) return undefined;
  return words[1] && /^[a-z][\w-]*$/.test(words[1]) ? `${words[0]} ${words[1]}` : words[0];
}

const approved = (cwd: string, command: string) => {
  if (COMPOUND.test(command)) return false;
  const c = command.trim();
  return [...(bashRules.get(cwd) ?? [])].some((p) => c === p || c.startsWith(`${p} `));
};

/**
 * Rewrites the stream between the SDK and the remote claude, both ways:
 *
 * - claude → SDK: the local tools lose their `mcp__cc__` prefix, so ACP renders them as the
 *   built-ins; the host folder becomes the local cwd; transcript mirror frames point into the
 *   local projects folder, where the SDK expects them.
 * - SDK → claude: permission rules the user approves for a local tool get the prefix back.
 *
 * It also answers claude's permission requests that claude would answer itself for its built-ins:
 * local edits under acceptEdits, and shell commands the user said not to ask about again.
 */
export function rewriter(s: Session) {
  const hostPath = new RegExp(`(?:/[^"\\\\/\\s]+)*/${escape(jsonText(s.hostDir))}(?=["/\\\\\\s]|$)`, "g");
  const local = jsonText(s.cwd);
  const transcripts = join(projectsDir(), projectKey(s.cwd));

  /** Returns the line for the SDK, or null when it was answered here; `reply` writes to claude. */
  function outbound(line: string, reply: (line: string) => void): string | null {
    let text = strip(line);
    if (text.includes("/.cc-remote/ws/")) text = text.replace(hostPath, local);
    if (text.includes('"transcript_mirror"')) {
      const m = JSON.parse(text);
      if (m.type === "transcript_mirror" && typeof m.filePath === "string") {
        const rest = m.filePath.match(/\/projects\/[^/]+\/(.+)$/)?.[1];
        if (rest) m.filePath = join(transcripts, rest);
        return JSON.stringify(m);
      }
    }
    if (text.includes('"can_use_tool"')) {
      const m = JSON.parse(text);
      const req = m.request;
      if (m.type !== "control_request" || req?.subtype !== "can_use_tool") return text;
      const allow = () => {
        const response = { behavior: "allow", updatedInput: req.input };
        reply(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } }));
        return null;
      };
      if (EDITS.includes(req.tool_name)) {
        const target = String(req.input?.file_path ?? req.input?.notebook_path ?? "");
        const local = target !== "" && inside(resolve(s.cwd, target), s.cwd);
        if (local && s.mode === "acceptEdits") return allow();
        // As claude offers for its own edits: accept the rest of this session's edits.
        req.permission_suggestions = local ? [{ type: "setMode", mode: "acceptEdits", destination: "session" }] : undefined;
        return JSON.stringify(m);
      }
      if (req.tool_name === SHELL) {
        const command = String(req.input?.command ?? "");
        if (approved(s.cwd, command)) return allow();
        // claude suggests approving the whole tool, as for any MCP tool. Offer the command instead.
        const prefix = commandPrefix(command);
        req.permission_suggestions = prefix
          ? [{ type: "addRules", rules: [{ toolName: SHELL, ruleContent: `${prefix}:*` }], behavior: "allow", destination: "localSettings" }]
          : undefined;
        return JSON.stringify(m);
      }
    }
    return text;
  }

  function inbound(line: string): string {
    if (line.includes('"set_permission_mode"')) {
      const m = JSON.parse(line);
      if (m.request?.subtype === "set_permission_mode") s.mode = m.request.mode;
    }
    if (!line.includes('"updatedPermissions"')) return line;
    const m = JSON.parse(line);
    const updates = m.response?.response?.updatedPermissions;
    if (!Array.isArray(updates)) return line;
    for (const u of updates) {
      if (u.type === "setMode" && u.destination === "session") s.mode = u.mode;
      if (!Array.isArray(u.rules)) continue;
      u.rules = u.rules.filter((r: { toolName: string; ruleContent?: string }) => {
        if (r.toolName === SHELL && r.ruleContent && u.behavior === "allow") {
          if (!bashRules.has(s.cwd)) bashRules.set(s.cwd, new Set());
          bashRules.get(s.cwd)!.add(r.ruleContent.replace(/:\*$/, ""));
          return false;
        }
        if (LOCAL.includes(r.toolName)) r.toolName = PREFIX + r.toolName;
        return true;
      });
    }
    m.response.response.updatedPermissions = updates.filter((u) => !Array.isArray(u.rules) || u.rules.length);
    return JSON.stringify(m);
  }

  return { outbound, inbound };
}

function lines(input: Readable, onLine: (line: string) => void, onEnd: () => void) {
  createInterface({ input, crlfDelay: Infinity }).on("line", onLine).on("close", onEnd);
}

/** Wraps the ssh process so the SDK reads and writes through the rewriter. */
export function proxy(child: ChildProcess, s: Session): SpawnedProcess {
  const { outbound, inbound } = rewriter(s);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const toClaude = (line: string) => { if (child.stdin!.writable) child.stdin!.write(`${line}\n`); };
  // claude going away shows up as the exit event; a write racing it must not crash us.
  child.stdin!.on("error", () => {});
  lines(stdin, (line) => toClaude(inbound(line)), () => child.stdin!.end());
  lines(child.stdout!, (line) => {
    const out = outbound(line, toClaude);
    if (out !== null) stdout.write(`${out}\n`);
  }, () => stdout.end());

  return {
    stdin,
    stdout,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: (signal) => child.kill(signal),
    on: (event: "exit" | "error", listener: (...args: any[]) => void) => { child.on(event, listener); },
    once: (event: "exit" | "error", listener: (...args: any[]) => void) => { child.once(event, listener); },
    off: (event: "exit" | "error", listener: (...args: any[]) => void) => { child.off(event, listener); },
  } as SpawnedProcess;
}
