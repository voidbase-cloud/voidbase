// $app.runInTransaction: the buffered transaction (src/server/tx-d1.ts) over the D1 shim on bun:sqlite
// (src/node/d1.ts), and the hook global over both databases: a real transaction on the database Durable Object,
// exactly what it did before on D1. The transaction on workerd is proven end to end by test/workers-durable.ts.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { d1 } from "../../src/node/d1";
import { d1OverDurable, type DatabaseStub, type DurableQueryResult, type DurableStatementInput } from "../../src/server/durable-d1";
import { $app, hookStore, type HookStore } from "../../src/server/hooks/runtime";
import type { RecordContext } from "../../src/server/records/service";
import type { Settings } from "../../src/server/settings";
import { bufferedTransaction, isTransaction, writtenRow } from "../../src/server/tx-d1";

function memory(): D1Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT UNIQUE, n INTEGER); CREATE TABLE other (id TEXT PRIMARY KEY, v TEXT)");
  return d1(db);
}
const rows = async (db: D1Database, sql = "SELECT v FROM t ORDER BY id") => (await db.prepare(sql).all<{ v: string }>()).results.map((r) => r.v);

describe("the buffered transaction over the D1 shim", () => {
  test("nothing is written until commit, and then all of it is, in order", async () => {
    const db = memory();
    const tx = bufferedTransaction(db);
    await tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one").run();
    await tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("b", "two").run();
    expect(tx.writes().map((w) => w.params[0])).toEqual(["a", "b"]);
    expect(await rows(db)).toEqual([]); // still nothing on disk
    await tx.commit();
    expect(await rows(db)).toEqual(["one", "two"]);
    expect(tx.writes()).toEqual([]); // the buffer is spent
  });
  test("a write inside the transaction answers with D1's shape and no changes it cannot know yet", async () => {
    const tx = bufferedTransaction(memory());
    const r = await tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one").run();
    expect(r.success).toBe(true);
    expect(r.results).toEqual([]);
    expect(r.meta.changes).toBe(0);
  });
  test("a failing statement rolls the whole batch back: the commit throws and nothing lands", async () => {
    const db = memory();
    const tx = bufferedTransaction(db);
    await tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "same").run();
    await tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("b", "same").run(); // v is UNIQUE
    await expect(tx.commit()).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await rows(db)).toEqual([]);
  });
  test("a callback that throws never commits, so nothing it wrote is anywhere", async () => {
    const db = memory();
    const tx = bufferedTransaction(db);
    await tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one").run();
    expect(await rows(db)).toEqual([]); // the caller discards the buffer instead of committing it
  });
  test("db.batch inside the transaction joins the same buffer rather than committing on its own", async () => {
    const db = memory();
    const tx = bufferedTransaction(db);
    const out = await tx.db.batch([tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one"), tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("b", "two")]);
    expect(out).toHaveLength(2);
    expect(await rows(db)).toEqual([]);
    expect(tx.writes()).toHaveLength(2);
    await tx.commit();
    expect(await rows(db)).toEqual(["one", "two"]);
  });

  test("reads go to the committed database: all, first and raw answer as they always did", async () => {
    const db = memory();
    await db.prepare("INSERT INTO t (id, v, n) VALUES (?, ?, ?)").bind("a", "one", 1).run();
    const tx = bufferedTransaction(db);
    expect((await tx.db.prepare("SELECT v FROM t").all<{ v: string }>()).results).toEqual([{ v: "one" }]);
    expect(await tx.db.prepare("SELECT v FROM t WHERE id = ?").bind("a").first("v")).toBe("one");
    expect(await tx.db.prepare("SELECT v, n FROM t").raw()).toEqual([["one", 1]]);
    expect(await tx.db.prepare("SELECT v FROM t").raw({ columnNames: true })).toEqual([["v"], ["one"]]);
  });
  test("a read of a table the transaction has written to throws instead of answering without the write", async () => {
    const db = memory();
    await db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one").run();
    const tx = bufferedTransaction(db);
    await tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("b", "two").run();
    await expect(tx.db.prepare("SELECT v FROM t").all()).rejects.toThrow(/has written to `t` and has not committed/);
    await expect(tx.db.prepare("SELECT v FROM t WHERE id = ?").bind("a").first()).rejects.toThrow(/cannot read `t` back/);
    await expect(tx.db.prepare("SELECT v FROM t").raw()).rejects.toThrow(/runInTransaction/);
    expect(await tx.db.prepare("SELECT v FROM other").all()).toBeDefined(); // a table it has not touched is fine
  });
  test("RETURNING and exec are refused, and so are dump and sessions", async () => {
    const tx = bufferedTransaction(memory());
    await expect(tx.db.prepare("INSERT INTO t (id, v) VALUES (?, ?) RETURNING id").bind("a", "one").run()).rejects.toThrow(/RETURNING/);
    await expect(tx.db.exec("CREATE TABLE x (y)")).rejects.toThrow(/exec\(\) is not available inside a transaction/);
    await expect(tx.db.dump()).rejects.toThrow(/not supported/);
    expect(() => tx.db.withSession()).toThrow(/not supported/);
  });

  test("writtenRow: the row an insert wrote, an update merged into it, gone after a delete, null off a transaction", async () => {
    const db = memory();
    const tx = bufferedTransaction(db);
    expect(writtenRow(db, "t", "a")).toBeNull(); // the database itself remembers nothing
    expect(isTransaction(db)).toBe(false);
    expect(isTransaction(tx.db)).toBe(true);
    await tx.db.prepare("INSERT INTO t (`id`, `v`, `n`) VALUES (?, ?, ?)").bind("a", "one", 1).run();
    expect(writtenRow(tx.db, "t", "a")).toEqual({ id: "a", v: "one", n: 1 });
    expect(writtenRow(tx.db, "t", "b")).toBeNull();
    await tx.db.prepare("UPDATE t SET `v` = ?, `n` = ? WHERE id = ?").bind("two", 2, "a").run();
    expect(writtenRow(tx.db, "t", "a")).toEqual({ id: "a", v: "two", n: 2 });
    await tx.db.prepare("DELETE FROM t WHERE id = ?").bind("a").run();
    expect(writtenRow(tx.db, "t", "a")).toBeNull();
  });
});

