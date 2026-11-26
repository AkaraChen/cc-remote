import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channel } from "../../src/channel";
import { ask } from "../../src/daemon";
import type { SpawnLike } from "../../src/proxy";
import { probeDaemon, spawner } from "../../src/ssh";
import { ENDED, GONE, readLine, type Ack, type Hello, type InstanceInfo } from "../../src/wire";

const root = mkdtempSync(join(tmpdir(), "cc-remote-daemon-e2e-"));
const mainTs = join(import.meta.dir, "../../src/main.ts");
const fakesshPath = join(import.meta.dir, "fakessh");

const homes: string[] = [];
const daemonPids = new Set<number>();
const children = new Set<ChildProcess>();

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function trackDaemon(home: string): number {
  const pid = Number(readFileSync(join(home, ".cc-remote/daemon.pid"), "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid daemon.pid in ${home}`);
  daemonPids.add(pid);
  return pid;
}

function cleanupSync() {
  for (const c of children) try { c.kill("SIGKILL"); } catch {}
  for (const h of homes) {
    try {
      const p = Number(readFileSync(join(h, ".cc-remote/daemon.pid"), "utf8").trim());
      if (p > 0) daemonPids.add(p);
    } catch {}
  }
  for (const pid of daemonPids) try { process.kill(pid, "SIGKILL"); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanupSync);
process.on("SIGINT", () => { cleanupSync(); process.exit(1); });
process.on("SIGTERM", () => { cleanupSync(); process.exit(1); });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function makeHome(name: string): string {
  const h = join(root, name);
  mkdirSync(join(h, ".local/bin"), { recursive: true });
  homes.push(h);
  return h;
}

function writeScript(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function writeMockClaude(home: string, jsBody: string) {
  writeScript(join(home, ".local/bin/claude"), `#!/usr/bin/env bun\n${jsBody}\n`);
}

function makeSshWrap(home: string, name = "ssh.sh", pidLog?: string): string {
  const p = join(home, name);
  const logLine = pidLog ? `echo $$ >> ${JSON.stringify(pidLog)}\n` : "";
  writeScript(p, `#!/bin/sh\nexport FAKE_HOST_HOME=${JSON.stringify(home)} REAL_HOME=${JSON.stringify(process.env.HOME ?? "")}\n${logLine}exec ${JSON.stringify(fakesshPath)} "$@"\n`);
  return p;
}

async function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, mainTs, ...args], {
    env: { ...process.env, HOME: home, CC_REMOTE_NO_SYSTEMD: "1", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

function waitExit(proc: SpawnLike, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for exit")), timeoutMs);
    proc.once("exit", (code: number | null, signal: NodeJS.Signals | null) => { clearTimeout(t); resolve({ code, signal }); });
    proc.once("error", (err: Error) => { clearTimeout(t); reject(err); });
  });
}

function attachDirect(home: string, hello: Hello, onAck?: (ack: Ack, proc: ChildProcess, writeOut: (s: string) => void) => void) {
  return new Promise<{ code: number | null; ack: Ack; body: string }>((resolve, reject) => {
    const proc = spawn(join(home, ".local/bin/cc-remoted"), ["attach"], {
      env: { ...process.env, HOME: home, CC_REMOTE_NO_SYSTEMD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(proc);
    let ack: Ack | undefined;
    const chunks: Buffer[] = [];
    const writeIn = (s: string) => { if (proc.stdin!.writable) proc.stdin!.write(s); };
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("attachDirect timeout")); }, 8000);

    readLine(proc.stdout!, (line, rest, err) => {
      if (err || line === null) return;
      ack = JSON.parse(line) as Ack;
      if (rest.length) chunks.push(rest);
      proc.stdout!.on("data", (c: Buffer) => chunks.push(c));
      onAck?.(ack, proc, writeIn);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      children.delete(proc);
      if (!ack) return reject(new Error(`attach closed without ack (code=${code})`));
      resolve({ code, ack, body: Buffer.concat(chunks).toString("utf8") });
    });
    proc.stdin!.write(`${JSON.stringify(hello)}\n`);
  });
}

async function pollUntil<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await Bun.sleep(25)) {
    const v = await fn();
    if (v !== undefined) return v;
  }
  throw new Error("pollUntil timed out");
}

async function step(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  await fn();
  console.log(`PASS ${name} (${Date.now() - t0}ms)`);
}

// 1. No daemon zero regression (CC_REMOTE_DAEMON=off & uninstalled host)
await step("1. no-daemon zero regression", async () => {
  const h1 = makeHome("h1");
  writeMockClaude(h1, `
    import { createInterface } from "node:readline";
    console.log(JSON.stringify({ type: "system", subtype: "init" }));
    createInterface({ input: process.stdin }).on("line", (l) => {
      console.log(JSON.stringify({ echo: l }));
      if (l === "quit") process.exit(0);
    });
  `);
  const wrap1 = makeSshWrap(h1);
  const prevSsh = Bun.env.CC_REMOTE_SSH, prevDaemon = Bun.env.CC_REMOTE_DAEMON;
  try {
    Bun.env.CC_REMOTE_SSH = wrap1;
    Bun.env.CC_REMOTE_DAEMON = "off";
    const ac = new AbortController();
    const proc = spawner("fakehost", join(root, "cwd1"), {}, false)({ command: "claude", args: [], signal: ac.signal, env: {} });
    const lines: string[] = [];
    proc.stdout!.on("data", (c: Buffer) => lines.push(c.toString("utf8")));
    proc.stdin!.write("ping\nquit\n");
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("no-daemon exit timeout")), 5000);
      proc.once("exit", () => { clearTimeout(t); res(); });
    });
    const out = lines.join("");
    assert(out.includes('"echo":"ping"') && out.includes('"echo":"quit"'), `unexpected direct ssh output: ${out}`);
    assert(!existsSync(join(h1, ".cc-remote/daemon.db")), "daemon.db should not exist");
    assert(!existsSync(join(h1, ".cc-remote/daemon.sock")), "daemon.sock should not exist");

    const h1b = makeHome("h1b");
    Bun.env.CC_REMOTE_SSH = makeSshWrap(h1b);
    delete Bun.env.CC_REMOTE_DAEMON;
    const probe = await probeDaemon("fakehost-no-daemon", true);
    assert(!probe.version, `expected uninstalled host, got ${probe.version}`);
  } finally {
    if (prevSsh === undefined) delete Bun.env.CC_REMOTE_SSH; else Bun.env.CC_REMOTE_SSH = prevSsh;
    if (prevDaemon === undefined) delete Bun.env.CC_REMOTE_DAEMON; else Bun.env.CC_REMOTE_DAEMON = prevDaemon;
  }
});

