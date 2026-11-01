# cc-remote

Claude Code as an [ACP](https://agentclientprotocol.com) agent. The model runs on a remote host,
and the tools run on your machine.

You keep `claude` installed and logged in on one server. cc-remote reaches it over plain ssh and
runs every file read, edit and shell command locally, in the session's directory. Any ACP client
can use it: Zed, paseo, and others.

| Runs on your machine | Runs on the server |
|---|---|
| Read, Write, Edit, NotebookEdit, Bash (PowerShell on Windows), Glob, Grep | The model, the system prompt, the session |
| The MCP servers your ACP client brings | Web search, subagents, skills |
| Your `CLAUDE.md` files, git status, environment | The server's own settings and MCP servers |

The server only needs `claude`. Nothing else gets installed there, and your machine doesn't need
`claude` at all.

cc-remote is [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) with one
change: the `claude` it starts runs on the server. Sessions, permission prompts, modes, models,
forks and diffs all work the way they do in claude-agent-acp.

## Requirements

Before you start, have these two in place:

- **ssh to the server works.** `ssh devbox` logs you in without a password prompt (use a key, and
  put ports, users and jump hosts in `~/.ssh/config`).
- **`claude` on the server is logged in.** Claude Code 2.1.248 or later, with a POSIX login shell.
  Run `claude` there once and log in, or use `cc-remote --cli auth login` after installing.

On your machine you need [Bun](https://bun.sh) to build cc-remote. The binary it builds has no
dependencies. It runs on macOS, Linux and Windows; on Windows it also needs the OpenSSH client
that ships with Windows 10 and later.

## Install

```sh
git clone https://github.com/AkaraChen/cc-remote && cd cc-remote
bun install
bun run compile    # builds the binary for this machine into dist/cc-remote
bun link           # puts cc-remote on your PATH, in ~/.bun/bin
```

`bun run compile` picks the `build:<os>-<arch>` script for the machine you run it on. To build
every platform at once (linux-x64, linux-arm64, darwin-arm64, windows-x64, windows-arm64), run
`bun run build`; the binaries land in `dist/`.

Tell it which host to use, then check the connection:

```sh
mkdir -p ~/.config/cc-remote && echo devbox > ~/.config/cc-remote/host
cc-remote doctor
```

cc-remote looks for the host in this order: `--host`, then `$CC_REMOTE_HOST`, then
`~/.config/cc-remote/host`. The host can be anything `ssh` accepts. Ports, keys and jump hosts
go in `~/.ssh/config`.

If you need a different ssh command, set `CC_REMOTE_SSH`. It works like rsync's `RSYNC_RSH`:

```sh
export CC_REMOTE_SSH="ssh -p 2222 -i ~/.ssh/devbox"
```

If the server isn't logged in yet, run `cc-remote --cli auth login`.

## Use

Once cc-remote is installed, it works with any client that speaks ACP. Add an agent whose command
is `cc-remote --host devbox` (or just `cc-remote`, if you wrote the host file above).

**Zed**, in `settings.json`:

```json
"agent_servers": {
  "Claude (devbox)": { "command": "cc-remote", "args": ["--host", "devbox"] }
}
```

**paseo**, in `~/.paseo/config.json` under `agents.providers`:

```json
"claude-devbox": {
  "extends": "acp",
  "label": "Claude (devbox)",
  "command": ["cc-remote", "--host", "devbox"]
}
```

For paseo there is also a plugin in [`paseo-plugin/`](paseo-plugin). Install it instead of editing
the config: it adds a "Claude (remote)" provider and a settings screen for the host, the ssh
command and the executable path (Settings → Plugins → cc-remote). The "Check" button there runs
`cc-remote doctor`.

```sh
paseo plugin install github:AkaraChen/cc-remote:paseo-plugin
```

### Commands

```
cc-remote [--host <host>]                  speak ACP on stdio (what your client runs)
cc-remote [--host <host>] doctor           check ssh and the remote claude version
cc-remote [--host <host>] --cli <args...>  run `claude <args...>` on the server
cc-remote --version | --help
```

## Behavior

**Permissions.** Permission requests go to your client, the same as with any ACP agent. Read, Glob
and Grep never ask. "Accept edits" approves Write, Edit and NotebookEdit inside the session's
directory. When a Bash command asks, the approval it offers is for a command prefix (such as
`npm test:*`) rather than all of Bash. PowerShell commands on Windows work the same way. A command with `;`, `&`, `|`, redirects, `$(…)`, backticks
or newlines is never approved automatically. Prefix approvals last until cc-remote exits.

**Sessions.** Each session is mirrored to `~/.claude/projects/` on your machine, in the same place
a local Claude Code would keep it. Your client can list, replay, load and fork sessions from there.
If you resume a session the server has never seen, such as a fork, cc-remote copies it to the
server first. On the server, each local directory gets its own empty working folder at
`~/.cc-remote/ws/<your hostname>/<local path>/`.

**ssh.** By default all sessions share one connection (`ControlMaster`, kept open for 10 minutes).
Every connection sends `ServerAliveInterval=15` and `ServerAliveCountMax=3`, so a dead link fails
in about a minute instead of hanging. If an `-o` with the same name comes earlier in
`CC_REMOTE_SSH`, that one is used instead. Windows' OpenSSH can't share connections, so there each
session opens its own.

**Windows.** The shell tool is PowerShell instead of Bash, as in Claude Code on Windows. cc-remote
uses PowerShell 7 (`pwsh`) when it's on PATH, otherwise Windows PowerShell 5.1. Grep needs
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on PATH. On the server, a local directory
like `C:\Users\me\app` gets the working folder `~/.cc-remote/ws/<your hostname>/C/Users/me/app/`.

### Limits

- Your project's `.claude/` directory (commands, skills, agents, settings) is not sent to the
  server. The server's user-level settings, skills and MCP servers still apply.
- File checkpoints and rewind are recorded on the server, so they can't see your local edits.
- Bridged MCP servers from your client expose their tools only, not resources or prompts.
- LSP, Monitor and the worktree tools are turned off.

## How it works

The Claude Agent SDK talks to `claude` over its stdin and stdout. claude-agent-acp runs the SDK on
your machine, and cc-remote starts `claude` through `ssh -T`, so that same stream crosses the
network.

The built-in file and shell tools are turned off on the server. cc-remote replaces them with
local versions that have the same names and inputs, and `claude` calls them through the SDK's tool
channel, the same way it calls any in-process MCP tool. Your client's MCP servers use that same
channel. A proxy on the stream renames the tools back to their built-in names, so your client
renders diffs and terminals as usual. It also maps the server's paths to your local ones.

claude-agent-acp is patched in one place (`patches/`): a hook that rewrites the `query()` options
for each session. See [`PLAN.md`](PLAN.md) for the full design.

## Develop

```sh
bun install
bun test
bun src/main.ts --host devbox     # speaks ACP on stdio
bun run compile                   # dist/cc-remote, for this machine
bun run build                     # dist/cc-remote-{linux-x64,linux-arm64,darwin-arm64,windows-x64,windows-arm64}
```

`test/e2e/` has a minimal ACP client and a fake ssh, which runs the "remote" side on this machine
under a separate `HOME`. See the header of `test/e2e/client.ts` for usage.