// ---- the hook global -------------------------------------------------------------------------------
const idleRealtime = { active: () => false, publish: async () => {}, presence: async () => null, publishToClient: async () => false, controlClient: async () => {}, openSocket: async () => ({}) as unknown as WebSocket };
const storeFor = (db: D1Database): HookStore => ({
  c: null,
  ctx: async () => ({ db, storage: undefined, auth: null, superuser: true, request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" }, collections: new Map(), realtime: idleRealtime }) as unknown as RecordContext,
  collections: new Map(),
  settings: {} as Settings,
  env: { DB: db },
});
function durableDb() {
  const calls: { method: string; args: unknown[] }[] = [];
  const result = (): DurableQueryResult => ({ results: [], success: true, meta: { changes: 1, last_row_id: 1, duration: 0, rows_read: 0, rows_written: 1 } });
  const stub: DatabaseStub = {
    async query(sql, params) { calls.push({ method: "query", args: [sql, params] }); return result(); },
    async raw() { return { columns: [], rows: [] }; },
    async exec() { return { count: 0, duration: 0 }; },
    async batch(statements: DurableStatementInput[]) { calls.push({ method: "batch", args: [statements] }); return statements.map(result); },
  };
  return { db: d1OverDurable(stub), calls };
}

describe("$app.runInTransaction", () => {
  test("on D1 it is what it always was: the callback runs directly, with no transaction to be had", async () => {
    const db = memory();
    await hookStore.run(storeFor(db), async () => {
      expect($app.transactionsAreReal()).toBe(false);
      const out = await $app.runInTransaction(async (txApp) => {
        expect(txApp).toBe($app);
        await db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one").run();
        expect(await rows(db)).toEqual(["one"]); // written straight away, as before
        return 42;
      });
      expect(out).toBe(42);
      expect(await rows(db)).toEqual(["one"]);
    });
  });
  test("on D1 a throw is rethrown and nothing is rolled back, which is the difference the docs name", async () => {
    const db = memory();
    await hookStore.run(storeFor(db), async () => {
      await expect($app.runInTransaction(async () => {
        await db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one").run();
        throw new Error("boom");
      })).rejects.toThrow("boom");
      expect(await rows(db)).toEqual(["one"]); // the write stayed: D1 has no transaction to undo it
    });
  });

  test("on the database Durable Object the writes are held and sent as one batch when the callback returns", async () => {
    const { db, calls } = durableDb();
    await hookStore.run(storeFor(db), async () => {
      expect($app.transactionsAreReal()).toBe(true);
      const out = await $app.runInTransaction(async () => {
        const s = hookStore.getStore()!;
        const tx = (await s.ctx()).db;
        await tx.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one").run();
        await tx.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("b", "two").run();
        expect(calls).toEqual([]); // nothing has reached the object yet
        return "done";
      });
      expect(out).toBe("done");
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("batch");
    expect(calls[0]!.args[0]).toEqual([{ sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", "one"] }, { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["b", "two"] }]);
  });
  test("a throw rolls everything back by never sending it, and is rethrown", async () => {
    const { db, calls } = durableDb();
    await hookStore.run(storeFor(db), async () => {
      await expect($app.runInTransaction(async () => {
        const tx = (await hookStore.getStore()!.ctx()).db;
        await tx.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind("a", "one").run();
        throw new Error("second write refused");
      })).rejects.toThrow("second write refused");
    });
    expect(calls).toEqual([]);
  });
  test("the database is put back when the transaction ends, whether it committed or threw", async () => {
    const { db, calls } = durableDb();
    await hookStore.run(storeFor(db), async () => {
      const before = (await hookStore.getStore()!.ctx()).db;
      await $app.runInTransaction(async () => { expect((await hookStore.getStore()!.ctx()).db).not.toBe(before); });
      expect((await hookStore.getStore()!.ctx()).db).toBe(before);
      await expect($app.runInTransaction(async () => { throw new Error("x"); })).rejects.toThrow("x");
      expect((await hookStore.getStore()!.ctx()).db).toBe(before);
    });
    expect(calls).toEqual([]);
  });
  test("transactions do not nest: the inner call is refused with a message that says so", async () => {
    const { db } = durableDb();
    await hookStore.run(storeFor(db), async () => {
      await expect($app.runInTransaction(async () => {
        await $app.runInTransaction(async () => undefined);
      })).rejects.toThrow(/a transaction is already open. Transactions do not nest/);
    });
  });
});
