#!/usr/bin/env bun
import { setQueryOptionsTransform } from "@agentclientprotocol/claude-agent-acp";
import acpPkg from "@agentclientprotocol/claude-agent-acp/package.json";
import { acpProtocolsFromEnv, serveAcp } from "@agentclientprotocol/claude-agent-acp/dist/serve.js";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { PROTOCOL, ask, door, serve as runDaemon, logFile, selfCommand, sockPath, spoolDir, startDaemon } from "./daemon";
import { remote } from "./options";
import { WINDOWS } from "./platform";
import { probeDaemon, quote, REMOTE_PATH, rsh, runRemote } from "./ssh";
import { killAll } from "./tools";
import { home } from "./tools/util";

const USAGE = `Usage: cc-remote [--host <host>]
       cc-remote [--host <host>] --cli <claude arguments...>
       cc-remote [--host <host>] doctor
       cc-remote daemon <install|status|logs|kill|uninstall>

Claude Code as an ACP agent, with the model on a remote host and the tools on this machine.
Point an ACP client (Zed, paseo, ...) at \`cc-remote --host <host>\`.

  --host <host>    ssh host where claude is installed and logged in
                   (else $CC_REMOTE_HOST, else ~/.config/cc-remote/host)
  --cli <args...>  run claude on the host with these arguments, e.g. --cli auth login
  doctor           check the connection, the remote claude version and the daemon
  daemon ...       the host's half: install it there, inspect it, stop it (see below)
  -v, --version    print the version
  -h, --help       print this help

  CC_REMOTE_SSH="ssh -p 2222"   ssh command to use, like rsync's RSYNC_RSH
  CC_REMOTE_DAEMON=off          never use the daemon, always a direct ssh
  CC_REMOTE_STEAL=1             take a session over from another client of the daemon

The daemon keeps claude running on the host when the ssh link drops. Install it there, once:

  ssh <host> cc-remote daemon install
  ssh <host> cc-remote daemon status`;

/** The oldest remote claude cc-remote has been run against. */
const MIN_CLAUDE = "2.1.248";

const fail = (message: string): never => {
  console.error(`cc-remote: ${message}`);
  process.exit(1);
};

