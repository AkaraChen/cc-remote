import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const s = new McpServer({ name: "secret", version: "1.0.0" });
s.registerTool("get_secret", { description: "Returns the secret word, only available on the user's machine" }, async () => ({ content: [{ type: "text", text: `the secret is PINEAPPLE-${process.pid}` }] }));
await s.connect(new StdioServerTransport());
