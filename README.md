# cc-remote

Claude Code as an [ACP](https://agentclientprotocol.com) agent, with the model on a remote host
and the tools on your machine.

Claude Code runs on a server where it is installed and logged in. Every file read, edit and
shell command runs here, in the session's directory, and so do the MCP servers your editor
brings. Web search, subagents, skills and the server's own MCP servers keep running on the
server. Nothing is installed on the server beyond `claude` itself, and cc-remote reaches it
over plain ssh.

Any ACP client can use it: Zed, paseo, and the rest. cc-remote is
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) with one change:
the `claude` it starts runs on the server.

## Install

Download the binary for your machine and put it on your PATH:

```sh
curl -Lo ~/.local/bin/cc-remote https://…/cc-remote-linux-x64 && chmod +x ~/.local/bin/cc-remote
echo devbox > ~/.config/cc-remote/host     # or: export CC_REMOTE_HOST=devbox, or pass --host
cc-remote doctor                           # checks ssh and the remote claude version
```

The host is anything `ssh` accepts. Ports, keys and jump hosts belong in `~/.ssh/config`.
Sessions share one ssh connection (`ControlMaster`), which sends `ServerAliveInterval=15` and
`ServerAliveCountMax=3`, so a dead link fails in about a minute instead of hanging. Put the same
options earlier in `CC_REMOTE_SSH` to override them. To use a different ssh command, set
`CC_REMOTE_SSH`, like rsync's `RSYNC_RSH`:

```sh
export CC_REMOTE_SSH="ssh -p 2222 -i ~/.ssh/devbox"
```

The server needs Claude Code 2.1.248 or later, logged in, and a POSIX login shell.
This machine doesn't need `claude` at all.

## Use

Add it to your ACP client as an agent whose command is `cc-remote --host devbox`.

Zed, in `settings.json`:

```json
"agent_servers": {
  "Claude (devbox)": { "command": "cc-remote", "args": ["--host", "devbox"] }
}
```

paseo, in `~/.paseo/config.json` under `agents.providers`:

```json
"claude-devbox": {
  "extends": "acp",
  "label": "Claude (devbox)",
  "command": ["cc-remote", "--host", "devbox"]
}
```

Or install the paseo plugin in `paseo-plugin/`, which adds a "Claude (remote)" provider and a
settings screen for the host (Settings → Plugins → cc-remote):

```sh
paseo plugin install github:AkaraChen/cc-remote:paseo-plugin
```

`cc-remote --cli <args>` runs `claude <args>` on the server, so `cc-remote --cli auth login`
logs it in and `cc-remote --cli --version` shows its version.

Permission requests go to your client like any ACP agent's. "Accept edits" and "don't ask
again for `npm test` commands" work for the local tools as they do for Claude Code's own.
Command approvals last until cc-remote exits.

Sessions are mirrored to `~/.claude/projects/` on this machine, where a local Claude Code
would keep them, so your client can list, load and fork them. A session the server has never
seen, such as a fork, is copied up when it's resumed.

## How it works

The Claude Agent SDK talks to `claude` over its stdin and stdout. claude-agent-acp runs the SDK
here, and cc-remote starts `claude` through ssh, so that conversation crosses the network.
Claude Code's own Read, Write, Edit, NotebookEdit, Bash, Glob and Grep are switched off and
replaced with versions that run in this process, with the same names and inputs. claude calls
them through the SDK's tool channel, the same way it calls any MCP tool. Your client's MCP
servers are bridged over that same channel. See `PLAN.md` for the design.

claude-agent-acp is patched in one place (`patches/`): a hook that rewrites each session's
`query()` options.

## Develop

```sh
bun install
bun test
CC_REMOTE_SSH=… bun src/main.ts --host devbox   # speaks ACP on stdio
bun run build      # dist/cc-remote-{linux-x64,linux-arm64,darwin-arm64}
```