const older = (a: string, b: string) => {
  const [x, y] = [a, b].map((s) => s.split(/[.-]/).map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! < y![i]!;
  return false;
};

function parse(argv: string[]) {
  const args = { host: undefined as string | undefined, cli: undefined as string[] | undefined, doctor: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--cli") { args.cli = argv.slice(i + 1); break; }
    if (a === "--host") args.host = argv[++i] ?? fail("--host needs a value");
    else if (a.startsWith("--host=")) args.host = a.slice(7);
    else if (a === "doctor") args.doctor = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else fail(`unknown argument ${a}. See cc-remote --help`);
  }
  return args;
}

async function host(flag?: string): Promise<string> {
  const file = Bun.file(`${home}/.config/cc-remote/host`);
  const found = flag ?? Bun.env.CC_REMOTE_HOST ?? ((await file.exists()) ? (await file.text()).trim() : "");
  return found || fail("no host. Pass --host, set CC_REMOTE_HOST, or write the host to ~/.config/cc-remote/host");
}

async function doctor(target: string) {
  console.log(`cc-remote ${pkg.version} (claude-agent-acp ${acpPkg.version})`);
  console.log(`host: ${target} via ${rsh().join(" ")}`);
  const proc = Bun.spawn([...rsh(), "-T", target, `${REMOTE_PATH} claude --version`], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) fail(`could not run claude on ${target}`);
  console.log(`remote claude: ${out}`);
  const probe = probeDaemon(target, true);
  const waited = `${probe.ms} ms round trip`;
  console.log(probe.version ? `daemon: ${probe.version} on ${target} (${waited})` : `daemon: not installed on ${target} (${waited}); every session is its own ssh`);
  if (older(out.split(" ")[0]!, MIN_CLAUDE)) fail(`remote claude is older than ${MIN_CLAUDE}. Run \`claude update\` on ${target}.`);
  console.log("ok");
}

/**
 * claude-agent-acp runs `claude auth status`, `claude auth logout` and the like itself. This points
 * it at a script that runs them on the host, through `cc-remote --cli`.
 */
function claudeShim(target: string) {
  const self = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/") ? [process.execPath] : [process.execPath, Bun.main];
  const name = `claude-${Bun.hash(target).toString(36)}`;
  const command = [...self, "--host", target, "--cli"];
  if (WINDOWS) {
    // The temp folder is already per user there.
    const file = join(tmpdir(), "cc-remote", `${name}.cmd`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `@echo off\r\n${command.map((a) => `"${a}"`).join(" ")} %*\r\n`);
    return file;
  }
  const dir = `/tmp/cc-remote-${userInfo().uid}`;
  const file = `${dir}/${name}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `#!/bin/sh\nexec ${command.map(quote).join(" ")} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** As claude-agent-acp's own entry point: ACP on stdio, everything else on stderr. */
function serve(target: string) {
  process.env.CLAUDE_CODE_EXECUTABLE = claudeShim(target);
  setQueryOptionsTransform(remote(target));
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;
  process.on("unhandledRejection", (reason) => console.error("cc-remote: unhandled rejection:", reason));
  const acp = serveAcp(undefined, { protocols: acpProtocolsFromEnv(Bun.env.CLAUDE_AGENT_ACP_PROTOCOL) });
  const shutdown = async () => {
    await acp.dispose().catch((e: unknown) => console.error("cc-remote: cleanup failed:", e));
    process.exit(0);
  };
  acp.closed.then(shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.resume();
}

// We approve our read-only tools with bare allowedTools entries on purpose, which the SDK warns about.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: [{ code?: string }?]) => {
  if (rest[0]?.code !== "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") emitWarning(warning, ...(rest as []));
}) as typeof process.emitWarning;

/** A "--flag value" pair from a daemon subcommand's arguments. */
const flagValue = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** "64m" as a byte count; the spool cap and nothing else. */
function bytes(value: string): number {
  const m = /^(\d+)([kmg]?)$/i.exec(value.trim());
  if (!m) return fail("not a size: " + value);
  return Number(m[1]) * 1024 ** (m[2] ? "kmg".indexOf(m[2].toLowerCase()) + 1 : 0);
}

/** "30m" as milliseconds; the linger and nothing else. */
function duration(value: string): number {
  const m = /^(\d+)([smh]?)$/i.exec(value.trim());
  if (!m) return fail("not a duration: " + value);
  return Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[m[2]?.toLowerCase() ?? "s"] ?? 1000);
}

const wrapperFile = () => join(home, ".local/bin/cc-remoted");
const unitFile = () => join(home, ".config/systemd/user/cc-remoted.service");

function systemd(args: string[]) {
  const done = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (done.status !== 0) console.error("cc-remote: systemctl --user " + args.join(" ") + " failed");
}

/** A user session bus that answers: a machine can have systemd and still not run it for this user. */
const userSystemd = () => existsSync("/run/systemd/system") && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;

/** Puts cc-remoted where the probe and the ssh command look for it: on the host's PATH. */
function putWrapper() {
  const file = wrapperFile();
  mkdirSync(dirname(file), { recursive: true });
  const note = "# cc-remoted: the daemon half of cc-remote, reached over ssh. Written by cc-remote daemon install.\n";
  writeFileSync(file, "#!/bin/sh\n" + note + "exec " + selfCommand() + ' daemon "$@"\n');
  chmodSync(file, 0o755);
  return file;
}

