import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { ask, daemonDir, door, selfCmd, serve, startDaemon, waitDaemon } from "./daemon";
import { quote } from "./ssh";
import { PROTOCOL, type InstanceInfo } from "./wire";

const USAGE = "Usage: cc-remote daemon <install|uninstall|status|kill <id>|stop>";
const wrapperPath = () => join(homedir(), ".local/bin/cc-remoted");
const unitPath = () => join(homedir(), ".config/systemd/user/cc-remoted.service");
const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;

function systemdAvailable(): boolean {
  if (process.platform !== "linux" || Bun.env.CC_REMOTE_NO_SYSTEMD || homedir() !== userInfo().homedir) return false;
  return Bun.spawnSync(["systemctl", "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

async function stopDaemon(dir = daemonDir()): Promise<boolean> {
  let pid: number | undefined;
  try { pid = (await ask<{ pid?: number }>({ stop: true }, dir)).pid; } catch { return false; }
  for (let i = 0; pid && i < 80; i++) {
    try { process.kill(pid, 0); await Bun.sleep(25); } catch { break; }
  }
  return true;
}

/** Handles `cc-remote daemon <subcommand>` and `cc-remoted <subcommand>`. */
export async function runDaemonCli(argv: string[]): Promise<number> {
  const [sub, arg] = argv;
  if (!sub || sub === "-h" || sub === "--help") { console.log(USAGE); return 0; }
  if (sub === "version") { console.log(`${pkg.version} (protocol ${PROTOCOL})`); return 0; }
  if (sub === "serve") { await serve(); return 0; }
  if (sub === "attach") { await door(); return 0; }
  if (sub === "stop") { console.log((await stopDaemon()) ? "stopped" : "daemon: not running"); return 0; }

  if (sub === "install") {
    const wrapper = wrapperPath();
    mkdirSync(dirname(wrapper), { recursive: true });
    writeFileSync(wrapper, `#!/bin/sh\nexec ${selfCmd().map(quote).join(" ")} daemon "$@"\n`);
    chmodSync(wrapper, 0o755);
    if (systemdAvailable()) {
      const unit = unitPath();
      mkdirSync(dirname(unit), { recursive: true });
      writeFileSync(unit, `[Unit]\nDescription=cc-remote daemon\n\n[Service]\nExecStart=${wrapper} serve\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`);
      run(["systemctl", "--user", "daemon-reload"]);
      const code = run(["systemctl", "--user", "enable", "--now", "cc-remoted.service"]);
      if (code !== 0) return code;
      Bun.spawnSync(["loginctl", "enable-linger", userInfo().username], { stdout: "ignore", stderr: "ignore" });
      await waitDaemon();
      console.log("installed cc-remoted (systemd user service)");
      return 0;
    }
    if (!(await ask({ version: true }).then(() => true, () => false))) { startDaemon(); await waitDaemon(); }
    console.log("installed cc-remoted (background daemon)");
    return 0;
  }
  if (sub === "uninstall") {
    if (existsSync(unitPath()) && systemdAvailable()) {
      run(["systemctl", "--user", "disable", "--now", "cc-remoted.service"]);
      rmSync(unitPath(), { force: true });
      run(["systemctl", "--user", "daemon-reload"]);
    } else await stopDaemon();
    rmSync(wrapperPath(), { force: true });
    console.log("uninstalled cc-remoted");
    return 0;
  }
  if (sub === "status") {
    try {
      const s = await ask<{ version: string; protocol: number; pid: number; instances: InstanceInfo[] }>({ status: true });
      console.log(`daemon: v${s.version} (protocol ${s.protocol}, pid ${s.pid}), ${s.instances.length} instance(s)`);
      for (const i of s.instances) console.log(`  ${i.id}  ${i.state}  pid=${i.pid ?? "-"}  bytes=${i.base}..${i.end}  ${i.cwd}`);
      return 0;
    } catch { console.log("daemon: not running"); return 1; }
  }
  if (sub === "kill") {
    if (!arg) { console.error("usage: cc-remote daemon kill <id>"); return 1; }
    try {
      if ((await ask<{ gone?: boolean }>({ kill: arg })).gone) { console.error(`not found: ${arg}`); return 1; }
      console.log(`killed ${arg}`);
      return 0;
    } catch { console.error("daemon: not running"); return 1; }
  }
  console.error(`unknown daemon command: ${sub}\n${USAGE}`);
  return 1;
}
