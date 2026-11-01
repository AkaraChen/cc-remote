import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { bash } from "./bash";
import { edit } from "./edit";
import { glob } from "./glob";
import { grep } from "./grep";
import { notebookEdit } from "./notebook";
import { read } from "./read";
import { write } from "./write";
import { workspace } from "./util";

export { killAll } from "./bash";

/**
 * One per session, since each session has its own directory. It runs in this process; claude
 * reaches it through the SDK's control channel over ssh. The timeout covers Bash's 10-minute
 * maximum plus margin.
 */
export function localTools(root: string) {
  const ws = workspace(root);
  return createSdkMcpServer({
    name: "cc",
    version: "1.0.0",
    alwaysLoad: true,
    timeout: 660_000,
    tools: [read, write, edit, bash, glob, grep, notebookEdit].map((t) => t(ws)),
  });
}
