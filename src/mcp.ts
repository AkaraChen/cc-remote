import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { dirname, join } from "node:path";
import { home } from "./tools/util";

type Servers = Record<string, McpServerConfig>;
type Json = Record<string, any>;

const readJson = async (path: string): Promise<Json | undefined> => {
  try {
    return await Bun.file(path).json();
  } catch {
    return undefined; // Missing or not JSON, as claude treats it.
  }
};

/** `${VAR}` and `${VAR:-default}`, which Claude Code expands in MCP configs. */
function expand(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, name, fallback) => Bun.env[name] ?? fallback ?? all);
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}

/** The servers the bridge can reach: stdio, http and sse. */
function reachable(servers: Json = {}, keep: (name: string) => boolean = () => true): Servers {
  const out: Servers = {};
  for (const [name, raw] of Object.entries(servers)) {
    const config = expand(raw) as Json;
    const type = config?.type ?? (config?.command ? "stdio" : undefined);
    if (!keep(name)) continue;
    if ((type === "stdio" && config.command) || ((type === "http" || type === "sse") && config.url)) out[name] = { ...config, type } as McpServerConfig;
  }
  return out;
}

/**
 * The MCP servers a local Claude Code would start in this directory, which the host's claude
 * would never see: the user's (`~/.claude.json`), the project's `.mcp.json` files once approved, and
 * the ones added for this directory alone. A later scope overrides an earlier one, as in claude.
 *
 * Approvals of `.mcp.json` servers count only from places the repository doesn't control: the
 * user's settings, `.claude/settings.local.json`, and claude's own record for the directory.
 */
export async function localMcpServers(cwd: string, user = home, configDir = Bun.env.CLAUDE_CONFIG_DIR): Promise<Servers> {
  const global = (await readJson(join(configDir ?? user, ".claude.json"))) ?? {};
  const project: Json = global.projects?.[cwd] ?? global.projects?.[cwd.replaceAll("\\", "/")] ?? {};
  const settings = await Promise.all([join(configDir ?? join(user, ".claude"), "settings.json"), join(cwd, ".claude", "settings.local.json")].map(readJson));
  const approvals = [project, ...settings].filter((s): s is Json => !!s);
  const approved = (name: string) =>
    !approvals.some((s) => s.disabledMcpjsonServers?.includes(name)) &&
    approvals.some((s) => s.enableAllProjectMcpServers === true || s.enabledMcpjsonServers?.includes(name));

  // Every .mcp.json from the root down to this directory; the nearest wins.
  const dirs: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    dirs.unshift(d);
    if (d === dirname(d)) break;
  }
  const shared: Json = {};
  for (const d of dirs) Object.assign(shared, (await readJson(join(d, ".mcp.json")))?.mcpServers);

  const servers = { ...reachable(global.mcpServers), ...reachable(shared, approved), ...reachable(project.mcpServers) };
  for (const name of project.disabledMcpServers ?? []) delete servers[name];
  return servers;
}
