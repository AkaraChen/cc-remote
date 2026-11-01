Adds Claude Code running on a remote host as a Paseo provider, through
[cc-remote](https://github.com/AkaraChen/cc-remote). The model runs on the server where `claude`
is installed and logged in. File reads, edits, shell commands and your MCP servers run on the
machine where the Paseo daemon runs, in the agent's working directory.

## Setup

Install the `cc-remote` executable on the daemon machine. The server needs Claude Code 2.1.248 or
later, logged in, and must be reachable with plain `ssh`. Then open Settings → Plugins → cc-remote,
or "cc-remote: connection settings" in the Command Center, and set:

- Host: an ssh destination such as `devbox`. Ports, keys and jump hosts belong in `~/.ssh/config`.
  Left empty, cc-remote uses `$CC_REMOTE_HOST` or `~/.config/cc-remote/host`.
- ssh command: optional, passed as `CC_REMOTE_SSH`, for example `ssh -p 2222`.
- cc-remote executable: the path to cc-remote if it is not on the daemon's `PATH` or in
  `~/.local/bin`.

"Check" runs `cc-remote doctor` with the values on screen, before or after saving.

## Limits

Each new agent session uses the saved connection. Sessions already open keep the host they started
with. Settings are per daemon, so every agent on one daemon uses the same host.
