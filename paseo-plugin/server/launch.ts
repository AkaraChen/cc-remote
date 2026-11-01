import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { Connection } from "../shared/settings";

const HOST_FILE = join(homedir(), ".config", "cc-remote", "host");

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** The argv and environment that start cc-remote with these settings, plus any extra arguments. */
export function launch(connection: Connection, extra: string[] = []) {
  const argv = [expandHome(connection.command)];
  if (connection.host) argv.push("--host", connection.host);
  argv.push(...extra);

  const env: NodeJS.ProcessEnv = { ...process.env };
  // The README installs cc-remote to ~/.local/bin, which a daemon's PATH often lacks.
  env.PATH = [env.PATH, join(homedir(), ".local", "bin")].filter(Boolean).join(":");
  if (connection.sshCommand) env.CC_REMOTE_SSH = connection.sshCommand;
  return { argv, env };
}

/** Fails early with a pointer to the settings screen instead of a bare process exit. */
export function requireHost(connection: Connection) {
  if (connection.host || process.env.CC_REMOTE_HOST || existsSync(HOST_FILE)) return;
  throw new Error("cc-remote has no host. Set one in Settings → Plugins → cc-remote.");
}

/** Starts cc-remote and speaks newline-delimited JSON-RPC over its stdio, as ACP does. */
export function spawnAcp(connection: Connection): AcpStream {
  const { argv, env } = launch(connection);
  const [command, ...args] = argv;
  const child = spawn(command!, args, { env, stdio: ["pipe", "pipe", "pipe"] });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));

  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      let done = false;
      let buffer = "";
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error) controller.error(error);
        else controller.close();
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            controller.enqueue(JSON.parse(line) as AcpStreamMessage);
          } catch {
            console.error(`cc-remote wrote a line that isn't JSON: ${line}`);
          }
        }
      });
      child.stdout.on("end", () => finish());
      child.once("error", (error: NodeJS.ErrnoException) =>
        finish(
          error.code === "ENOENT"
            ? new Error(`${command} not found. Set the cc-remote executable in Settings → Plugins → cc-remote.`)
            : error,
        ),
      );
    },
    cancel() {
      child.kill();
    },
  });

  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      return new Promise<void>((resolve, reject) =>
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve())),
      );
    },
    close() {
      // cc-remote exits when its stdin closes; don't leave it behind if it doesn't.
      child.stdin.end();
      setTimeout(() => child.exitCode === null && child.kill(), 5000).unref();
    },
    abort() {
      child.kill();
    },
  });

  return { readable, writable };
}

export function doctor(connection: Connection): Promise<{ ok: boolean; output: string }> {
  const { argv, env } = launch(connection, ["doctor"]);
  const [command, ...args] = argv;
  return new Promise((resolve) => {
    execFile(command!, args, { env, timeout: 60_000 }, (error, stdout, stderr) => {
      const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join("\n");
      resolve({ ok: !error, output: output || error?.message || "" });
    });
  });
}
