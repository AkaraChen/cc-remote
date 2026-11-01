/** Tools we run locally, under the names Claude Code uses for its own versions. */
export const LOCAL = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

/** Built-in tools that touch the filesystem or shell where claude runs, plus ones v1 doesn't relay. */
export const REMOVED = [...LOCAL, "NotebookEdit", "LSP", "Monitor", "EnterWorktree", "ExitWorktree", "PowerShell", "AskUserQuestion"];

/** claude puts every MCP tool behind `mcp__<server>__`. It only exists between claude and the SDK. */
export const PREFIX = "mcp__cc__";

export const unprefix = (name: string) => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);

const PREFIXED = new RegExp(`"${PREFIX}(${LOCAL.join("|")})"`, "g");

/** Rewrites a serialized message so tool names read exactly as `claude -p` prints them. */
export const strip = (json: string) => json.replace(PREFIXED, '"$1"');
