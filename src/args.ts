import { parseArgs } from "node:util";

export const USAGE = `Usage: cc-remote [options] [prompt]

claude -p, with the model on a remote host and the tools on this machine.
Takes the same options as \`claude -p\`; -p itself is optional.

Remote:
  --host <host>                    ssh host where claude is installed and logged in
                                   (else $CC_REMOTE_HOST, else ~/.config/cc-remote/host)
  CC_REMOTE_SSH="ssh -p 2222"      ssh command to use, like rsync's RSYNC_RSH
                                   (keepalives are added; an earlier -o here wins)
  cc-remote doctor                 check the connection and the remote claude version

claude -p options:
  -p, --print                      accepted for compatibility; always on
  --output-format <format>         text (default), json, or stream-json
  --input-format <format>          text (default) or stream-json
  --include-partial-messages       stream partial message chunks (stream-json)
  --model <model>                  model alias or full name
  --fallback-model <model>         model to use when the default is overloaded
  --effort <level>                 low, medium, high, xhigh, max
  --permission-mode <mode>         default, acceptEdits, auto, plan, dontAsk, bypassPermissions
  --dangerously-skip-permissions   bypass all permission checks
  --allowedTools <tools...>        rules to allow, e.g. "Read,Edit,Bash(git *)"
  --disallowedTools <tools...>     rules to deny, e.g. "WebFetch,Bash(rm *)"
  --add-dir <dirs...>              more local directories to tell Claude about
  --system-prompt <prompt>         replace the default system prompt
  --append-system-prompt <prompt>  append to the default system prompt
  --json-schema <schema>           JSON Schema for structured output
  --max-turns <n>                  maximum agentic turns
  --max-budget-usd <amount>        maximum spend for the run
  -c, --continue                   continue the most recent conversation in this directory
  -r, --resume <id>                resume a conversation by session ID
  --session-id <uuid>              use a specific session ID
  --verbose                        accepted for compatibility
  -v, --version                    print the version
  -h, --help                       print this help`;

const string = { type: "string" } as const;
const strings = { type: "string", multiple: true } as const;
const flag = { type: "boolean" } as const;

export function parse(argv: string[]) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { ...flag, short: "p" },
      "output-format": string,
      "input-format": string,
      "include-partial-messages": flag,
      verbose: flag,
      model: string,
      "fallback-model": string,
      effort: string,
      "permission-mode": string,
      "dangerously-skip-permissions": flag,
      allowedTools: strings,
      "allowed-tools": strings,
      disallowedTools: strings,
      "disallowed-tools": strings,
      "add-dir": strings,
      "system-prompt": string,
      "append-system-prompt": string,
      "json-schema": string,
      "max-turns": string,
      "max-budget-usd": string,
      continue: { ...flag, short: "c" },
      resume: { ...string, short: "r" },
      "session-id": string,
      host: string,
      version: { ...flag, short: "v" },
      help: { ...flag, short: "h" },
    },
  });

  const outputFormat = v["output-format"] ?? "text";
  const inputFormat = v["input-format"] ?? "text";
  if (!["text", "json", "stream-json"].includes(outputFormat)) throw new Error(`--output-format must be text, json, or stream-json`);
  if (!["text", "stream-json"].includes(inputFormat)) throw new Error(`--input-format must be text or stream-json`);
  const number = (name: "max-turns" | "max-budget-usd") => {
    if (v[name] === undefined) return undefined;
    const n = Number(v[name]);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  };

  return {
    doctor: positionals[0] === "doctor" && positionals.length === 1,
    prompt: positionals.join(" "),
    outputFormat,
    inputFormat,
    partial: v["include-partial-messages"] ?? false,
    model: v.model,
    fallbackModel: v["fallback-model"],
    effort: v.effort as "low" | "medium" | "high" | "xhigh" | "max" | undefined,
    permissionMode: v["dangerously-skip-permissions"] ? "bypassPermissions" : v["permission-mode"],
    allowedTools: [...(v.allowedTools ?? []), ...(v["allowed-tools"] ?? [])],
    disallowedTools: [...(v.disallowedTools ?? []), ...(v["disallowed-tools"] ?? [])],
    addDirs: (v["add-dir"] ?? []).flatMap((d) => d.split(",")).filter(Boolean),
    systemPrompt: v["system-prompt"],
    appendSystemPrompt: v["append-system-prompt"],
    jsonSchema: v["json-schema"],
    maxTurns: number("max-turns"),
    maxBudgetUsd: number("max-budget-usd"),
    continue: v.continue,
    resume: v.resume,
    sessionId: v["session-id"],
    verbose: v.verbose ?? false,
    host: v.host,
    version: v.version,
    help: v.help,
  };
}

export type Args = ReturnType<typeof parse>;
