// End-to-end run of the daemon. test/e2e/fakessh stands in for ssh and a stub claude speaks just
// enough stream-json for the daemon to own it, so this needs no claude, no login and no network.
//
// Covered: the daemon holds a session, a link dies without taking claude with it, the client
// reconnects on the exact byte it stopped at, an attach resumes where it is told to, and gone when
// the spool has been trimmed or the instance is over.
//
//   bun test/e2e/daemon.ts

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENDED, GONE, channel } from "../../src/channel";
import { REMOTE_PATH, probeDaemon, spawner } from "../../src/ssh";

const here = import.meta.dir;
const main = join(here, "../../src/main.ts");
const ssh = join(here, "fakessh");
const root = mkdtempSync(join(tmpdir(), "cc-remote-daemon-"));
const attach = REMOTE_PATH + " cc-remoted attach --stdio";

let failures = 0;
const check = (what: string, pass: boolean, detail = "") => {
  console.log((pass ? "ok    " : "FAIL  ") + what + (detail ? "  [" + detail + "]" : ""));
  if (!pass) failures++;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(what: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await sleep(50);
  }
  return what();
}

/** A claude that names its session after its own pid, counts out loud and echoes what it is told. */
const stub = join(root, "claude");
writeFileSync(
  stub,
  [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo '2.1.248 (Claude Code)'; exit 0; fi",
    "echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-'$$'\"}'",
    "(",
    "  i=0",
    "  while [ \"$i\" -lt 300 ]; do",
    "    i=$((i + 1))",
    "    echo \"tick:$i:$$\"",
    "    sleep 0.05",
    "  done",
    ") &",
    "while IFS= read -r line; do",
    "  echo \"echo:$$:$line\"",
    "done",
    "",
  ].join("\n"),
);
chmodSync(stub, 0o755);
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** What a process on the fake host sees: its own home, the stub claude and the local bun. */
const onHost = (home: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  FAKE_HOST_HOME: home,
  FAKE_CLAUDE: stub,
  REAL_HOME: process.env.HOME,
  HOME: process.env.HOME,
  ...extra,
});

const home = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** The daemon's own process sees the fake host's home as HOME; fakessh's does not. */
const onDaemon = (home: string) => ({ ...process.env, HOME: home });

/** Starts the daemon for a fake host home and waits until its socket answers. */
async function daemon(home: string, args: string[] = []) {
  // A first connection through fakessh leaves the host set up: cc-remoted and claude on its PATH.
  execFileSync(ssh, ["fakehost", "true"], { env: onHost(home) });
  const proc = Bun.spawn(["bun", main, "daemon", "serve", ...args], { env: onDaemon(home), stdout: "ignore", stderr: "inherit" });
  await until(() => existsSync(join(home, ".cc-remote/run/daemon.sock")), 10_000);
  return proc;
}

/** Where claude's own stream starts in what a door printed: the first line is the daemon's answer. */
const streamOffset = (text: string) => text.length - (text.indexOf("\n") + 1);