// 2. Mid-stream reconnect (kill -9 on ssh)
await step("2. mid-stream reconnect across kill -9", async () => {
  const h2 = makeHome("h2");
  assert((await runCli(h2, ["daemon", "install"])).code === 0, "install h2");
  trackDaemon(h2);

  const claudePidLog = join(h2, "claude-pid.log");
  const stdinLog = join(h2, "stdin.log");
  const sshPidLog = join(h2, "ssh-pids.log");
  writeMockClaude(h2, `
    import { appendFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    appendFileSync(${JSON.stringify(claudePidLog)}, process.pid + "\\n");
    console.log(JSON.stringify({ type: "init", pid: process.pid }));
    createInterface({ input: process.stdin }).on("line", (l) => {
      appendFileSync(${JSON.stringify(stdinLog)}, l + "\\n");
      console.log(JSON.stringify({ type: "ack", line: l }));
      if (l === "quit") process.exit(0);
    });
    for (let i = 1; i <= 40; i++) {
      console.log(JSON.stringify({ type: "tick", n: i }));
      await Bun.sleep(20);
    }
  `);
  const wrap = makeSshWrap(h2, "ssh.sh", sshPidLog);
  const ch = channel({ ssh: [wrap, "-T", "fakehost"], spawn: { argv: ["claude"], cwd: ".cc-remote/ws/h2", env: {} } });

  let exitedEarly = false;
  const exitP = waitExit(ch).then((r) => { exitedEarly = true; return r; });
  const msgs: any[] = [];
  let buf = "", killedSsh = false, sentDuring = false, sentQuit = false;
  let beforeAck = false, duringAck = false;

  ch.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      msgs.push(m);
      if (m.type === "ack" && m.line === "before") beforeAck = true;
      if (m.type === "ack" && m.line === "during") duringAck = true;
    }
  });

  ch.stdin!.write("before\n");
  await pollUntil(async () => (beforeAck && msgs.some((m) => m.type === "tick" && m.n >= 10) ? true : undefined));
  assert(!exitedEarly, "channel exited before disconnect test");

  const sshPid1 = Number(readFileSync(sshPidLog, "utf8").trim().split("\n").at(-1));
  process.kill(sshPid1, "SIGKILL");
  killedSsh = true;
  await Bun.sleep(60);
  ch.stdin!.write("during\n");
  sentDuring = true;

  await pollUntil(async () => (duringAck && msgs.some((m) => m.type === "tick" && m.n === 40) ? true : undefined), 8000);
  assert(!exitedEarly, "channel exited mid-stream on ssh kill");
  ch.stdin!.write("quit\n");
  sentQuit = true;
  const res = await exitP;
  assert(killedSsh && sentDuring && sentQuit && res.code === 0, `unexpected exit code ${res.code}`);

  const ticks = msgs.filter((m) => m.type === "tick").map((m) => m.n);
  assert(ticks.length === 40 && ticks.every((n, i) => n === i + 1), `ticks mismatch: count=${ticks.length}`);
  assert(readFileSync(claudePidLog, "utf8").trim().split("\n").length === 1, "claude respawned across disconnect");
  assert(readFileSync(sshPidLog, "utf8").trim().split("\n").length >= 2, "expected reconnect ssh process");
  assert(readFileSync(stdinLog, "utf8").trim().split("\n").join(",") === "before,during,quit", `stdin mismatch: ${readFileSync(stdinLog, "utf8")}`);
});

