/**
 * `bun run compile`: runs the build:<os>-<arch> script for this machine, then puts the binary at
 * dist/cc-remote, where package.json's bin points, so `bun link` installs it.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const os = process.platform === "win32" ? "windows" : process.platform;
const target = `${os}-${process.arch}`;
const script = `build:${target}`;
if (!(script in pkg.scripts)) {
  const known = Object.keys(pkg.scripts).filter((s) => s.startsWith("build:")).map((s) => s.slice(6));
  console.error(`compile: no build script for ${target}. Known targets: ${known.join(", ")}`);
  process.exit(1);
}

const root = join(import.meta.dir, "..");
const build = Bun.spawnSync(["bun", "run", script], { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

// Bun adds .exe to Windows builds. The bin keeps no extension so one package.json fits every
// platform; the .exe copy is for running or copying by hand.
const exe = os === "windows" ? ".exe" : "";
const built = join(root, "dist", `cc-remote-${target}${exe}`);
const outputs = [join(root, "dist", "cc-remote"), ...(exe ? [join(root, "dist", `cc-remote${exe}`)] : [])];
for (const out of outputs) copyFileSync(built, out);
console.log(`compile: ${built} -> ${outputs.join(", ")}`);
