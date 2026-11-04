import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * A remote MCP server behind OAuth, built from the SDK's own server side: its authorization
 * server router with the demo provider, which approves at once, and its bearer-token check.
 */
async function oauthServer() {
  const app = express();
  const http = createServer(app);
  await new Promise<void>((done) => http.listen(0, "localhost", done));
  const port = (http.address() as AddressInfo).port;
  const base = new URL(`http://localhost:${port}`);
  const mcpUrl = new URL("/mcp", base);
  const provider = new DemoInMemoryAuthProvider();
  app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl }));
  app.post("/mcp", express.json(), requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }), async (req, res) => {
    const mcp = new McpServer({ name: "remote", version: "1" });
    mcp.registerTool("hello", { description: "says hi" }, async () => ({ content: [{ type: "text", text: "hi" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return { port, stop: () => http.close() };
}

describe("bridged OAuth", () => {
  test("offers authenticate, logs in through the browser, then the real tools", async () => {
    const remote = await oauthServer();
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
      remote.stop();
    }
  }, 15_000);
});
