import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Spool = {
  append(id: string, offset: number, data: Uint8Array): void;
  replay(id: string, since: number, write: (chunk: Uint8Array) => void): void;
  trim(id: string, keepBytes: number, end: number, cap?: number): number;
  drop(id: string): void;
  close(): void;
};

/** Opens the SQLite spool in WAL mode and clears leftover rows from any prior daemon run. */
export function openSpool(path: string): Spool {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS chunks (
      id     TEXT    NOT NULL,
      offset INTEGER NOT NULL,
      data   BLOB    NOT NULL,
      PRIMARY KEY (id, offset)
    ) WITHOUT ROWID;
    DELETE FROM chunks;
  `);

  const insert = db.query("INSERT INTO chunks (id, offset, data) VALUES (?, ?, ?)");
  const select = db.query("SELECT offset, data FROM chunks WHERE id = ? AND offset + length(data) > ? ORDER BY offset");
  const delKeep = db.query("DELETE FROM chunks WHERE id = ? AND offset + length(data) <= ?");
  const delCap = db.query("DELETE FROM chunks WHERE id = ? AND offset < ?");
  const minOffset = db.query("SELECT MIN(offset) AS base FROM chunks WHERE id = ?");
  const delAll = db.query("DELETE FROM chunks WHERE id = ?");

  return {
    append(id, offset, data) {
      if (data.byteLength > 0) insert.run(id, offset, data);
    },
    replay(id, since, write) {
      for (const row of select.iterate(id, since) as Iterable<{ offset: number; data: Uint8Array }>) {
        const slice = row.offset < since ? row.data.subarray(since - row.offset) : row.data;
        if (slice.byteLength > 0) write(slice);
      }
    },
    trim(id, keepBytes, end, cap = keepBytes * 2) {
      if (delKeep.run(id, end - keepBytes).changes === 0) delCap.run(id, end - cap);
      return (minOffset.get(id) as { base: number | null } | null)?.base ?? end;
    },
    drop(id) { delAll.run(id); },
    close() { db.close(); },
  };
}
