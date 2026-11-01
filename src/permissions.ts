import type { CanUseTool, HookCallbackMatcher, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { relative } from "node:path";
import { LOCAL, PREFIX, unprefix } from "./names";
import { root } from "./tools/util";
import { ask, bold } from "./tty";

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

const target = (input: Record<string, unknown>) => String(input.file_path ?? input.notebook_path ?? input.path ?? "");

/** Claude Code's rule syntax: `Bash(git diff *)` is a prefix match; file tools take globs. */
export function matches(rule: Rule, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  if (rule.content === undefined) return true;
  if (tool === "Bash") {
    const source = rule.content.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/ \*$/, "( .*)?").replace(/\*/g, ".*");
    return new RegExp(`^${source}$`, "s").test(String(input.command ?? ""));
  }
  const glob = new Bun.Glob(rule.content.replace(/^\.\//, ""));
  return glob.match(target(input)) || glob.match(relative(root, target(input)));
}

function describe(tool: string, input: Record<string, unknown>) {
  if (tool === "Bash") return `Bash: ${input.command}`;
  if (target(input)) return `${tool}: ${target(input)}`;
  const json = JSON.stringify(input);
  return `${tool} ${json.length > 300 ? `${json.slice(0, 300)}…` : json}`;
}

const NO_TERMINAL = "there is no terminal to ask the user";

type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };

/** AskUserQuestion: show each question on the terminal and hand the answers back to claude. */
async function answer(input: Record<string, unknown>): Promise<PermissionResult> {
  const answers: Record<string, string> = {};
  for (const q of input.questions as Question[]) {
    const menu = q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ""}`).join("\n");
    const hint = q.multiSelect ? "Numbers separated by commas, or type an answer" : "A number, or type an answer";
    const reply = await ask(`\n${bold(`${q.header}: ${q.question}`)}\n${menu}\n${hint}: `);
    if (reply === null) return { behavior: "deny", message: `Could not ask the user: ${NO_TERMINAL}.` };
    const picked = reply.split(",").map((s) => q.options[Number(s.trim()) - 1]?.label);
    answers[q.question] = reply && picked.every(Boolean) ? picked.join(", ") : reply;
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

/**
 * claude calls this when its own permission flow would prompt. The tools run here, so the prompt does too.
 * Reads never prompt; allow rules, "always" answers and acceptEdits approve; anything else asks.
 */
export function canUseTool(allow: Rule[], mode: string | undefined): CanUseTool {
  const always = new Set<string>();
  return async (name, input): Promise<PermissionResult> => {
    if (name === "AskUserQuestion") return answer(input);
    const tool = unprefix(name);
    const approve = { behavior: "allow" as const, updatedInput: input };
    if (["Read", "Glob", "Grep"].includes(tool) && name.startsWith(PREFIX)) return approve;
    if (always.has(tool) || allow.some((r) => matches(r, tool, input))) return approve;
    if (mode === "acceptEdits" && ["Write", "Edit", "NotebookEdit"].includes(tool)) return approve;

    const reply = await ask(`${bold("cc-remote")}: allow ${describe(tool, input)}? [y]es / [n]o / [a]lways: `);
    const choice = reply?.toLowerCase()[0];
    if (choice === "a") always.add(tool);
    if (choice === "a" || choice === "y") return approve;
    return {
      behavior: "deny",
      message: reply === null
        ? `Permission to use ${tool} was denied: ${NO_TERMINAL}, and no --allowedTools rule or --permission-mode approves it.`
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