// 3. >256 KiB large replay across disconnect
await step("3. >256 KiB large replay across disconnect", async () => {
  const h3 = makeHome("h3");
  assert((await runCli(h3, ["daemon", "install"])).code === 0, "install h3");
  trackDaemon(h3);

  const lineA = "A".repeat(255) + "\n"; // 256 bytes
  const part1 = lineA.repeat(64) + "PAUSE\n"; // ~16 KiB
  const part2Lines: string[] = [];
  for (let i = 0; i < 1200; i++) part2Lines.push(`B_${String(i).padStart(4, "0")}_${"X".repeat(250)}\n`); // ~312 KiB
  const part2 = part2Lines.join("") + "END\n";
  const expected = Buffer.from(part1 + part2, "utf8");
  assert(expected.length > 300 * 1024, "expected payload > 300 KiB");

  writeMockClaude(h3, `
    const lineA = "A".repeat(255) + "\\n";
    process.stdout.write(lineA.repeat(64) + "PAUSE\\n");
    await Bun.sleep(200);
    for (let i = 0; i < 1200; i++) process.stdout.write("B_" + String(i).padStart(4, "0") + "_" + "X".repeat(250) + "\\n");
    process.stdout.write("END\\n");
    process.exit(0);
  `);
  const sshPidLog = join(h3, "ssh-pids.log");
  const ch = channel({ ssh: [makeSshWrap(h3, "ssh.sh", sshPidLog), "-T", "fakehost"], spawn: { argv: ["claude"], cwd: ".cc-remote/ws/h3", env: {} } });

  const chunks: Buffer[] = [];
  let killed = false;
  ch.stdout!.on("data", (c: Buffer) => {
    chunks.push(c);
    if (!killed && Buffer.concat(chunks).toString("utf8").includes("PAUSE\n")) {
      killed = true;
      const pid = Number(readFileSync(sshPidLog, "utf8").trim().split("\n").at(-1));
      process.kill(pid, "SIGKILL");
    }
  });

  const res = await waitExit(ch, 10_000);
  assert(killed && res.code === 0, `large replay failed: killed=${killed} code=${res.code}`);
  const got = Buffer.concat(chunks);
  assert(Buffer.compare(got, expected) === 0, `large replay byte mismatch: got=${got.length} expected=${expected.length}`);
});

