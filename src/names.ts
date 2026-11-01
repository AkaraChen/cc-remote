/** Tools we run locally, under the names Claude Code uses for its own versions. */
export const LOCAL = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "NotebookEdit"];

/**
 * Built-in tools that would act on the host instead of this machine. LSP needs local language
 * servers, Monitor streams events claude can't receive from an MCP tool, the worktree tools move
 * claude's own working directory, and PowerShell is Windows-only.
 */
export const REMOVED = [...LOCAL, "LSP", "Monitor", "EnterWorktree", "ExitWorktree", "PowerShell"];

/** claude puts every MCP tool behind `mcp__<server>__`. It only exists between claude and the SDK. */
export const PREFIX = "mcp__cc__";

export const unprefix = (name: string) => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);

const PREFIXED = new RegExp(`"${PREFIX}(${LOCAL.join("|")})"`, "g");

/** Rewrites a serialized message so tool names read exactly as `claude -p` prints them. */
export const strip = (json: string) => json.replace(PREFIXED, '"$1"');
