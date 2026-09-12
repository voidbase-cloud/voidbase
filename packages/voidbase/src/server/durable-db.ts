/// <reference types="@cloudflare/workers-types" />
// The instance's database as a SQLite-backed Durable Object: one per instance, exported from the instance's own
// Worker the way the realtime hub is (hooks-plugin appends it to Void's generated entry; the deploy binds it as
// DB_OBJECT under its own new_sqlite_classes migration when VOIDBASE_DATABASE=durable), reached through
// src/server/durable-d1.ts, which makes it look like the D1 binding every query already goes through.
//
// Why an object: it is a single writer over its own SQLite file, so `batch` runs inside transactionSync and is a
// real transaction (all or nothing, rolled back on the first error) where D1's batch is a best effort of the same.
// What it is not: a way past SQLite's ceilings. workerd enforces the same 100 columns per table and 100 bound
// parameters per statement on this storage as D1 does (measured on workerd 1.20260903.1 by
// test/workers-durable.ts: "too many columns", "too many SQL variables"), so the docs say so rather than promise
// otherwise. Results are shaped like D1's (results, success, meta) and errors carry SQLite's own message
// ("UNIQUE constraint failed: table.column"), which is what the server matches on.
//
// The system tables come from the same db/migrations/*.sql Void applies to a D1 (src/server/schema-sql.ts is their
// generated copy): applied once, in order, inside the constructor's blockConcurrencyWhile and recorded in
// _void_migrations (a name the backups skip), so the first request after a deploy finds the schema as it would on D1.
import { DurableObject } from "cloudflare:workers";
import { SYSTEM_MIGRATIONS } from "./schema-sql";
import type { DurableQueryResult, DurableRawResult, DurableStatementInput } from "./durable-d1";
import type { Bindings } from "./types";

const MIGRATIONS_TABLE = "_void_migrations";
const isRead = (sql: string) => /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
const isDDL = (sql: string) => /^\s*(CREATE|DROP|ALTER)\b/i.test(sql);

export class VoidbaseDatabase extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.migrate(); });
  }

  /** one statement; the results as D1 shapes them */
  query(sql: string, params: unknown[] = []): DurableQueryResult { return this.run(sql, params); }

  /** rows as arrays plus the column names, for the SQL console (a name repeated across joined tables survives) */
  raw(sql: string, params: unknown[] = []): DurableRawResult {
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const columns = cursor.columnNames;
    return { columns, rows: [...cursor.raw()] as unknown[][] };
  }

  /** one or more statements without bindings (D1's exec) */
  exec(sql: string): { count: number; duration: number } {
    const t = Date.now();
    this.ctx.storage.sql.exec(sql);
    return { count: sql.split(";").filter((s) => s.trim()).length, duration: Date.now() - t };
  }

  /** all or nothing: the statements run inside one transaction, rolled back when any of them throws */
  batch(statements: DurableStatementInput[]): DurableQueryResult[] {
    return this.ctx.storage.transactionSync(() => statements.map((s) => this.run(s.sql, s.params)));
  }

  private run(sql: string, params: unknown[]): DurableQueryResult {
    const t = Date.now();
    const db = this.ctx.storage.sql;
    const cursor = db.exec(sql, ...params);
    const results = cursor.toArray() as Record<string, unknown>[];
    // changes() and last_insert_rowid() describe the last write, so they are read only after one
    const m = !isRead(sql) && !isDDL(sql) ? db.exec("SELECT changes() AS changes, last_insert_rowid() AS id").one() : null;
    return { results, success: true, meta: { changes: Number(m?.changes ?? 0), last_row_id: Number(m?.id ?? 0), duration: Date.now() - t, rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten } };
  }

  // the system tables, once: the same files Void applies to a D1, each inside its own transaction
  private migrate(): void {
    const db = this.ctx.storage.sql;
    db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY NOT NULL, applied TEXT NOT NULL)`);
    const applied = new Set(db.exec(`SELECT name FROM ${MIGRATIONS_TABLE}`).toArray().map((r) => String(r.name)));
    for (const m of SYSTEM_MIGRATIONS) {
      if (applied.has(m.name)) continue;
      this.ctx.storage.transactionSync(() => {
        for (const statement of m.statements) db.exec(statement);
        db.exec(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied) VALUES (?, ?)`, m.name, new Date().toISOString());
      });
    }
  }
}
