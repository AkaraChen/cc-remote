import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { abs, err, ok } from "./util";

export const edit = tool(
  "Edit",
  `Performs exact string replacements in a file on the user's local filesystem.

- Read the file first so old_string matches it exactly, including indentation. Do not include the line-number prefix from Read output
- The edit fails if old_string is not found, or matches more than once while replace_all is false. Add surrounding context to make it unique, or set replace_all
- Use replace_all to rename a variable or replace every occurrence
- An empty old_string creates a new file with new_string as its content`,
  {
    file_path: z.string().describe("The absolute path to the file to modify"),
    old_string: z.string().describe("The text to replace"),
    new_string: z.string().describe("The text to replace it with (must be different from old_string)"),
    replace_all: z.boolean().optional().describe("Replace all occurrences of old_string (default false)"),
  },
  async ({ file_path, old_string, new_string, replace_all }) => {
    const path = abs(file_path);
    if (old_string === new_string) return err("No changes to make: old_string and new_string are exactly the same.");

    const file = Bun.file(path);
    if (!(await file.exists())) {
      if (old_string !== "") return err(`File does not exist: ${path}`);
      await Bun.write(path, new_string);
      return ok(`File created successfully at: ${path}`);
    }
    if (old_string === "") return err("Cannot create new file - file already exists.");

    const parts = (await file.text()).split(old_string);
    const matches = parts.length - 1;
    if (matches === 0) return err(`String to replace not found in file.\nString: ${old_string}`);
    if (matches > 1 && !replace_all) {
      return err(
        `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
      );
    }
    // split/join instead of String.replace: replacement strings must not interpret `$&` and friends.
    const updated = replace_all ? parts.join(new_string) : parts[0] + new_string + parts.slice(1).join(old_string);
    await Bun.write(path, updated);
    return ok(`The file ${path} has been updated successfully.`);
  },
);
