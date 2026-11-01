#!/usr/bin/env bun
import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES, query, type Options, type PermissionMode, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { parse, USAGE, type Args } from "./args";
import { PREFIX, REMOVED, LOCAL, strip } from "./names";
import { canUseTool, denyHook, format, isLocal, parseRules } from "./permissions";
import { environment } from "./prompt";
import { REMOTE_PATH, rsh, spawner } from "./ssh";
import { killAll, server } from "./tools";

/** verbatimPrompts, which keeps a prompt starting with "/" from being read as a command, needs this. */
const MIN_CLAUDE = "2.1.248";

const fail = (message: string): never => {
  console.error(`cc-remote: ${message}`);
  process.exit(1);
};

const older = (a: string, b: string) => {
  const [x, y] = [a, b].map((s) => s.split(/[.-]/).map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! < y![i]!;
  return false;
};

async function host(flag?: string): Promise<string> {
  const file = Bun.file(join(homedir(), ".config", "cc-remote", "host"));
  const found = flag ?? process.env.CC_REMOTE_HOST ?? ((await file.exists()) ? (await file.text()).trim() : "");
  return found || fail("no host. Pass --host, set CC_REMOTE_HOST, or write the host to ~/.config/cc-remote/host");
}

async function doctor(target: string) {
  console.log(`cc-remote ${pkg.version} (agent sdk ${pkg.dependencies["@anthropic-ai/claude-agent-sdk"]})`);
  console.log(`host: ${target} via ${rsh().join(" ")}`);
  const proc = Bun.spawn([...rsh(), "-T", target, `${REMOTE_PATH} claude --version`], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) fail(`could not run claude on ${target}`);
  const version = out.split(" ")[0]!;
  console.log(`remote claude: ${out}`);
  if (older(version, MIN_CLAUDE)) fail(`remote claude is older than ${MIN_CLAUDE}. Run \`claude update\` on ${target}.`);
  console.log("ok");
}

/** Text input: the prompt argument, plus whatever was piped in, like `cat log | claude -p "explain"`. */
async function textPrompt(args: Args): Promise<string> {
  const piped = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
  const prompt = [args.prompt, piped].filter(Boolean).join("\n\n");
  return prompt || fail("no prompt. Pass one as an argument or pipe it in. See cc-remote --help");
}

/** stream-json input: one SDK user message per line of stdin. */
async function* streamPrompt(): AsyncIterable<SDKUserMessage> {
  for await (const line of console) if (line.trim()) yield JSON.parse(line);
}

async function options(args: Args, target: string, cwd: string): Promise<Options> {
  const allow = parseRules(args.allowedTools);
  const deny = parseRules(args.disallowedTools);
  const env = await environment(cwd);
  const append = [env, args.appendSystemPrompt].filter(Boolean).join("\n\n");

  return {
    pathToClaudeCodeExecutable: "claude",
    spawnClaudeCodeProcess: spawner(target, cwd, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }),
    mcpServers: { cc: server },
    toolAliases: Object.fromEntries(LOCAL.map((t) => [t, PREFIX + t])),
    // Allow rules are checked here in canUseTool, except scoped rules for tools claude runs itself
    // (WebFetch(domain:…)), which only claude can match. Bare names passed to claude would bypass
    // canUseTool entirely, and the SDK warns about that.
    allowedTools: allow.filter((r) => !isLocal(r) && r.content !== undefined).map((r) => format(r)),
    disallowedTools: [
      ...REMOVED,
      ...deny.filter((r) => !isLocal(r) || r.content === undefined).map((r) => format(r, isLocal(r) ? PREFIX : "")),
    ],
    // bypassPermissions never consults canUseTool, and the SDK warns if one is passed.
    canUseTool: args.permissionMode === "bypassPermissions" ? undefined : canUseTool(allow.filter((r) => isLocal(r) || r.content === undefined), args.permissionMode),
    hooks: denyHook(deny.filter((r) => isLocal(r) && r.content !== undefined)),
    permissionMode: args.permissionMode as PermissionMode | undefined,
    allowDangerouslySkipPermissions: args.permissionMode === "bypassPermissions",
    systemPrompt: args.systemPrompt
      ? { type: "custom", prompt: `${args.systemPrompt}\n\n${append}` }
      : { type: "preset", preset: "claude_code", excludeDynamicSections: true, append },
    verbatimPrompts: true,
    includePartialMessages: args.partial,
    model: args.model,
    fallbackModel: args.fallbackModel,
    effort: args.effort,
    maxTurns: args.maxTurns,
    maxBudgetUsd: args.maxBudgetUsd,
    outputFormat: args.jsonSchema ? { type: "json_schema", schema: JSON.parse(args.jsonSchema) } : undefined,
    continue: args.continue,
    resume: args.resume,
    sessionId: args.sessionId,
  };
}

/** Checks the remote claude once it reports in. */
function checkInit(m: Extract<SDKMessage, { type: "system"; subtype: "init" }>, target: string, verbose: boolean) {
  if (older(m.claude_code_version, MIN_CLAUDE)) fail(`claude ${m.claude_code_version} on ${target} is older than ${MIN_CLAUDE}. Run \`claude update\` there.`);
  if (m.mcp_servers.find((s) => s.name === "cc")?.status !== "connected") fail("the local tools did not connect to the remote claude");
  const known = new Set<string>([...BUILTIN_TOOL_NAMES, ...Object.keys(LEGACY_TOOL_NAME_ALIASES)]);
  const unknown = m.tools.filter((t) => !t.startsWith("mcp__") && !known.has(t));
  if (verbose && unknown.length) console.error(`cc-remote: warning: claude on ${target} has tools this cc-remote doesn't know, and they run there: ${unknown.join(", ")}`);
}

async function main() {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    return fail(`${(e as Error).message}\nSee cc-remote --help`);
  }
  if (args.help) return console.log(USAGE);
  if (args.version) return console.log(`${pkg.version} (cc-remote)`);
  const target = await host(args.host);
  if (args.doctor) return doctor(target);

  const cwd = process.cwd();
  const prompt = args.inputFormat === "stream-json" ? streamPrompt() : await textPrompt(args);
  let code = 1;
  let result = false;
  try {
    for await (const m of query({ prompt, options: await options(args, target, cwd) })) {
      if (m.type === "system" && m.subtype === "init") {
        checkInit(m, target, args.verbose);
        m.cwd = cwd; // claude reports the host-side folder; the tools run here.
      }
      if ("sdk_host_only" in m && m.sdk_host_only) continue;
      if (args.outputFormat === "stream-json") console.log(strip(JSON.stringify(m)));
      if (m.type !== "result") continue;
      result = true;
      code = m.is_error ? 1 : 0;
      if (args.outputFormat === "json") console.log(strip(JSON.stringify(m)));
      if (args.outputFormat === "text") console.log(m.subtype === "success" ? m.result : m.errors.join("\n") || m.subtype);
    }
  } catch (e) {
    // The SDK throws after an error result too; only report failures that produced no result.
    if (!result) console.error(`cc-remote: ${(e as Error).message}`);
  }
  process.exit(code);
}

process.on("exit", killAll);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
await main();
