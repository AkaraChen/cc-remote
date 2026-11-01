import type { CanUseTool, HookCallbackMatcher, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { createReadStream, createWriteStream, openSync, closeSync } from "node:fs";
import { relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { LOCAL, PREFIX, unprefix } from "./names";
import { root } from "./tools/util";

/** One permission rule as written on the command line: `Bash` or `Bash(git diff *)`. */
export type Rule = { tool: string; content?: string };

/** Splits "Read,Edit Bash(git diff *)" into rules. Commas and spaces inside parentheses don't split. */
export function parseRules(values: string[] = []): Rule[] {
  const rules: Rule[] = [];
  for (const value of values) {
    let depth = 0, token = "";
    for (const ch of `${value},`) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (depth === 0 && (ch === "," || /\s/.test(ch))) {
        const m = token.match(/^([^(]+)(?:\((.*)\))?$/);
        if (m) rules.push({ tool: m[1]!, content: m[2] });
        token = "";
      } else token += ch;
    }
  }
  return rules;
}

export const format = (r: Rule, prefix = "") => `${prefix}${r.tool}${r.content === undefined ? "" : `(${r.content})`}`;
export const isLocal = (r: Rule) => LOCAL.includes(r.tool);

/** Claude Code's rule syntax: `Bash(git diff *)` is a prefix match; file tools take globs. */
export function matches(rule: Rule, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  if (rule.content === undefined) return true;
  if (tool === "Bash") {
    const source = rule.content.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/ \*$/, "( .*)?").replace(/\*/g, ".*");
    return new RegExp(`^${source}$`, "s").test(String(input.command ?? ""));
  }
  const path = String(input.file_path ?? input.path ?? "");
  const glob = new Bun.Glob(rule.content.replace(/^\.\//, ""));
  return glob.match(path) || glob.match(relative(root, path));
}

/** Asks on the terminal even when stdout is piped. Returns null when there is no terminal. */
let queue = Promise.resolve<unknown>(null);
function ask(question: string): Promise<"y" | "n" | "a" | null> {
  const next = queue.then(async () => {
    try { closeSync(openSync("/dev/tty", "r+")); } catch { return null; }
    const input = createReadStream("/dev/tty");
    const output = createWriteStream("/dev/tty");
    const rl = createInterface({ input, output });
    try {
      const answer = (await rl.question(`\x1b[1mcc-remote\x1b[0m: allow ${question}? [y]es / [n]o / [a]lways: `)).trim().toLowerCase();
      return answer.startsWith("a") ? "a" : answer.startsWith("y") ? "y" : "n";
    } finally {
      rl.close();
      input.destroy();
      output.end();
    }
  });
  queue = next;
  return next;
}

function describe(tool: string, input: Record<string, unknown>) {
  if (tool === "Bash") return `Bash: ${input.command}`;
  if (input.file_path) return `${tool}: ${input.file_path}`;
  const json = JSON.stringify(input);
  return `${tool} ${json.length > 300 ? `${json.slice(0, 300)}…` : json}`;
}

/**
 * claude calls this when its own permission flow would prompt. The tools run here, so the prompt does too.
 * Reads never prompt; local allow rules, "always" answers and acceptEdits approve; anything else asks.
 */
export function canUseTool(allow: Rule[], mode: string | undefined): CanUseTool {
  const always = new Set<string>();
  return async (name, input): Promise<PermissionResult> => {
    const tool = unprefix(name);
    const approve = { behavior: "allow" as const, updatedInput: input };
    if (["Read", "Glob", "Grep"].includes(tool) && name.startsWith(PREFIX)) return approve;
    if (always.has(tool) || allow.some((r) => matches(r, tool, input))) return approve;
    if (mode === "acceptEdits" && (tool === "Write" || tool === "Edit")) return approve;

    const answer = await ask(describe(tool, input));
    if (answer === "a") always.add(tool);
    if (answer === "a" || answer === "y") return approve;
    return {
      behavior: "deny",
      message: answer === null
        ? `Permission to use ${tool} was denied: there is no terminal to ask the user, and no --allowedTools rule or --permission-mode approves it.`
        : `The user denied permission to use ${tool}.`,
    };
  };
}

/** Scoped deny rules (`Bash(rm *)`) must hold in every mode, so they're a PreToolUse hook rather than part of canUseTool. */
export function denyHook(deny: Rule[]): Partial<Record<"PreToolUse", HookCallbackMatcher[]>> {
  if (!deny.length) return {};
  return {
    PreToolUse: [{
      matcher: `${PREFIX}.*`,
      hooks: [async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const tool = unprefix(input.tool_name);
        const rule = deny.find((r) => matches(r, tool, input.tool_input as Record<string, unknown>));
        if (!rule) return {};
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Denied by --disallowedTools ${format(rule)}` } };
      }],
    }],
  };
}
