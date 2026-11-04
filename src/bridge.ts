import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LocalOAuth, type OAuthOptions } from "./oauth";

type Remote = Exclude<McpServerConfig, { type: "sdk" }>;
type Transport = StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;

/** One LocalOAuth per server URL, so sessions share a login and its callback port. */
const logins = new Map<string, LocalOAuth>();

function oauth(config: Remote): LocalOAuth | undefined {
  if (config.type !== "http" && config.type !== "sse") return undefined;
  if (!logins.has(config.url)) logins.set(config.url, new LocalOAuth(config.url, (config as { oauth?: OAuthOptions }).oauth));
  return logins.get(config.url);
}

function transport(config: Remote, cwd: string, authProvider?: LocalOAuth): Transport {
  if (config.type === "http") return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, authProvider });
  if (config.type === "sse") return new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, authProvider });
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...(process.env as Record<string, string>), ...config.env },
    cwd,
    stderr: "inherit",
  });
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

/**
 * An MCP server the ACP client or the local Claude Code config names lives on this machine
 * (paseo's is on 127.0.0.1, a stdio server is a local command), where the remote claude can't
 * reach it. This connects to it here and offers its tools to claude as an in-process server,
 * through the SDK channel like our own tools. The connection opens on claude's first request and
 * closes with the session.
 *
 * A server that wants OAuth offers one `authenticate` tool until the user logs in, as Claude Code
 * does for its own; the login runs here, and the real tools follow through `list_changed`.
 */
function bridge(name: string, config: Remote, cwd: string, signal?: AbortSignal) {
  const auth = oauth(config);
  let client: Promise<Client> | undefined;
  /** The transport that hit the 401; it finishes the login it started. */
  let unauthorized: StreamableHTTPClientTransport | SSEClientTransport | undefined;
  const connect = () => {
    client ??= (async () => {
      const c = new Client({ name: "cc-remote", version: "1.0.0" });
      const t = transport(config, cwd, auth);
      try {
        await c.connect(t);
      } catch (e) {
        if (e instanceof UnauthorizedError && !(t instanceof StdioClientTransport)) unauthorized = t;
        throw e;
      }
      signal?.addEventListener("abort", () => void c.close());
      return c;
    })().catch((e) => {
      client = undefined;
      if (e instanceof UnauthorizedError) throw e;
      throw new Error(`cc-remote could not reach the local MCP server ${name}: ${(e as Error).message}`);
    });
    return client;
  };

  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  const authenticate = {
    name: "authenticate",
    description: `The ${name} MCP server needs the user's authorization before its tools are available. Call this to start it: it opens the authorization page in the user's browser and returns its URL.`,
    inputSchema: { type: "object" as const, properties: {} },
  };
  const relogin = () => {
    client?.then((c) => c.close()).catch(() => {});
    client = undefined;
    void server.server.sendToolListChanged().catch(() => {});
  };

  server.server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    try {
      return await (await connect()).listTools(req.params);
    } catch (e) {
      if (e instanceof UnauthorizedError) return { tools: [authenticate] };
      throw e;
    }
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === authenticate.name && auth) {
      try {
        await connect();
        return text(`${name} is already authorized.`);
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) throw e;
      }
      const login = auth.authorize((code) => unauthorized!.finishAuth(code));
      if (!login) return text(`${name} did not start an authorization. Try again in a new session.`, true);
      login.done.then(() => connect()).then(() => server.server.sendToolListChanged(), (e) => {
        console.error(`cc-remote: authorizing ${name} failed: ${(e as Error).message}`);
      });
      return text(
        `Opened ${login.url.href} in the user's browser. If it did not open, ask the user to open that URL. ` +
          `Once they approve, the tools of ${name} become available; wait for the user to say they are done before using them.`,
      );
    }
    try {
      return await (await connect()).callTool(req.params);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      // The tokens expired and could not be refreshed: back to the authenticate tool.
      relogin();
      return text(`The authorization for ${name} has expired. Call mcp__${name}__authenticate to authorize again.`, true);
    }
  });
  // The config's call timeout and tool loading still apply to the bridged server.
  const { timeout, alwaysLoad } = config as { timeout?: number; alwaysLoad?: boolean };
  return { type: "sdk" as const, name, instance: server, timeout, alwaysLoad };
}

/** Every server in the session's config runs locally, so every one is bridged. */
export function bridgeAll(servers: Record<string, McpServerConfig> = {}, cwd: string, signal?: AbortSignal) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, config.type === "sdk" ? config : bridge(name, config as Remote, cwd, signal)]),
  );
}
