// The D1 interface over the database Durable Object (src/server/durable-d1.ts) against a recording stub, the seam
// that rebinds DB, the deploy knob's parsing, the generated system schema, and the project a durable deploy writes.
// The object itself (src/server/durable-db.ts) imports cloudflare:workers and is proven on workerd by test/workers-durable.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bindDatabase, d1OverDurable, databaseKind, DATABASE_VAR, DB_OBJECT_NAME, type DatabaseStub, type DurableQueryResult } from "../../src/server/durable-d1";
import { SYSTEM_MIGRATIONS } from "../../src/server/schema-sql";
import { schemaSqlSource, SCHEMA_SQL_FILE } from "../../scripts/schema-sql";
import { pbHooksPlugin } from "../../hooks-plugin";
import { writeCloudProject } from "../../src/node/cloud-init";
import type { Bindings } from "../../src/server/types";

const ROOT = resolve(import.meta.dir, "../..");
const result = (results: Record<string, unknown>[] = [], changes = 0): DurableQueryResult => ({ results, success: true, meta: { changes, last_row_id: 7, duration: 0, rows_read: results.length, rows_written: changes } });
function recordingStub(rows: Record<string, unknown>[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const stub: DatabaseStub = {
    async query(sql, params) { calls.push({ method: "query", args: [sql, params] }); return result(rows, 1); },
    async raw(sql, params) { calls.push({ method: "raw", args: [sql, params] }); return { columns: ["id", "id"], rows: [[1, 2]] }; },
    async exec(sql) { calls.push({ method: "exec", args: [sql] }); return { count: 2, duration: 0 }; },
    async batch(statements) { calls.push({ method: "batch", args: [statements] }); if (statements.some((s) => /boom/.test(s.sql))) throw new Error("UNIQUE constraint failed: t.v: SQLITE_CONSTRAINT"); return statements.map(() => result([], 1)); },
  };
  return { stub, calls };
}

describe("d1OverDurable", () => {
  test("one RPC per statement, the bound values as db.ts leaves them, results shaped like D1's", async () => {
    const { stub, calls } = recordingStub([{ x: 1 }, { x: 2 }]);
    const db = d1OverDurable(stub);
    const r = await db.prepare("SELECT ? AS x").bind(1, undefined, 0, "s").all<{ x: number }>();
    expect(calls).toEqual([{ method: "query", args: ["SELECT ? AS x", [1, null, 0, "s"]] }]);
    expect(r.results).toEqual([{ x: 1 }, { x: 2 }]); expect(r.success).toBe(true); expect(r.meta.changes).toBe(1); expect(r.meta.last_row_id).toBe(7);
    await db.prepare("DELETE FROM t").run();
    expect(calls[1]).toEqual({ method: "query", args: ["DELETE FROM t", []] });
  });
  test("first: the row, its column, or null when there is none", async () => {
    const some = d1OverDurable(recordingStub([{ x: 1, y: "a" }]).stub);
    expect(await some.prepare("q").first()).toEqual({ x: 1, y: "a" });
    expect(await some.prepare("q").first("y")).toBe("a");
    const none = d1OverDurable(recordingStub([]).stub);
    expect(await none.prepare("q").first()).toBeNull();
    expect(await none.prepare("q").first("y")).toBeNull();
  });
  test("raw: arrays, the column names first when asked, repeated names kept", async () => {
    const { stub, calls } = recordingStub();
    const db = d1OverDurable(stub);
    expect(await db.prepare("SELECT a.id, b.id FROM a, b").raw()).toEqual([[1, 2]]);
    expect(await db.prepare("SELECT a.id, b.id FROM a, b").raw({ columnNames: true })).toEqual([["id", "id"], [1, 2]]);
    expect(calls.every((c) => c.method === "raw")).toBe(true);
  });
  test("batch: one RPC carrying every statement, nothing for an empty one, the object's error as thrown", async () => {
    const { stub, calls } = recordingStub();
    const db = d1OverDurable(stub);
    const out = await db.batch([db.prepare("INSERT INTO t (v) VALUES (?)").bind("a"), db.prepare("INSERT INTO t (v) VALUES (?)").bind("b")]);
    expect(out).toHaveLength(2);
    expect(calls).toEqual([{ method: "batch", args: [[{ sql: "INSERT INTO t (v) VALUES (?)", params: ["a"] }, { sql: "INSERT INTO t (v) VALUES (?)", params: ["b"] }]] }]);
    expect(await db.batch([])).toEqual([]); expect(calls).toHaveLength(1);
    await expect(db.batch([db.prepare("INSERT INTO t (v) VALUES ('ok')"), db.prepare("boom")])).rejects.toThrow(/UNIQUE constraint failed: t\.v/);
  });
  test("exec goes through, dump and sessions are refused", async () => {
    const { stub, calls } = recordingStub();
    const db = d1OverDurable(stub);
    expect(await db.exec("CREATE TABLE a (x); CREATE TABLE b (y)")).toEqual({ count: 2, duration: 0 });
    expect(calls[0]!.method).toBe("exec");
    await expect(db.dump()).rejects.toThrow(/not supported/);
    expect(() => db.withSession()).toThrow(/not supported/);
  });
  test("a stub factory is asked for a fresh stub on every call", async () => {
    let made = 0; const { stub } = recordingStub();
    const db = d1OverDurable(() => { made++; return stub; });
    await db.prepare("a").all(); await db.prepare("b").run(); await db.batch([db.prepare("c")]);
    expect(made).toBe(3);
  });
});

describe("bindDatabase (the seam)", () => {
  const namespace = (stub: DatabaseStub, ids: string[] = []) => ({ idFromName: (n: string) => { ids.push(n); return { name: n }; }, get: () => stub }) as unknown as DurableObjectNamespace;
  test("no D1 and the namespace present: DB becomes the object behind the D1 interface, once", async () => {
    const { stub, calls } = recordingStub([{ n: 1 }]); const ids: string[] = [];
    const env = { DB_OBJECT: namespace(stub, ids) } as unknown as Bindings;
    expect(bindDatabase(env)).toBe(true);
    expect(ids).toEqual([DB_OBJECT_NAME]);
    expect((await env.DB.prepare("SELECT 1 AS n").first<{ n: number }>())?.n).toBe(1);
    expect(calls).toHaveLength(1);
    expect(bindDatabase(env)).toBe(false); // already bound: the same DB stays
  });
  test("a D1 binding is left alone, and nothing happens without the namespace", () => {
    const d1 = { prepare: () => null } as unknown as D1Database;
    const withD1 = { DB: d1, DB_OBJECT: namespace(recordingStub().stub) } as unknown as Bindings;
    expect(bindDatabase(withD1)).toBe(false); expect(withD1.DB).toBe(d1);
    const neither = {} as Bindings;
    expect(bindDatabase(neither)).toBe(false); expect(neither.DB).toBeUndefined();
  });
});

describe("the knob", () => {
  test("databaseKind: unset and d1 mean D1, durable in its spellings means the object, anything else is refused", () => {
    expect(databaseKind(undefined)).toBe("d1"); expect(databaseKind("")).toBe("d1"); expect(databaseKind(" D1 ")).toBe("d1");
    expect(databaseKind("durable")).toBe("durable"); expect(databaseKind("DO")).toBe("durable"); expect(databaseKind(" durable-object ")).toBe("durable");
    expect(() => databaseKind("postgres")).toThrow(new RegExp(`${DATABASE_VAR}=postgres`));
  });
});

describe("the generated system schema", () => {
  test("src/server/schema-sql.ts is what scripts/schema-sql.ts writes from db/migrations today", () => {
    expect(readFileSync(SCHEMA_SQL_FILE, "utf8")).toBe(schemaSqlSource());
  });
  test("one entry per migration file, in order, split into statements", () => {
    const files = readdirSync(resolve(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => f.replace(/\.sql$/, ""));
    expect(SYSTEM_MIGRATIONS.map((m) => m.name)).toEqual(files);
    const all = SYSTEM_MIGRATIONS.flatMap((m) => m.statements);
    expect(all.every((s) => s.trim().length > 0 && !s.includes("statement-breakpoint"))).toBe(true);
    for (const table of ["_collections", "_params", "_superusers", "_pbMigrations", "_changes", "_realtime_clients", "_logs"]) expect(all.some((s) => s.startsWith(`CREATE TABLE \`${table}\``))).toBe(true);
  });
});

describe("the Worker entry", () => {
  const transform = (opts: Parameters<typeof pbHooksPlugin>[0], id: string) => {
    const plugin = pbHooksPlugin(opts) as unknown as { transform(code: string, id: string): { code: string } | null };
    return plugin.transform("export default {};", id);
  };
  test("the database class is exported beside the hub when the project names its entry", () => {
    const out = transform({ hubEntry: "/x/hub.ts", databaseEntry: "/x/durable-db.ts" }, "/p/.void/entry.ts");
    expect(out?.code).toContain('export { VoidbaseHub } from "/x/hub.ts";');
    expect(out?.code).toContain('export { VoidbaseDatabase } from "/x/durable-db.ts";');
    expect(transform({ hubEntry: "/x/hub.ts" }, "/p/.void/entry.ts")?.code).not.toContain("VoidbaseDatabase");
    expect(transform({ databaseEntry: "@voidbase-cloud/voidbase/durable-db" }, "/p/.void/entry.ts")?.code).toContain('from "@voidbase-cloud/voidbase/durable-db"');
    expect(transform({ databaseEntry: "/x/durable-db.ts" }, "/p/routes/x.ts")).toBeNull();
  });
});

describe("the generated project", () => {
  let out = "";
  beforeEach(() => { out = join(mkdtempSync(join(tmpdir(), "vb-durable-project-")), "cloud"); });
  afterEach(() => rmSync(resolve(out, ".."), { recursive: true, force: true }));
  test("durable: the class in the entry, no D1 schema, Void told not to infer a D1; default: the D1 shape as before", () => {
    writeCloudProject(out, "internal", { database: "durable", hooksDir: join(out, "../pb_hooks") });
    expect(readFileSync(join(out, "vite.config.ts"), "utf8")).toContain("databaseEntry: \"../../src/server/durable-db\"");
    expect(existsSync(join(out, "db"))).toBe(false);
    expect((JSON.parse(readFileSync(join(out, "void.json"), "utf8")) as { inference: { bindings: { db: boolean } } }).inference.bindings.db).toBe(false);
    writeCloudProject(out, "internal", { hooksDir: join(out, "../pb_hooks") }); // regenerated without the knob
    expect(readFileSync(join(out, "vite.config.ts"), "utf8")).not.toContain("databaseEntry");
    expect(existsSync(join(out, "db/schema.ts"))).toBe(true); expect(readdirSync(join(out, "db/migrations")).length).toBeGreaterThan(0);
    expect((JSON.parse(readFileSync(join(out, "void.json"), "utf8")) as { inference: { bindings: { db: boolean } } }).inference.bindings.db).toBe(true);
    writeCloudProject(out, "package", { database: "durable", hooksDir: join(out, "../pb_hooks") }); // flipped again: the schema goes
    expect(existsSync(join(out, "db"))).toBe(false);
    expect(readFileSync(join(out, "vite.config.ts"), "utf8")).toContain("databaseEntry: \"@voidbase-cloud/voidbase/durable-db\"");
  });
});
