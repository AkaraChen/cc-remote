import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const home = homedir();

/** One session's directories: relative paths resolve against root; Bash's cwd follows its `cd`s. */
export type Workspace = { root: string; cwd: string };

export const workspace = (root: string): Workspace => ({ root, cwd: root });

export const abs = (ws: Workspace, p: string) =>
  p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? resolve(home, p.slice(2)) : isAbsolute(p) ? p : resolve(ws.root, p);

export const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const err = (text: string) => ({ ...ok(text), isError: true });