// 4. Pre-ack disconnect (before first ack received by client)
await step("4. pre-ack disconnect avoids duplicate spawn", async () => {
  const h4 = makeHome("h4");
  assert((await runCli(h4, ["daemon", "install"])).code === 0, "install h4");
  trackDaemon(h4);

  const spawnsLog = join(h4, "spawns.log");
  writeMockClaude(h4, `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(spawnsLog)}, process.pid + "\\n");
    process.stdout.write('{"type":"init","seq":0}\\n');
    for (let i = 1; i <= 5; i++) process.stdout.write(JSON.stringify({ type: "tick", n: i }) + "\\n");
    await Bun.sleep(200);
    process.exit(0);
  `);

  const attemptFile = join(h4, "attempt.txt");
  const sabotageSsh = join(h4, "sabotage-ssh");
  writeScript(sabotageSsh, `#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const n = (existsSync(${JSON.stringify(attemptFile)}) ? Number(readFileSync(${JSON.stringify(attemptFile)}, "utf8")) : 0) + 1;
writeFileSync(${JSON.stringify(attemptFile)}, String(n));
const env = { ...process.env, FAKE_HOST_HOME: ${JSON.stringify(h4)}, REAL_HOME: process.env.HOME ?? "" };
if (n === 1) {
  const child = spawn(${JSON.stringify(fakesshPath)}, process.argv.slice(2), { env, stdio: ["pipe", "pipe", "inherit"] });
  process.stdin.pipe(child.stdin!);
  child.stdout!.once("data", () => {
    // Daemon already received {id, since:0, spawn} and emitted ack; kill before forwarding ack to client.
    child.kill("SIGKILL");
    process.exit(255);
  });
} else {
  const child = spawn(${JSON.stringify(fakesshPath)}, process.argv.slice(2), { env, stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 1));
}
`);

  const ch = channel({ ssh: [sabotageSsh, "-T", "fakehost"], spawn: { argv: ["claude"], cwd: ".cc-remote/ws/h4", env: {} } });
  const chunks: Buffer[] = [];
  ch.stdout!.on("data", (c: Buffer) => chunks.push(c));
  const res = await waitExit(ch, 8000);
  assert(res.code === 0, `expected exit 0, got ${res.code}`);
  assert(Number(readFileSync(attemptFile, "utf8")) === 2, "expected 2 ssh attempts");
  assert(readFileSync(spawnsLog, "utf8").trim().split("\n").length === 1, "claude was spawned more than once");
  const out = Buffer.concat(chunks).toString("utf8");
  assert(out.startsWith('{"type":"init","seq":0}\n'), `lost init line: ${out.slice(0, 80)}`);
  for (let i = 1; i <= 5; i++) assert(out.includes(`"n":${i}`), `missing tick ${i}`);
});

// 5. Spool trim (CC_REMOTE_SPOOL_BYTES=1024)
await step("5. spool trim enforces cap and returns gone for trimmed offsets", async () => {
  const h5 = makeHome("h5");
  assert((await runCli(h5, ["daemon", "install"], { CC_REMOTE_SPOOL_BYTES: "1024" })).code === 0, "install h5");
  trackDaemon(h5);

  writeMockClaude(h5, `
    import { createInterface } from "node:readline";
    process.stdout.write("READY\\n");
    createInterface({ input: process.stdin }).on("line", async (l) => {
      if (l === "FLOOD") {
        for (let b = 0; b < 40; b++) {
          let batch = "";
          for (let i = 0; i < 4; i++) batch += "F" + String(b * 4 + i).padStart(4, "0") + "_" + "Z".repeat(121) + "\\n";
          process.stdout.write(batch);
          await Bun.sleep(2);
        }
        process.stdout.write("AFTER_FLOOD\\n");
      }
      if (l === "QUIT") process.exit(0);
    });
  `);

  const sshPidLog = join(h5, "ssh-pids.log");
  const ch = channel({ ssh: [makeSshWrap(h5, "ssh.sh", sshPidLog), "-T", "fakehost"], spawn: { argv: ["claude"], cwd: ".cc-remote/ws/h5", env: {} } });
  let out = "";
  ch.stdout!.on("data", (c: Buffer) => { out += c.toString("utf8"); });
  await pollUntil(async () => (out.includes("READY\n") ? true : undefined));

  const floodT0 = Date.now();
  ch.stdin!.write("FLOOD\n");
  await pollUntil(async () => (out.includes("AFTER_FLOOD\n") ? true : undefined), 4000);
  assert(Date.now() - floodT0 < 3000, "flood took too long");

  const dDir = join(h5, ".cc-remote");
  const status1 = await ask<{ instances: InstanceInfo[] }>({ status: true }, dDir);
  assert(status1.instances.length === 1, "expected 1 instance");
  const inst1 = status1.instances[0]!;
  assert(inst1.base > 0 && inst1.end - inst1.base <= 1024, `expected trimmed base>0 and window<=1024, got ${inst1.base}..${inst1.end}`);

  // Detach channel and confirm trimmed offset returns GONE (20), while inst.base succeeds.
  process.kill(Number(readFileSync(sshPidLog, "utf8").trim().split("\n").at(-1)), "SIGKILL");
  ch.kill("SIGTERM");
  await pollUntil(async () => {
    const s = await ask<{ instances: InstanceInfo[] }>({ status: true }, dDir);
    return s.instances[0]?.state === "detached" ? true : undefined;
  });

  const goneRes = await attachDirect(h5, { id: inst1.id, since: 0 }, (_ack, proc) => proc.stdin!.end());
  assert(goneRes.code === GONE && "gone" in goneRes.ack, `expected GONE(20), got code=${goneRes.code} ack=${JSON.stringify(goneRes.ack)}`);

  const okRes = await attachDirect(h5, { id: inst1.id, since: inst1.base }, (ack, _proc, writeIn) => {
    assert("ok" in ack && ack.ok && ack.from === inst1.base, `unexpected ack: ${JSON.stringify(ack)}`);
    writeIn("QUIT\n");
  });
  assert(okRes.code === ENDED && okRes.body.includes("AFTER_FLOOD\n"), `expected tail with AFTER_FLOOD, got code=${okRes.code}`);
});

