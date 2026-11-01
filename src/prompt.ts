import { $ } from "bun";
import { homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";

/** CLAUDE.md files claude would load for this directory: the user's, then every ancestor's, nearest last. */
async function memory(cwd: string): Promise<string> {
  const dirs: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    dirs.unshift(d);
    if (d === dirname(d)) break;
  }
  const candidates = [
    join(homedir(), ".claude", "CLAUDE.md"),
    ...dirs.flatMap((d) => [join(d, "CLAUDE.md"), join(d, ".claude", "CLAUDE.md"), join(d, "CLAUDE.local.md")]),
  ];
  const found: string[] = [];
  for (const path of new Set(candidates)) {
    const file = Bun.file(path);
    if (await file.exists()) found.push(`Contents of ${path}:\n\n${(await file.text()).trim()}`);
  }
  if (!found.length) return "";
  return `\n\n# claudeMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n${found.join("\n\n")}`;
}

async function git(cwd: string): Promise<string> {
  const run = (cmd: ReturnType<typeof $>) => cmd.cwd(cwd).quiet().nothrow().text().then((s) => s.trim());
  const branch = await run($`git rev-parse --abbrev-ref HEAD`);
  if (!branch) return "";
  const status = (await run($`git status --short`)).split("\n").slice(0, 40).join("\n");
  const log = await run($`git log --oneline -5`);
  return `\n\n# gitStatus\nThis is the git status of the working directory at the start of the conversation.\nCurrent branch: ${branch}\n\nStatus:\n${status || "(clean)"}\n\nRecent commits:\n${log}`;
}

/**
 * Appended to Claude Code's own system prompt. With excludeDynamicSections, claude moves its
 * machine-specific sections (its cwd, git status, memory paths) out of the system prompt; this
 * supplies the local ones in their place.
 */
export async function environment(cwd: string): Promise<string> {
  const [gitStatus, claudeMd] = await Promise.all([git(cwd), memory(cwd)]);
  return `# Environment (cc-remote)
This session runs through cc-remote. Your Read, Write, Edit, Bash, Glob and Grep tools execute on the user's machine, not on the machine hosting this session. Any other working directory you are told about belongs to the host; ignore it and use this one.
 - Working directory: ${cwd}
 - Is a git repository: ${gitStatus ? "yes" : "no"}
 - Platform: ${platform()}
 - OS version: ${release()}
 - Shell: bash${gitStatus}${claudeMd}`;
}
