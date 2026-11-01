/** True on Windows, the one platform where the shell, the ssh transport and the shim differ. */
export const WINDOWS = process.platform === "win32";

/** The local shell tool: PowerShell on Windows, as Claude Code itself does there, else Bash. */
export const SHELL = WINDOWS ? "PowerShell" : "Bash";
