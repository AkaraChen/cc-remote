import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openSpool } from "../src/spool";
import { daemonEnabled } from "../src/ssh";
import { readLine } from "../src/wire";

const dir = mkdtempSync(join(tmpdir(), "cc-remote-daemon-unit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readLine", () => {
  test("handles fragmented chunks and coalesced trailing bytes without intercepting later data", () => {
    const stream = new PassThrough();
    const calls: { line: string | null; rest: string; err?: Error }[] = [];
    const tail: string[] = [];

    readLine(stream, (line, rest, err) => {
      calls.push({ line, rest: rest.toString("utf8"), err });
      if (rest.length) tail.push(rest.toString("utf8"));
      stream.on("data", (c: Buffer) => tail.push(c.toString("utf8")));
    });

    stream.write("hel");
    stream.write("lo\npart1\n");
    stream.write("part2\n");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ line: "hello", rest: "part1\n", err: undefined });
    expect(tail.join("")).toBe("part1\npart2\n");
  });

  test("strips trailing CR in CRLF lines", () => {
    const stream = new PassThrough();
    let result: { line: string | null; rest: string } | undefined;
    readLine(stream, (line, rest) => { result = { line, rest: rest.toString("utf8") }; });
    stream.write("ack\r\nbody");
    expect(result).toEqual({ line: "ack", rest: "body" });
  });

  test("rejects lines exceeding maxBytes both across chunks and on newline chunk", () => {
    const s1 = new PassThrough();
    let err1: Error | undefined;
    readLine(s1, (_line, _rest, err) => { err1 = err; }, 4);
    s1.write("12345");
    expect(err1?.message).toContain("exceeds 4 bytes");

    const s2 = new PassThrough();
    let err2: Error | undefined;
    readLine(s2, (_line, _rest, err) => { err2 = err; }, 4);
    s2.write("12");
    s2.write("345\nrest");
    expect(err2?.message).toContain("exceeds 4 bytes");

    const s3 = new PassThrough();
    let okLine: string | null | undefined;
    let err3: Error | undefined;
    readLine(s3, (line, _rest, err) => { okLine = line; err3 = err; }, 4);
    s3.write("1234\nok");
    expect(err3).toBeUndefined();
    expect(okLine).toBe("1234");
  });

  test("returns null on EOF before newline and supports detach()", async () => {
    const s1 = new PassThrough();
    const got = await new Promise<string | null>((resolve) => {
      readLine(s1, (line) => resolve(line));
      s1.end("partial");
    });
    expect(got).toBeNull();

    const s2 = new PassThrough();
    let called = false;
    const detach = readLine(s2, () => { called = true; });
    detach();
    s2.end("hello\n");
    await Bun.sleep(10);
    expect(called).toBe(false);
  });
});

describe("openSpool", () => {
  const collect = (spool: ReturnType<typeof openSpool>, id: string, since: number) => {
    const chunks: Uint8Array[] = [];
    spool.replay(id, since, (c) => chunks.push(c));
    return { chunks, data: Buffer.concat(chunks) };
  };

  test("appends, slices from arbitrary since offsets, and handles empty/end offsets", () => {
    const spool = openSpool(":memory:");
    try {
      spool.append("s1", 0, Buffer.alloc(0));
      spool.append("s1", 0, Buffer.from("abcdef"));
      spool.append("s1", 6, Buffer.from("ghijkl"));
      spool.append("s1", 12, Buffer.from("mn"));

      expect(collect(spool, "s1", 0).data.toString()).toBe("abcdefghijklmn");
      expect(collect(spool, "s1", 3).data.toString()).toBe("defghijklmn");
      expect(collect(spool, "s1", 6).data.toString()).toBe("ghijklmn");
      expect(collect(spool, "s1", 10).data.toString()).toBe("klmn");
      expect(collect(spool, "s1", 14).data.length).toBe(0);
    } finally {
      spool.close();
    }
  });

  test("replays >256 KiB payloads byte-for-byte with independent chunk buffers", () => {
    const spool = openSpool(":memory:");
    try {
      const sizes = [137, 4093, 16384, 65537, 32768, 70001, 130000, 999];
      const parts: Buffer[] = [];
      let offset = 0;
      for (let i = 0; i < sizes.length; i++) {
        const buf = Buffer.allocUnsafe(sizes[i]!);
        for (let j = 0; j < buf.length; j++) buf[j] = (i * 31 + j) & 0xff;
        spool.append("big", offset, buf);
        parts.push(buf);
        offset += buf.length;
      }
      const expected = Buffer.concat(parts);
      expect(expected.length).toBeGreaterThan(256 * 1024);

      const full = collect(spool, "big", 0);
      expect(Buffer.compare(full.data, expected)).toBe(0);
      expect(new Set(full.chunks.map((c) => c.buffer)).size).toBe(full.chunks.length);

      const mid = 123456;
      const partial = collect(spool, "big", mid);
      expect(Buffer.compare(partial.data, expected.subarray(mid))).toBe(0);
    } finally {
      spool.close();
    }
  });

  test("trim advances base cleanly and handles single oversized chunks", () => {
    const spool = openSpool(":memory:");
    try {
      const parts: Buffer[] = [];
      let end = 0;
      for (let i = 0; i < 20; i++) {
        const chunk = Buffer.alloc(100, 65 + (i % 26));
        spool.append("t1", end, chunk);
        parts.push(chunk);
        end += chunk.length;
      }
      const base = spool.trim("t1", 500, end, 1000);
      expect(base).toBe(1500);
      expect(Buffer.compare(collect(spool, "t1", base).data, Buffer.concat(parts).subarray(base))).toBe(0);

      // Single chunk larger than cap falls back to deleting offset < end - cap.
      spool.append("t2", 0, Buffer.alloc(1500, 88));
      expect(spool.trim("t2", 500, 1500, 1000)).toBe(1500);
      expect(collect(spool, "t2", 0).data.length).toBe(0);
    } finally {
      spool.close();
    }
  });

  test("drop deletes only the target instance and reopen clears stale rows", () => {
    const dbPath = join(dir, "restart.db");
    const s1 = openSpool(dbPath);
    s1.append("a", 0, Buffer.from("alpha"));
    s1.append("b", 0, Buffer.from("beta"));
    s1.drop("a");
    expect(collect(s1, "a", 0).data.length).toBe(0);
    expect(collect(s1, "b", 0).data.toString()).toBe("beta");
    s1.close();

    const s2 = openSpool(dbPath);
    try {
      expect(collect(s2, "b", 0).data.length).toBe(0);
    } finally {
      s2.close();
    }
  });
});

describe("daemonEnabled", () => {
  test("respects CC_REMOTE_DAEMON=off", () => {
    const prev = Bun.env.CC_REMOTE_DAEMON;
    try {
      delete Bun.env.CC_REMOTE_DAEMON;
      expect(daemonEnabled()).toBe(true);
      Bun.env.CC_REMOTE_DAEMON = "off";
      expect(daemonEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete Bun.env.CC_REMOTE_DAEMON;
      else Bun.env.CC_REMOTE_DAEMON = prev;
    }
  });
});
