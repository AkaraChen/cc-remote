import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type Remote = Exclude<McpServerConfig, { type: "sdk" }>;

function transport(config: Remote, cwd: string) {
  if (config.type === "http") return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  if (config.type === "sse") return new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...(process.env as Record<string, string>), ...config.env },
    cwd,
    stderr: "inherit",
  });
}

/**
 * An MCP server the ACP client configured lives on this machine (paseo's is on 127.0.0.1, a stdio
 * server is a local command), where the remote claude can't reach it. This connects to it here and
 * offers its tools to claude as an in-process server, through the SDK channel like our own tools.
 * The connection opens on claude's first request and closes with the session.
 */
function bridge(name: string, config: Remote, cwd: string, signal?: AbortSignal) {
  let client: Promise<Client> | undefined;
  const connect = () => {
    client ??= (async () => {
      const c = new Client({ name: "cc-remote", version: "1.0.0" });
      await c.connect(transport(config, cwd));
      signal?.addEventListener("abort", () => void c.close());
      return c;
    })().catch((e) => {
      client = undefined;
      throw new Error(`cc-remote could not reach the local MCP server ${name}: ${(e as Error).message}`);
    });
    return client;
  };

  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async (req) => (await connect()).listTools(req.params));
  server.server.setRequestHandler(CallToolRequestSchema, async (req) => (await connect()).callTool(req.params));
  return { type: "sdk" as const, name, instance: server };
}

/** Every server in the session's config runs locally, so every one is bridged. */
export function bridgeAll(servers: Record<string, McpServerConfig> = {}, cwd: string, signal?: AbortSignal) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, config.type === "sdk" ? config : bridge(name, config as Remote, cwd, signal)]),
  );
}
