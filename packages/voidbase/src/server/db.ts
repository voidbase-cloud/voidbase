import type { Row } from "./types";

// Quote an identifier for SQLite. Rejects backticks outright rather than escaping them.
export function ident(name: string): string {
  if (!/^\w+$/.test(name)) throw new Error(`invalid identifier: ${name}`);
  return "`" + name + "`";
}

// D1 binds: null, number, string, boolean(as 0/1), ArrayBuffer. Everything else is JSON text.
export function bindValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || typeof v === "number" || typeof v === "string" || v instanceof ArrayBuffer) return v;
  return JSON.stringify(v);
}

export function stmt(db: D1Database, sql: string, params: unknown[] = []): D1PreparedStatement {
  return db.prepare(sql).bind(...params.map(bindValue));
}

export async function all<T = Row>(db: D1Database, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await stmt(db, sql, params).all<T>();
  return r.results ?? [];
}

export async function one<T = Row>(db: D1Database, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await stmt(db, sql, params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, params: unknown[] = []): Promise<D1Result> {
  return stmt(db, sql, params).run();
}

export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  return db.batch(statements);
}
