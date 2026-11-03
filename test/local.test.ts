import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bridgeAll } from "../src/bridge";
import { localMcpServers } from "../src/mcp";
import { machine } from "../src/oauth";

const dir = mkdtempSync(join(tmpdir(), "cc-remote-local-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const put = (path: string, content: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};

describe("localMcpServers", () => {
  const home = join(dir, "mcp-home");
  const cwd = join(home, "repo", "app");

  test("merges the user's, the approved project's and the directory's own servers", async () => {
    process.env.CC_TEST_TOKEN = "t0k";
    put(join(home, ".claude.json"), {
      mcpServers: { user: { command: "u" }, both: { command: "from-user" }, ws: { type: "ws", url: "ws://x" } },
      projects: { [cwd]: { mcpServers: { mine: { type: "http", url: "https://mine" } }, enabledMcpjsonServers: ["shared"], disabledMcpServers: ["off"] } },
    });
    put(join(home, "repo", ".mcp.json"), { mcpServers: { shared: { command: "outer" }, unapproved: { command: "evil" } } });
    put(join(cwd, ".mcp.json"), { mcpServers: { shared: { command: "inner", env: { T: "${CC_TEST_TOKEN}", D: "${CC_TEST_NONE:-dflt}" } }, off: { command: "o" } } });
    put(join(cwd, ".claude", "settings.json"), { enableAllProjectMcpServers: true });
    put(join(home, ".claude", "settings.json"), { enabledMcpjsonServers: ["off"] });

    const servers = await localMcpServers(cwd, home, undefined);
    expect(servers).toEqual({
      user: { command: "u", type: "stdio" },
      both: { command: "from-user", type: "stdio" },
      shared: { command: "inner", env: { T: "t0k", D: "dflt" }, type: "stdio" },
      mine: { type: "http", url: "https://mine" },
    } as never);
  });

  test("is empty without a local Claude Code", async () => {
    expect(await localMcpServers(join(dir, "nowhere"), join(dir, "nobody"), undefined)).toEqual({});
  });
});

/** A remote MCP server behind OAuth, with an authorization server that approves at once. */
function oauthServer() {
  const tokens = new Set<string>();
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const base = `http://localhost:${server.port}`;
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
          response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register") return Response.json({ ...(await req.json()), client_id: "c1" }, { status: 201 });
      if (url.pathname === "/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", "code1");
        back.searchParams.set("state", url.searchParams.get("state")!);
        return Response.redirect(back.href, 302);
      }
      if (url.pathname === "/token") {
        const token = crypto.randomUUID();
        tokens.add(token);
        return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
      }
      if (!tokens.has(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) {
        return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
      }
      const mcp = new McpServer({ name: "remote", version: "1" });
      mcp.registerTool("hello", { description: "says hi" }, async () => ({ content: [{ type: "text", text: "hi" }] }));
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
  });
  return server;
}

describe("bridged OAuth", () => {
  test("offers authenticate, logs in through the browser, then the real tools", async () => {
    const remote = oauthServer();
    const opened: string[] = [];
    const { open, authDir } = machine;
    machine.authDir = join(dir, "mcp-auth");
    machine.open = (url) => {
      opened.push(url);
      void fetch(url); // The "browser" follows the redirect to the callback.
    };
    try {
      const name = `oauth-${remote.port}`;
      const { instance } = bridgeAll({ [name]: { type: "http", url: `http://localhost:${remote.port}/mcp` } }, dir)[name] as { instance: McpServer };
      const [a, b] = InMemoryTransport.createLinkedPair();
      const changed = Promise.withResolvers<void>();
      const client = new Client({ name: "claude", version: "1" });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => changed.resolve());
      await instance.connect(a);
      await client.connect(b);

      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["authenticate"]);
      const started = await client.callTool({ name: "authenticate", arguments: {} });
      expect(JSON.stringify(started.content)).toContain("/authorize");
      expect(opened).toHaveLength(1);

      await changed.promise;
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["hello"]);
      expect((await client.callTool({ name: "hello", arguments: {} })).content).toEqual([{ type: "text", text: "hi" }]);
      await client.close();
    } finally {
      Object.assign(machine, { open, authDir });
      remote.stop(true);
    }
  }, 15_000);
});
