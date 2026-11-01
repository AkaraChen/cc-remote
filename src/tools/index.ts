import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { WINDOWS } from "../platform";
import { bash } from "./bash";
import { edit } from "./edit";
import { glob } from "./glob";
import { grep } from "./grep";
import { notebookEdit } from "./notebook";
import { powershell } from "./powershell";
import { read } from "./read";
import { write } from "./write";
import { workspace } from "./util";

export { killAll } from "./shell";

const shell = WINDOWS ? powershell : bash;

/**
 * One per session, since each session has its own directory. It runs in this process; claude
 * reaches it through the SDK's control channel over ssh. The timeout covers the shell's 10-minute
 * maximum plus margin.
 */
export function localTools(root: string) {
  const ws = workspace(root);
  return createSdkMcpServer({
    name: "cc",
    version: "1.0.0",
    alwaysLoad: true,
    timeout: 660_000,
    tools: [read, write, edit, shell, glob, grep, notebookEdit].map((t) => t(ws)),
  });
}