// 6. Protocol mismatch fails fast without reconnect loop
await step("6. protocol mismatch exits fast without reconnect", async () => {
  const h6 = makeHome("h6");
  const countFile = join(h6, "count.txt");
  const badSsh = join(h6, "bad-proto-ssh");
  writeScript(badSsh, `#!/bin/sh
n=$(( $(cat ${JSON.stringify(countFile)} 2>/dev/null || echo 0) + 1 ))
echo "$n" > ${JSON.stringify(countFile)}
printf '{"ok":true,"protocol":999,"id":"x","from":0}\n'
sleep 5
`);
  const t0 = Date.now();
  const ch = channel({ ssh: [badSsh, "-T", "fakehost"], spawn: { argv: ["claude"], cwd: ".cc-remote/ws/h6", env: {} } });
  const res = await waitExit(ch, 3000);
  const elapsed = Date.now() - t0;
  assert(res.code === 1 && elapsed < 1500, `expected fast code=1 exit, got code=${res.code} in ${elapsed}ms`);
  assert(Number(readFileSync(countFile, "utf8").trim()) === 1, "channel retried on protocol mismatch");
});

// 7. Exited instance replays remaining tail and returns GONE at end
await step("7. exited instance tail replay and since===end gone", async () => {
  const h7 = makeHome("h7");
  assert((await runCli(h7, ["daemon", "install"])).code === 0, "install h7");
  trackDaemon(h7);

  writeMockClaude(h7, `
    process.stdout.write("LINE1\\n");
    await Bun.sleep(150);
    process.stdout.write("LINE2\\nTAIL\\n");
    process.exit(0);
  `);

  const id = randomUUID();
  const dDir = join(h7, ".cc-remote");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(join(h7, ".local/bin/cc-remoted"), ["attach"], {
      env: { ...process.env, HOME: h7, CC_REMOTE_NO_SYSTEMD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(proc);
    let data = "";
    const t = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("timeout waiting LINE1")); }, 5000);
    proc.stdout!.on("data", (c: Buffer) => {
      data += c.toString("utf8");
      if (data.includes("LINE1\n")) {
        clearTimeout(t);
        proc.kill("SIGKILL");
        children.delete(proc);
        resolve();
      }
    });
    proc.stdin!.write(`${JSON.stringify({ id, since: 0, spawn: { argv: ["claude"], cwd: ".cc-remote/ws/h7", env: {} } })}\n`);
  });

  const exitedInst = await pollUntil(async () => {
    const s = await ask<{ instances: InstanceInfo[] }>({ status: true }, dDir);
    const found = s.instances.find((i) => i.id === id);
    return found?.state === "exited" ? found : undefined;
  });

  const tailRes = await attachDirect(h7, { id, since: "LINE1\n".length }, (_ack, proc) => proc.stdin!.end());
  assert(tailRes.code === ENDED && "ok" in tailRes.ack, `expected ENDED(0), got ${tailRes.code}`);
  assert(tailRes.body === "LINE2\nTAIL\n", `unexpected tail: ${JSON.stringify(tailRes.body)}`);

  const endRes = await attachDirect(h7, { id, since: exitedInst.end }, (_ack, proc) => proc.stdin!.end());
  assert(endRes.code === GONE && "gone" in endRes.ack, `expected GONE(20) at end, got ${endRes.code}`);
});

