import { tool } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { z } from "zod";
import { abs, ok, type Workspace } from "./util";

const LIMIT = 100;
const SKIP = /(^|[\\/])(\.git|node_modules)[\\/]/;

export const glob = (ws: Workspace) => tool(
  "Glob",
  `Fast file pattern matching on the user's local filesystem.

- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching absolute file paths, most recently modified first, at most ${LIMIT}
- Skips .git and node_modules unless the pattern names them`,
  {
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
  },
  async ({ pattern, path }) => {
    const cwd = abs(ws, path ?? ".");
    const skip = !/\.git|node_modules/.test(pattern);
    const files: string[] = [];
    for await (const file of new Bun.Glob(pattern).scan({ cwd, dot: true, onlyFiles: true })) {
      if (!skip || !SKIP.test(file)) files.push(join(cwd, file));
    }
    if (!files.length) return ok("No files found");

    const dated = files.map((f) => [f, Bun.file(f).lastModified] as const).sort((a, b) => b[1] - a[1]);
    const shown = dated.slice(0, LIMIT).map(([f]) => f).join("\n");
    return ok(files.length > LIMIT ? `${shown}\n(Results are truncated. Consider using a more specific path or pattern.)` : shown);
  },
  { annotations: { readOnlyHint: true } },
);
