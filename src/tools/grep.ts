import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { abs, err, ok } from "./util";

const rg = Bun.which("rg");

type Input = {
  pattern: string; path?: string; glob?: string; type?: string; output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean; "-n"?: boolean; "-A"?: number; "-B"?: number; "-C"?: number; multiline?: boolean; head_limit?: number;
};

/** ripgrep when it's installed, plain grep otherwise (no --type or multiline there). */
function command(i: Input, mode: string, path: string): string[] {
  const context = (["-A", "-B", "-C"] as const).flatMap((f) => (i[f] !== undefined && mode === "content" ? [f, String(i[f])] : []));
  const flags = [
    ...(i["-i"] ? ["-i"] : []),
    ...(mode === "files_with_matches" ? ["-l"] : mode === "count" ? ["-c"] : i["-n"] === false ? [] : ["-n"]),
    ...context,
  ];
  if (rg) {
    return [rg, "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--max-columns", "500", ...flags,
      ...(i.multiline ? ["-U", "--multiline-dotall"] : []),
      ...(i.glob ? ["--glob", i.glob] : []),
      ...(i.type ? ["--type", i.type] : []),
      "-e", i.pattern, "--", path];
  }
  return ["grep", "-r", "-E", "-I", "--exclude-dir=.git", "--exclude-dir=node_modules", ...flags,
    ...(i.glob ? [`--include=${i.glob}`] : []),
    "-e", i.pattern, "--", path];
}

export const grep = tool(
  "Grep",
  `Searches file contents on the user's local filesystem with ripgrep (or grep when ripgrep is not installed).

- Supports full regex syntax, e.g. "log.*Error" or "function\\s+\\w+"
- Filter files with glob (e.g. "*.js", "**/*.tsx") or type (e.g. "js", "py")
- output_mode: "files_with_matches" (default) lists files, "content" shows matching lines, "count" shows counts per file
- Use multiline for patterns that span lines
- Prefer this over running grep or rg through Bash`,
  {
    pattern: z.string().describe("The regular expression pattern to search for in file contents"),
    path: z.string().optional().describe("File or directory to search in. Defaults to the current working directory."),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
    type: z.string().optional().describe("File type to search (rg --type), e.g. js, py, rust, go"),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe('Output mode. Defaults to "files_with_matches".'),
    "-i": z.boolean().optional().describe("Case insensitive search"),
    "-n": z.boolean().optional().describe('Show line numbers in output. Requires output_mode: "content". Defaults to true.'),
    "-A": z.number().optional().describe('Number of lines to show after each match. Requires output_mode: "content".'),
    "-B": z.number().optional().describe('Number of lines to show before each match. Requires output_mode: "content".'),
    "-C": z.number().optional().describe('Number of lines to show before and after each match. Requires output_mode: "content".'),
    multiline: z.boolean().optional().describe("Enable multiline mode where . matches newlines and patterns can span lines. Default: false."),
    head_limit: z.number().optional().describe("Limit output to the first N lines/entries."),
  },
  async (input) => {
    const mode = input.output_mode ?? "files_with_matches";
    const proc = Bun.spawn(command(input, mode, abs(input.path ?? ".")), { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code > 1) return err(error.trim() || `search failed with exit code ${code}`);

    let lines = out.split("\n").filter(Boolean);
    if (mode === "count") lines = lines.filter((l) => !l.endsWith(":0"));
    if (!lines.length) return ok(mode === "files_with_matches" ? "No files found" : "No matches found");
    if (input.head_limit) lines = lines.slice(0, input.head_limit);
    return ok(mode === "files_with_matches" ? `Found ${lines.length} file${lines.length === 1 ? "" : "s"}\n${lines.join("\n")}` : lines.join("\n"));
  },
  { annotations: { readOnlyHint: true } },
);