/** Installs the daemon on this machine, which is the host where claude runs. */
async function install() {
  console.log("daemon: " + putWrapper());
  // Under systemd the daemon is a user service, so it comes back after a reboot and survives a logout
  // (with lingering). Everywhere else it detaches from this shell and writes to its own log.
  let supervised = false;
  if (userSystemd()) {
    mkdirSync(dirname(unitFile()), { recursive: true });
    writeFileSync(
      unitFile(),
      [
        "[Unit]",
        "Description=cc-remote daemon: claude outlives the ssh session that started it",
        "",
        "[Service]",
        "Type=simple",
        "ExecStart=" + selfCommand() + " daemon serve",
        "Restart=on-failure",
        "RestartSec=3",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    supervised = spawnSync("systemctl", ["--user", "enable", "--now", "cc-remoted.service"], { stdio: "inherit" }).status === 0;
    // Without lingering the user manager stops at the last logout, taking claude with it.
    if (supervised) spawnSync("loginctl", ["enable-linger"], { stdio: "ignore" });
    if (!supervised) console.error("cc-remote: systemd --user would not take cc-remoted.service; running it detached instead");
  }
  if (!supervised) startDaemon();
  await new Promise((done) => setTimeout(done, 500));
  console.log("daemon: " + ((await ask({ version: true })) ? "running, supervision " + (supervised ? "systemd --user" : "none, log " + logFile()) : "not running; see " + logFile()));
}

async function uninstall() {
  if (existsSync(unitFile()) && userSystemd()) {
    systemd(["disable", "--now", "cc-remoted.service"]);
    unlinkSync(unitFile());
    systemd(["daemon-reload"]);
  } else {
    await ask({ stop: true });
  }
  if (existsSync(wrapperFile())) unlinkSync(wrapperFile());
  console.log("daemon: uninstalled; the spools are still in " + spoolDir());
}

async function daemonStatus() {
  const answer = await ask({ status: true });
  if (!answer) {
    console.log("cc-remoted: not running (" + sockPath() + " does not answer)");
    process.exitCode = 1;
    return;
  }
  console.log("cc-remoted " + answer.version + " (protocol " + answer.protocol + "), pid " + answer.pid + ", up " + answer.uptime + "s");
  if (!answer.instances.length) console.log("  no sessions");
  for (const i of answer.instances) {
    const size = (i.bytes / 1024).toFixed(0) + " KiB";
    console.log("  " + i.id + "  " + i.state + (i.attached ? " attached" : "") + "  " + size + "  " + i.age + "s  " + i.argv.join(" "));
  }
}

/** Prints a spool, or the daemon's own log; -f follows it. */
function logs(args: string[]) {
  const follow = args.includes("-f") || args.includes("--follow");
  const id = args.find((a) => !a.startsWith("-"));
  const file = id ? join(spoolDir(), id.replace(/[^\w.-]/g, "_") + ".log") : logFile();
  if (!existsSync(file)) fail("no log at " + file);
  let shown = 0;
  const show = () => {
    const size = statSync(file).size;
    if (size <= shown) return;
    const buf = Buffer.alloc(size - shown);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, shown);
    closeSync(fd);
    process.stdout.write(buf);
    shown = size;
  };
  show();
  if (follow) setInterval(show, 250);
}

async function killSession(id?: string) {
  if (!id) return fail("daemon kill needs a session id");
  const answer = await ask({ kill: id });
  if (!answer) return fail("the daemon is not running");
  if (answer.error) return fail(answer.error);
  console.log("daemon: SIGTERM sent to " + id);
}

/**
 * The daemon's commands, run on the host that runs claude: install it, look at it, stop it — or be
 * it, which is what the unit file and the ssh door do.
 */
async function daemon(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "serve") process.exit(await runDaemon({ cap: bytes(flagValue(rest, "--spool") ?? "64m"), linger: duration(flagValue(rest, "--linger") ?? "30m") }));
  if (command === "attach") process.exit(await door(rest));
  if (command === "version") return console.log("cc-remote " + pkg.version + " daemon " + PROTOCOL);
  if (command === "status") return daemonStatus();
  if (command === "install") return install();
  if (command === "uninstall") return uninstall();
  if (command === "logs") return logs(rest);
  if (command === "kill") return killSession(rest[0]);
  fail("unknown daemon command " + (command ?? "") + ". Try install, status, logs, kill or uninstall");
}

const argv = process.argv.slice(2);
if (argv[0] === "daemon") {
  await daemon(argv.slice(1));
} else {
  const args = parse(argv);
  if (args.help) {
    console.log(USAGE);
  } else if (args.version) {
    console.log(`${pkg.version} (cc-remote, claude-agent-acp ${acpPkg.version})`);
  } else {
    const target = await host(args.host);
    process.on("exit", killAll);
    if (args.cli) process.exit(await runRemote(target, args.cli, process.cwd()));
    else if (args.doctor) await doctor(target);
    else serve(target);
  }
}
