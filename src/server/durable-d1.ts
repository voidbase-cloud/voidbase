/// <reference types="@cloudflare/workers-types" />
// D1Database over the instance's own database Durable Object (src/server/durable-db.ts): the interface every
// query in src/server/db.ts goes through, so with VOIDBASE_DATABASE=durable nothing but this seam changes. One RPC
// per statement, one per batch; the object runs a batch inside transactionSync, the real transaction D1's batch
// only approximates. Bun keeps src/node/d1.ts over bun:sqlite; a deploy without the knob keeps D1.
import type { Bindings } from "./types";

/** the deploy knob: `d1` (unset, the default) or `durable`, from the environment or pb_secrets/secrets.json */
export const DATABASE_VAR = "VOIDBASE_DATABASE";
export type DatabaseKind = "d1" | "durable";
export function databaseKind(v: string | undefined | null): DatabaseKind {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "d1") return "d1";
  if (s === "durable" || s === "do" || s === "durable-object") return "durable";
  throw new Error(`${DATABASE_VAR}=${v}: expected d1 or durable`);
}
/** the binding, the class and its migration tag, as the deploy writes them (src/node/deploy-cf.ts) */
export const DB_OBJECT_BINDING = "DB_OBJECT";
export const DB_OBJECT_CLASS = "VoidbaseDatabase";
export const DB_OBJECT_MIGRATION_TAG = "voidbase-database-v1";
/** one object per instance: the namespace is the instance's own, so the name only has to be stable */
export const DB_OBJECT_NAME = "db";

export interface DurableStatementInput { sql: string; params: unknown[] }
export interface DurableQueryResult { results: Record<string, unknown>[]; success: true; meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number } }
export interface DurableRawResult { columns: string[]; rows: unknown[][] }
/** the object's RPC surface as the Worker sees it: every call answers with a promise */
export interface DatabaseStub {
  query(sql: string, params: unknown[]): Promise<DurableQueryResult>;
  raw(sql: string, params: unknown[]): Promise<DurableRawResult>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  batch(statements: DurableStatementInput[]): Promise<DurableQueryResult[]>;
}

// what src/server/db.ts bindValue leaves is already null/number/string/0-1/ArrayBuffer; a bare undefined becomes null
const conv = (v: unknown) => (v === undefined ? null : v);

class DurableStatement {
  constructor(private readonly stub: () => DatabaseStub, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...values: unknown[]) { return new DurableStatement(this.stub, this.sql, values.map(conv)); }
  input(): DurableStatementInput { return { sql: this.sql, params: this.params }; }
  async all<T = Record<string, unknown>>() { return (await this.stub().query(this.sql, this.params)) as unknown as D1Result<T>; }
  async run<T = Record<string, unknown>>() { return (await this.stub().query(this.sql, this.params)) as unknown as D1Result<T>; }
  /** the first row (or its `column`), null when there is none, as D1 and src/node/d1.ts answer */
  async first<T = Record<string, unknown>>(column?: string) {
    const row = (await this.stub().query(this.sql, this.params)).results[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  /** rows as arrays; with columnNames the names come first, which is what the SQL console reads */
  async raw<T = unknown[]>(opts?: { columnNames?: boolean }) {
    const r = await this.stub().raw(this.sql, this.params);
    return opts?.columnNames ? [r.columns as unknown as T, ...(r.rows as unknown as T[])] : (r.rows as unknown as T[]);
  }
}

/**
 * D1Database over the object. `stub` is the stub itself or a function making one: a fresh stub per call keeps
 * nothing that belongs to an earlier request alive on an env object that outlives it.
 */
export function d1OverDurable(stub: DatabaseStub | (() => DatabaseStub)): D1Database {
  const get = typeof stub === "function" ? stub : () => stub;
  const api = {
    prepare: (sql: string) => new DurableStatement(get, sql),
    batch: async (statements: DurableStatement[]) => (statements.length ? get().batch(statements.map((s) => s.input())) : []),
    exec: (sql: string) => get().exec(sql),
    dump: async () => { throw new Error("dump is not supported"); },
    withSession: () => { throw new Error("sessions are not supported"); },
  };
  return api as unknown as D1Database;
}

/**
 * The seam. Every entry point (a request, a cron tick, a queue batch, a Workflow step) calls this on its bindings
 * before anything reads `env.DB`: with no D1 bound and the object's namespace present, `env.DB` becomes the
 * object behind the D1 interface, and nothing downstream knows. A D1 binding is left alone. Returns whether it rebound.
 */
export function bindDatabase(env: Bindings): boolean {
  const ns = env.DB_OBJECT;
  if (env.DB || !ns) return false;
  const id = ns.idFromName(DB_OBJECT_NAME);
  env.DB = d1OverDurable(() => ns.get(id) as unknown as DatabaseStub);
  return true;
}
