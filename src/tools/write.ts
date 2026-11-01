import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { abs, ok, type Workspace } from "./util";

export const write = (ws: Workspace) => tool(
  "Write",
  `Writes a file to the user's local filesystem, creating parent directories as needed.

- Overwrites the existing file if there is one at the provided path
- For an existing file, prefer Edit, which only sends the change
- Never create documentation files (*.md) or READMEs unless the user asks for them`,
  {
    file_path: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
    content: z.string().describe("The content to write to the file"),
  },
  async ({ file_path, content }) => {
    const path = abs(ws, file_path);
    const existed = await Bun.file(path).exists();
    await Bun.write(path, content);
    return ok(existed ? `The file ${path} has been updated successfully.` : `File created successfully at: ${path}`);
  },
);