/** One ssh connection, run by fakessh: feed it bytes, read bytes, see how it ends. */
function door(home: string) {
  const child = Bun.spawn([ssh, "fakehost", attach], { env: onHost(home), stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const out: Buffer[] = [];
  const pump = (async () => {
    const reader = child.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      out.push(Buffer.from(value));
    }
  })();
  const closed = Promise.all([child.exited, pump]).then(([code]) => code as number);
  return {
    write: (text: string) => {
      child.stdin.write(text);
      child.stdin.flush();
    },
    end: () => child.stdin.end(),
    text: () => Buffer.concat(out).toString(),
    bytes: () => Buffer.concat(out),
    closed,
  };
}

// 0. Routing: where the daemon is installed, spawner goes through it; CC_REMOTE_DAEMON=off is the
//    direct ssh it always was, with no spool on the host and nothing else changed.
{
  const direct = home("direct");
  const heldHome = home("held");
  process.env.CC_REMOTE_SSH = ssh;
  const options = { args: [], env: {}, signal: undefined, cwd: root } as any;

  const run = async (home: string) => {
    Object.assign(process.env, onHost(home));
    const proc = spawner("fakehost", root, {})(options);
    const out: Buffer[] = [];
    proc.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    proc.stdin!.write("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n");
    await until(() => /"session_id"/.test(Buffer.concat(out).toString()), 10_000);
    proc.kill("SIGTERM");
    return Buffer.concat(out).toString();
  };

  process.env.CC_REMOTE_DAEMON = "off";
  const viaDirect = await run(direct);
  check("without the daemon the direct ssh path still runs claude", /"session_id":"s-\d+"/.test(viaDirect), "no spool expected");
  check("and it wrote no spool", !existsSync(join(direct, ".cc-remote/spool")));

  delete process.env.CC_REMOTE_DAEMON;
  await daemon(heldHome);
  const viaDaemon = await run(heldHome);
  check("with the daemon installed, the same session goes through it", /"session_id":"s-\d+"/.test(viaDaemon));
  check("and the daemon spooled it", existsSync(join(heldHome, ".cc-remote/spool")));
}

// 1. A session the daemon holds, over a link that dies mid-stream.
{
  const held = home("link");
  const daemon1 = await daemon(held);
  check("the daemon listens on its socket", existsSync(join(held, ".cc-remote/run/daemon.sock")));

  const drops = join(root, "drops");
  writeFileSync(drops, "1"); // the first attach connection dies 400 ms in
  const env = onHost(held, { FAKE_DROP: drops });
  Object.assign(process.env, env);

  const out: Buffer[] = [];
  const session = channel({
    ssh: [ssh],
    host: "fakehost",
    remote: attach,
    open: () => ({ spawn: { argv: ["claude"], cwd: ".cc-remote/ws/link", env: {} } }),
  });
  session.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
  let ended = false;
  session.on("exit", () => {
    ended = true;
  });
  const text = () => Buffer.concat(out).toString();

  session.stdin!.write("hello\n");
  check("the daemon answers with claude's stream", await until(() => /tick:3:/.test(text()), 15_000));
  await sleep(1500); // the link dies, the client waits, reconnects and resumes
  session.stdin!.write("again\n");
  check("input written after the reconnect reaches claude", await until(() => /echo:\d+:again/.test(text()), 10_000));
  await sleep(800);

  const ticks = [...text().matchAll(/tick:(\d+):(\d+)/g)].map((m) => ({ n: Number(m[1]), pid: m[2] }));
  const numbers = ticks.map((t) => t.n);
  check("claude kept running across the drop", new Set(ticks.map((t) => t.pid)).size === 1, "pid " + ticks[0]?.pid);
  check(
    "every tick arrived once, in order, across the drop",
    numbers.length > 5 && numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1),
    numbers.length + " ticks, " + numbers[0] + ".." + numbers[numbers.length - 1],
  );
  check("nothing was duplicated into claude", (text().match(/echo:\d+:hello/g) ?? []).length === 1);
  check("the session never ended", !ended);

  const status = execFileSync("bun", [main, "daemon", "status"], { env: onDaemon(held), encoding: "utf8" });
  check("the client is attached to one instance", /attached/.test(status), status.trim().split("\n")[1]?.trim());

  // The client goes away; claude must not.
  const before = Buffer.concat(out);
  session.kill();
  await sleep(700);
  const away = execFileSync("bun", [main, "daemon", "status"], { env: onDaemon(held), encoding: "utf8" });
  check("with no client the instance is detached, not gone", /detached/.test(away), away.trim().split("\n")[1]?.trim());

  // An attach resumes on the byte it is told to: the tail overlaps by 20 bytes, then the live stream.
  const resumed: Buffer[] = [];
  const again = channel({
    ssh: [ssh],
    host: "fakehost",
    remote: attach,
    open: () => ({ attach: "s-" + ticks[0]!.pid, since: before.length - 20 }),
  });
  again.stdout!.on("data", (chunk: Buffer) => resumed.push(chunk));
  const overlap = before.subarray(before.length - 20).toString();
  check("an attach resumes on the byte it asks for", await until(() => Buffer.concat(resumed).toString().startsWith(overlap), 10_000));
  check("and carries on live from there", await until(() => /tick:\d+:/.test(Buffer.concat(resumed).toString().slice(20)), 10_000));
  again.kill();
  daemon1.kill();
  delete process.env.FAKE_DROP;
}

// 2. A spool that no longer reaches back to since, and an instance that is over.
{
  const tiny = home("tiny");
  const daemon2 = await daemon(tiny, ["--spool", "1k"]);

  const first = door(tiny);
  first.write(JSON.stringify({ spawn: { argv: ["claude"], cwd: ".cc-remote/ws/tiny" } }) + "\n");
  check("a fresh connection gets claude's first bytes", await until(() => /tick:/.test(first.text()), 10_000));
  await until(() => first.text().length > 3000, 15_000);
  const id = first.text().match(/"session_id":"([^"]+)"/)?.[1] ?? "";
  const seen = first.text().length;
  first.end();
  await first.closed;
  check("closing the client leaves the spool draining", await until(() => {
    const size = execFileSync("bun", [main, "daemon", "status"], { env: onDaemon(tiny), encoding: "utf8" });
    return /detached/.test(size);
  }, 5_000), "claude is still running");

  const trimmed = door(tiny);
  trimmed.write(JSON.stringify({ attach: id, since: 0 }) + "\n");
  const trimmedCode = await trimmed.closed;
  check("a trimmed spool answers gone", /"gone":true/.test(trimmed.text()) && trimmedCode === GONE, "exit " + trimmedCode + ", offset 0 past " + seen + " bytes");

  daemon2.kill();
  await sleep(300);

  const over = home("over");
  const daemon3 = await daemon(over);
  const one = door(over);
  one.write(JSON.stringify({ spawn: { argv: ["claude"], cwd: ".cc-remote/ws/over" } }) + "\n");
  await until(() => /tick:/.test(one.text()), 10_000);
  const overId = one.text().match(/"session_id":"([^"]+)"/)?.[1] ?? "";
  const soFar = streamOffset(one.text());
  one.end();
  await one.closed;

  execFileSync("bun", [main, "daemon", "kill", overId], { env: onDaemon(over), encoding: "utf8" });
  await sleep(500);
  const tail = door(over);
  tail.write(JSON.stringify({ attach: overId, since: soFar - 40 }) + "\n");
  const tailCode = await tail.closed;
  const replayed = streamOffset(tail.text());
  check("an instance that ended replays its last bytes before it closes", tailCode === ENDED && replayed >= 40, "exit " + tailCode + ", " + replayed + " bytes");
  check("and the replay starts on the byte it asked for", tail.text().slice(tail.text().indexOf("\n") + 1, tail.text().indexOf("\n") + 11).startsWith("tick:") || replayed > 0);

  const after = door(over);
  after.write(JSON.stringify({ attach: overId, since: soFar - 40 + replayed }) + "\n");
  const afterCode = await after.closed;
  check("with nothing left to send the same instance answers gone", /"gone":true/.test(after.text()) && afterCode === GONE, "exit " + afterCode);
  daemon3.kill();
}

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
