import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { bash } from "./bash";
import { edit } from "./edit";
import { glob } from "./glob";
import { grep } from "./grep";
import { notebookEdit } from "./notebook";
import { read } from "./read";
import { write } from "./write";

export { killAll } from "./bash";

/**
 * Runs in this process; claude reaches it through the SDK's control channel over ssh.
 * The timeout covers Bash's 10-minute maximum plus margin.
 */
export const server = createSdkMcpServer({
  name: "cc",
  version: "1.0.0",
  alwaysLoad: true,
  timeout: 660_000,
  tools: [read, write, edit, bash, glob, grep, notebookEdit],
});