// 8. daemon stop, daemon uninstall, and door() auto-start
await step("8. daemon stop, uninstall, and door() auto-start", async () => {
  const h8a = makeHome("h8a");
  assert((await runCli(h8a, ["daemon", "install"])).code === 0, "install h8a");
  const p8a = trackDaemon(h8a);
  assert(alive(p8a), "h8a daemon should be alive");
  assert((await runCli(h8a, ["daemon", "stop"])).code === 0, "stop h8a");
  assert(!alive(p8a), "h8a daemon still alive after stop");

  const h8b = makeHome("h8b");
  assert((await runCli(h8b, ["daemon", "install"])).code === 0, "install h8b");
  const p8b = trackDaemon(h8b);
  assert(existsSync(join(h8b, ".local/bin/cc-remoted")), "wrapper should exist");
  assert((await runCli(h8b, ["daemon", "uninstall"])).code === 0, "uninstall h8b");
  assert(!alive(p8b), "h8b daemon still alive after uninstall");
  assert(!existsSync(join(h8b, ".local/bin/cc-remoted")), "wrapper should be removed");

  const h8c = makeHome("h8c");
  assert((await runCli(h8c, ["daemon", "install"])).code === 0, "install h8c");
  const p8c1 = trackDaemon(h8c);
  assert((await runCli(h8c, ["daemon", "stop"])).code === 0, "stop h8c");
  assert(!alive(p8c1), "h8c first daemon should be stopped");
  writeMockClaude(h8c, `process.stdout.write("AUTO\\n"); process.exit(0);`);
  const autoRes = await attachDirect(h8c, { id: randomUUID(), since: 0, spawn: { argv: ["claude"], cwd: ".cc-remote/ws/h8c", env: {} } });
  assert(autoRes.code === ENDED && autoRes.body === "AUTO\n", `unexpected auto-start attach: ${JSON.stringify(autoRes)}`);
  const p8c2 = trackDaemon(h8c);
  assert(alive(p8c2), "h8c auto-started daemon should be alive");
  assert((await runCli(h8c, ["daemon", "stop"])).code === 0, "stop h8c auto-started");
  assert(!alive(p8c2), "h8c auto-started daemon should be dead");
});

// 9. Invalid command spawn (ENOENT) does not disrupt sibling session
await step("9. invalid command spawn isolates sibling session", async () => {
  const h9 = makeHome("h9");
  assert((await runCli(h9, ["daemon", "install"])).code === 0, "install h9");
  const p9 = trackDaemon(h9);

  writeMockClaude(h9, `
    import { createInterface } from "node:readline";
    process.stdout.write("ALIVE\\n");
    createInterface({ input: process.stdin }).on("line", (l) => {
      if (l === "PING") process.stdout.write("PONG\\n");
      if (l === "QUIT") process.exit(0);
    });
  `);

  const chA = channel({ ssh: [makeSshWrap(h9), "-T", "fakehost"], spawn: { argv: ["claude"], cwd: ".cc-remote/ws/h9", env: {} } });
  let outA = "";
  chA.stdout!.on("data", (c: Buffer) => { outA += c.toString("utf8"); });
  await pollUntil(async () => (outA.includes("ALIVE\n") ? true : undefined));

  const badRes = await attachDirect(h9, { id: randomUUID(), since: 0, spawn: { argv: ["nonexistent-cc-remote-cmd-xyz"], cwd: ".cc-remote/ws/bad", env: {} } }, (_a, p) => p.stdin!.end());
  assert(badRes.code === ENDED || badRes.code === GONE, `unexpected bad spawn exit code: ${badRes.code}`);
  assert(alive(p9), "daemon died on ENOENT spawn");

  chA.stdin!.write("PING\n");
  await pollUntil(async () => (outA.includes("PONG\n") ? true : undefined));
  chA.stdin!.write("QUIT\n");
  const resA = await waitExit(chA, 5000);
  assert(resA.code === 0, `sibling session failed: ${resA.code}`);
});

// 10. Assert zero leftover daemon processes
await step("10. zero leftover daemon processes", async () => {
  for (const h of homes) {
    if (existsSync(join(h, ".cc-remote/daemon.sock"))) await runCli(h, ["daemon", "stop"]);
  }
  await Bun.sleep(50);
  const stillAlive = [...daemonPids].filter(alive);
  assert(stillAlive.length === 0, `leaked daemon PIDs: ${stillAlive.join(", ")}`);
});
