/// <reference types="@cloudflare/workers-types" />
// D1Database on bun:sqlite: the subset the server uses (prepare/bind/all/first/run/raw, batch as a transaction, exec).
import { Database } from "bun:sqlite";
type Params = unknown[];
const conv = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v === undefined ? null : v) as never;
const isRead = (sql: string) => /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
class Statement {
  constructor(private db: Database, private sql: string, private params: Params = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values.map(conv)); }
  private prep() { return this.db.prepare(this.sql); }
  runSync() {
    const q = this.prep();
    try {
      if (isRead(this.sql)) { const results = q.all(...(this.params as never[])); return { results, success: true, meta: { changes: 0, last_row_id: 0, duration: 0, rows_read: results.length, rows_written: 0 } }; }
      const r = q.run(...(this.params as never[]));
      return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), duration: 0, rows_read: 0, rows_written: r.changes } };
    } finally { q.finalize(); }
  }
  async all<T = Record<string, unknown>>() { return this.runSync() as unknown as D1Result<T>; }
  async run<T = Record<string, unknown>>() { return this.runSync() as unknown as D1Result<T>; }
  async first<T = Record<string, unknown>>(column?: string) {
    const q = this.prep();
    try { const row = q.get(...(this.params as never[])) as Record<string, unknown> | null; if (!row) return null; return (column ? row[column] : row) as T; } finally { q.finalize(); }
  }
  async raw<T = unknown[]>(opts?: { columnNames?: boolean }) {
    const q = this.prep();
    try { const rows = q.values(...(this.params as never[])) as unknown as T[]; return (opts?.columnNames ? [q.columnNames as unknown as T, ...rows] : rows); } finally { q.finalize(); }
  }
}
export function d1(db: Database): D1Database {
  const api = {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => db.transaction(() => statements.map((s) => s.runSync()))(),
    exec: async (sql: string) => { const t = Date.now(); db.exec(sql); return { count: sql.split(";").filter((s) => s.trim()).length, duration: Date.now() - t }; },
    dump: async () => { throw new Error("dump is not supported"); },
    withSession: () => { throw new Error("sessions are not supported"); },
  };
  return api as unknown as D1Database;
}
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;");
  return db;
}
