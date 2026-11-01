import { isAbsolute, resolve } from "node:path";

/** The directory cc-remote was started in. Relative paths resolve against it. */
export const root = process.cwd();
export const home = Bun.env.HOME ?? "/";

export const abs = (p: string) =>
  p === "~" || p.startsWith("~/") ? resolve(home, p.slice(2)) : isAbsolute(p) ? p : resolve(root, p);

export const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const err = (text: string) => ({ ...ok(text), isError: true });
