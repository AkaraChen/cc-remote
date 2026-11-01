# cc-remote

`claude -p`, with the model on a remote host and the tools on your machine.

Claude Code runs on a server where it is installed and logged in. Every file read, edit
and shell command runs here, in your current directory. Web search, subagents, skills and
the server's MCP servers keep running on the server. Nothing is installed on the server
beyond `claude` itself, and cc-remote reaches it over plain ssh.

```sh
cc-remote --host devbox "fix the failing tests"
```

## Install

Download the binary for your machine and put it on your PATH:

```sh
curl -Lo ~/.local/bin/cc-remote https://…/cc-remote-linux-x64 && chmod +x ~/.local/bin/cc-remote
echo devbox > ~/.config/cc-remote/host     # or: export CC_REMOTE_HOST=devbox
cc-remote doctor                           # checks ssh and the remote claude version
```

The host is anything `ssh` accepts. Ports, keys and jump hosts belong in `~/.ssh/config`.
To use a different ssh command, set `CC_REMOTE_SSH`, like rsync's `RSYNC_RSH`:

```sh
export CC_REMOTE_SSH="ssh -p 2222 -i ~/.ssh/devbox"
```

The server needs Claude Code 2.1.248 or later, logged in, and a POSIX login shell.

## Use

cc-remote takes the same options as `claude -p`, so it can stand in for it:

```sh
alias claude=cc-remote
claude -p "explain this repo" --output-format json | jq -r .result
git diff | claude "review this diff"
claude -c "now add tests"
```

`-p` is optional. Run `cc-remote --help` for the options it supports.

When a tool needs approval, cc-remote asks on your terminal, even when stdout is piped.
Without a terminal it denies the call, as `claude -p` does. Approve ahead of time with
`--allowedTools "Bash(npm test *)"` or `--permission-mode acceptEdits`.

## How it works

The Claude Agent SDK talks to `claude` over its stdin and stdout. cc-remote runs the SDK
locally and starts `claude` through ssh, so that conversation crosses the network unchanged.
Claude Code's own Read, Write, Edit, NotebookEdit, Bash, Glob and Grep are switched off and
replaced with versions that run in this process, with the same names and inputs. When Claude
asks a clarifying question, it appears on your terminal. claude calls them through
the SDK's tool channel, the same way it calls any MCP tool. See `PLAN.md` for the design.

## Develop

```sh
bun install
bun test
bun src/main.ts --host devbox "hello"
bun run build      # dist/cc-remote-{linux-x64,linux-arm64,darwin-arm64}
```
