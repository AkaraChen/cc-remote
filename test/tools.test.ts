import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "../src/tools/bash";
import { edit } from "../src/tools/edit";
import { glob } from "../src/tools/glob";
import { grep } from "../src/tools/grep";
import { read } from "../src/tools/read";
import { write } from "../src/tools/write";

const dir = mkdtempSync(join(tmpdir(), "cc-remote-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const call = async (t: { handler: (a: any, e: any) => Promise<unknown> }, input: object) => {
  const r = (await t.handler(input, {})) as Result;
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join(""), error: !!r.isError };
};

describe("Write and Read", () => {
  test("creates parent directories and reads back with line numbers", async () => {
    const file = join(dir, "a/b/c.txt");
    expect((await call(write, { file_path: file, content: "one\ntwo\nthree\n" })).text).toBe(`File created successfully at: ${file}`);
    expect((await call(write, { file_path: file, content: "one\ntwo\nthree\n" })).text).toContain("updated successfully");
    expect((await call(read, { file_path: file })).text).toBe("     1\tone\n     2\ttwo\n     3\tthree");
    expect((await call(read, { file_path: file, offset: 2, limit: 1 })).text).toBe("     2\ttwo");
  });
  test("reports missing files and directories", async () => {
    expect(await call(read, { file_path: join(dir, "nope") })).toMatchObject({ error: true });
    expect((await call(read, { file_path: dir })).text).toContain("EISDIR");
  });
  test("returns images as image blocks", async () => {
    await Bun.write(join(dir, "x.png"), new Uint8Array([137, 80, 78, 71]));
    expect((await call(read, { file_path: join(dir, "x.png") })).text).toBe("[image]");
  });
});

describe("Edit", () => {
  const file = join(dir, "edit.txt");
  test("replaces a unique match literally", async () => {
    await Bun.write(file, "price: 1\nname: x\n");
    expect((await call(edit, { file_path: file, old_string: "price: 1", new_string: "price: $&" })).error).toBe(false);
    expect(await Bun.file(file).text()).toBe("price: $&\nname: x\n");
  });
  test("refuses ambiguous matches unless replace_all", async () => {
    await Bun.write(file, "a a a");
    expect((await call(edit, { file_path: file, old_string: "a", new_string: "b" })).text).toContain("Found 3 matches");
    await call(edit, { file_path: file, old_string: "a", new_string: "b", replace_all: true });
    expect(await Bun.file(file).text()).toBe("b b b");
  });
  test("reports a missing string and creates files from an empty old_string", async () => {
    expect((await call(edit, { file_path: file, old_string: "zzz", new_string: "y" })).text).toContain("not found");
    const created = join(dir, "new.txt");
    await call(edit, { file_path: created, old_string: "", new_string: "hi" });
    expect(await Bun.file(created).text()).toBe("hi");
  });
});

describe("Bash", () => {
  test("merges stdout and stderr and reports exit codes", async () => {
    expect(await call(bash, { command: "echo out; echo err >&2" })).toEqual({ text: "out\nerr", error: false });
    expect(await call(bash, { command: "echo nope; exit 3" })).toEqual({ text: "nope\nExit code 3", error: true });
  });
  test("keeps the working directory between calls", async () => {
    await call(bash, { command: `cd ${dir}` });
    expect((await call(bash, { command: "pwd -P" })).text).toBe(Bun.spawnSync(["realpath", dir]).stdout.toString().trim());
  });
  test("times out and does not wait for background children", async () => {
    const started = Date.now();
    expect((await call(bash, { command: "sleep 30", timeout: 1000 })).text).toContain("timed out");
    expect((await call(bash, { command: "sleep 30 & echo started" })).text).toBe("started");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("Glob and Grep", () => {
  test("finds files newest first and skips node_modules", async () => {
    await Bun.write(join(dir, "g/old.ts"), "export const needle = 1;\n");
    await Bun.sleep(20);
    await Bun.write(join(dir, "g/new.ts"), "const NEEDLE = 2;\n");
    await Bun.write(join(dir, "g/node_modules/dep.ts"), "needle");
    expect((await call(glob, { pattern: "**/*.ts", path: join(dir, "g") })).text).toBe(`${dir}/g/new.ts\n${dir}/g/old.ts`);
  });
  test("searches contents in each output mode", async () => {
    const path = join(dir, "g");
    expect((await call(grep, { pattern: "needle", path })).text).toBe(`Found 1 file\n${dir}/g/old.ts`);
    expect((await call(grep, { pattern: "needle", path, "-i": true, output_mode: "count" })).text.split("\n").sort()).toEqual([`${dir}/g/new.ts:1`, `${dir}/g/old.ts:1`]);
    expect((await call(grep, { pattern: "NEEDLE", path, output_mode: "content" })).text).toBe(`${dir}/g/new.ts:1:const NEEDLE = 2;`);
    expect((await call(grep, { pattern: "absent", path })).text).toBe("No files found");
  });
});
