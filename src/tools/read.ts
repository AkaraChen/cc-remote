import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { renderNotebook } from "./notebook";
import { abs, err, ok } from "./util";

const IMAGES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

export const read = tool(
  "Read",
  `Reads a file from the user's local filesystem.

- file_path should be an absolute path; relative paths resolve against the working directory
- By default reads up to 2000 lines from the start of the file; use offset and limit for long files
- Lines longer than 2000 characters are truncated
- Output uses cat -n format: line numbers starting at 1, then a tab, then the line
- Reads images (PNG, JPG, GIF, WEBP) and returns them visually
- Reads Jupyter notebooks (.ipynb) as cells with their ids and outputs
- Can only read files, not directories; use Bash with ls for directories
- Batch several reads in one response when you need several files`,
  {
    file_path: z.string().describe("The absolute path to the file to read"),
    offset: z.number().int().optional().describe("The line number to start reading from. Only provide if the file is too large to read at once"),
    limit: z.number().int().optional().describe("The number of lines to read. Only provide if the file is too large to read at once."),
  },
  async ({ file_path, offset, limit }) => {
    const path = abs(file_path);
    const file = Bun.file(path);
    const info = await file.stat().catch(() => null);
    if (!info) return err(`File does not exist: ${path}`);
    if (info.isDirectory()) return err(`EISDIR: illegal operation on a directory, read '${path}'`);

    const ext = path.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? "";
    if (IMAGES[ext]) {
      return { content: [{ type: "image" as const, data: Buffer.from(await file.arrayBuffer()).toString("base64"), mimeType: IMAGES[ext] }] };
    }
    if (ext === "ipynb") {
      try {
        return { content: renderNotebook(await file.text()) };
      } catch {
        // Not valid notebook JSON; show it as text below.
      }
    }

    const lines = (await file.text()).split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length === 0) return ok("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");

    const start = Math.max(1, offset ?? 1);
    if (start > lines.length) {
      return ok(`<system-reminder>Warning: the file exists but is shorter than the provided offset (${start}). The file has ${lines.length} lines.</system-reminder>`);
    }
    const body = lines
      .slice(start - 1, start - 1 + (limit ?? 2000))
      .map((line, i) => `${String(start + i).padStart(6)}\t${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`)
      .join("\n");
    return ok(body);
  },
  { annotations: { readOnlyHint: true } },
);
