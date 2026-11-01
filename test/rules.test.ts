import { describe, expect, test } from "bun:test";
import { strip } from "../src/names";
import { canUseTool, matches, parseRules } from "../src/permissions";
import { quote, remoteCommand } from "../src/ssh";

describe("names", () => {
  test("strips the MCP prefix from whole tool names only", () => {
    const msg = JSON.stringify({ name: "mcp__cc__Bash", tools: ["WebSearch", "mcp__cc__Read"], text: "I used mcp__cc__Bash" });
    expect(JSON.parse(strip(msg))).toEqual({ name: "Bash", tools: ["WebSearch", "Read"], text: "I used mcp__cc__Bash" });
  });
});

describe("rules", () => {
  test("parses comma- and space-separated rules, keeping spaces inside parentheses", () => {
    expect(parseRules(["Read,Edit Bash(git diff *)", "WebFetch(domain:x.com)"])).toEqual([
      { tool: "Read", content: undefined }, { tool: "Edit", content: undefined },
      { tool: "Bash", content: "git diff *" }, { tool: "WebFetch", content: "domain:x.com" },
    ]);
  });
  test("matches Bash prefixes the way Claude Code does", () => {
    const [rule] = parseRules(["Bash(git diff *)"]);
    expect(matches(rule!, "Bash", { command: "git diff HEAD" })).toBe(true);
    expect(matches(rule!, "Bash", { command: "git diff" })).toBe(true);
    expect(matches(rule!, "Bash", { command: "git diff-index" })).toBe(false);
    expect(matches(rule!, "Bash", { command: "rm -rf / && git diff" })).toBe(false);
  });
  test("matches file rules as globs", () => {
    const [rule] = parseRules(["Edit(src/**)"]);
    expect(matches(rule!, "Edit", { file_path: `${process.cwd()}/src/a/b.ts` })).toBe(true);
    expect(matches(rule!, "Edit", { file_path: `${process.cwd()}/test/a.ts` })).toBe(false);
  });
  test("approves reads, allowed rules and acceptEdits without asking", async () => {
    const decide = canUseTool(parseRules(["Bash(ls *)"]), "acceptEdits");
    const opts = {} as Parameters<typeof decide>[2];
    expect((await decide("mcp__cc__Read", { file_path: "/x" }, opts))?.behavior).toBe("allow");
    expect((await decide("mcp__cc__Bash", { command: "ls -la" }, opts))?.behavior).toBe("allow");
    expect((await decide("mcp__cc__Edit", { file_path: "/x" }, opts))?.behavior).toBe("allow");
  });
});

describe("ssh", () => {
  test("quotes words for a POSIX shell", () => {
    const word = `it's $HOME "x"`;
    expect(Bun.spawnSync(["sh", "-c", `printf %s ${quote(word)}`]).stdout.toString()).toBe(word);
  });
  test("builds a remote command that cds into a per-directory folder", () => {
    const cmd = remoteCommand(["--model", "it's"], { A: "1" }, "/home/me/my project");
    expect(cmd).toContain(`/.cc-remote/ws/'`);
    expect(cmd).toContain("/home/me/my project'");
    expect(cmd).toEndWith(`exec env 'A=1' claude '--model' 'it'\\''s'`);
  });
});
