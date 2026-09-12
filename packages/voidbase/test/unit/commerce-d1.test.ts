// Commerce's writes over the real D1 adapter: `d1Rows` over the records service, on bun:sqlite behind src/node/d1 with
// the migrations and the system collections, the real stripe plugin over a fake fetch, and the shipped flat-rate tax
// and shipping. test/unit/commerce.test.ts measures the shop over rows in memory; what is measured here depends on the
// records service itself: that a claim on an order is the service's own update, so the hooks on orders see the move and
// can refuse it, and that a step and the stock it moves land together or not at all.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { d1 } from "../../src/node/d1";
import { provideAuthLookup } from "../../src/server/auth-slot";
import { insertCollection } from "../../src/server/bootstrap";
import { invalidateCollections } from "../../src/server/collections/model";
import { createCollection } from "../../src/server/collections/service";
import { systemCollections } from "../../src/server/collections/system";
import { ApiError } from "../../src/server/errors";
import { eventHooks, onEvent } from "../../src/server/hooks/runtime";
import type { Auth } from "../../src/server/interfaces";
import { createKernel, load, runBootstraps } from "../../src/server/kernel";
import { API, commerceWith, d1Rows } from "../../src/server/plugins/commerce";
import { shippingFlat } from "../../src/server/plugins/shipping-flat";
import { KEY_VAR, signPayload, stripeWith, WEBHOOK_SECRET_VAR } from "../../src/server/plugins/stripe";
import { taxFlat } from "../../src/server/plugins/tax-flat";
import { ensureSettingsRow, invalidateSettings } from "../../src/server/settings";
import type { AppEnv, AuthRecord, Bindings, Row } from "../../src/server/types";

const ROOT = resolve(import.meta.dir, "../..");
const SECRET = "sk_test_abc", WHSEC = "whsec_test_123";
const T = Math.floor(Date.now() / 1000);
const HOOKS = ["onRecordUpdate", "onRecordAfterUpdateSuccess", "onRecordAfterUpdateError", "onModelAfterUpdateError"];
type HookEvent = { record: { get(name: string): unknown; original(): { get(name: string): unknown } }; next: () => Promise<unknown> };

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const h of HOOKS) eventHooks.delete(h);
  provideAuthLookup(() => undefined);
  invalidateCollections();
});

/** an instance on bun:sqlite with a users collection, Ada in it, and the shop on Stripe answering over a fake fetch */
async function instance() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(`${ROOT}/db/migrations`).filter((x) => x.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${ROOT}/db/migrations/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.exec(s);
  }
  const db = d1(sqlite);
  invalidateCollections(); invalidateSettings();
  for (const c of systemCollections()) await insertCollection(db, c);
  await ensureSettingsRow(db);
  const users = await createCollection(db, { name: "users", type: "auth", fields: [{ name: "name", type: "text" }] });
  sqlite.run("INSERT INTO users (id, password, tokenKey, email, name) VALUES ('uaaaaaaaaaaaaa1', 'hash', 'tk', 'ada@b.test', 'Ada')");

  const app = new Hono<AppEnv>();
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
  let auth: AuthRecord | null = null;
  app.use("*", async (c, next) => { c.set("auth", auth); await next(); });
  const kernel = createKernel(app);
  const answers: Record<string, Row> = { "POST /v1/customers": { id: "cus_1" }, "POST /v1/checkout/sessions": { url: "https://checkout.test/x" } };
  const fetchFake = async (url: string, init?: RequestInit): Promise<Response> => {
    const a = answers[`${init?.method ?? "GET"} ${new URL(url).pathname}`];
    return a ? new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 500 });
  };
  let numbers = 0;
  const commerce = commerceWith({ now: () => T * 1000, token: () => "tok_1", number: () => `VB-${++numbers}` });
  stops.push(() => commerce.stopWatchingPayments());
  await load(kernel, [stripeWith({ fetch: fetchFake, now: () => T }), taxFlat, shippingFlat, commerce], "0.9.0");
  provideAuthLookup(() => ({ isSuperuser: () => false }) as unknown as Auth);
  const env = { DB: db, STORAGE: {} as R2Bucket, [KEY_VAR]: SECRET, [WEBHOOK_SECRET_VAR]: WHSEC, VOIDBASE_COMMERCE: "1" } as unknown as Bindings;
  await runBootstraps(kernel, env);
  invalidateCollections();
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.request(`http://shop.test${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }, env);
    return { status: r.status, json: (await r.json()) as Row };
  };
  let evt = 0;
  const webhook = async (type: string, object: Row) => {
    const payload = JSON.stringify({ id: `evt_${++evt}`, object: "event", type, data: { object } });
    return call("POST", "/api/payments/stripe/webhook", payload, { "stripe-signature": `t=${T},v1=${await signPayload(WHSEC, payload, T)}` });
  };
  const q = (sql: string, ...params: unknown[]) => sqlite.query(sql).all(...(params as never[])) as Row[];
  /** the order's audit trail, the actions in the order they were written */
  const actions = (order: string) => q("SELECT action FROM commerce_audit WHERE subject = ? ORDER BY rowid", `order:${order}`).map((r) => String(r.action));
  return { sqlite, env, call, webhook, q, actions, users, as: (who: AuthRecord | null) => { auth = who; } };
}
type Instance = Awaited<ReturnType<typeof instance>>;

/** two kettles of 2500 checked out by Ada, three on hand: the order pending, two reserved */
async function orderPlaced(i: Instance) {
  const rows = d1Rows(i.env);
  const product = await rows.create("products", { title: "Kettle", slug: "kettle", active: true });
  const variant = await rows.create("variants", { product: String(product.id), sku: "KET-1", title: "Kettle", price: 2500, currency: "usd", priceId: "price_black", active: true });
  await rows.create("inventory", { variant: String(variant.id), onHand: 3, reserved: 0 });
  i.as({ collection: i.users, row: { id: "uaaaaaaaaaaaaa1", email: "ada@b.test" } } as AuthRecord);
  expect((await i.call("POST", `${API}/cart/items`, { variant: String(variant.id), quantity: 2 })).status).toBe(200);
  expect((await i.call("POST", `${API}/cart/address`, { address: { line1: "1 High St", city: "Cambridge", postcode: "CB1", country: "gb" } })).status).toBe(200);
  const out = await i.call("POST", `${API}/checkout`, { success: "https://a", cancel: "https://b" });
  expect(out.status).toBe(200);
  expect(out.json.order).toMatchObject({ status: "pending", total: 5000 });
  return { id: String((out.json.order as Row).id), variant: String(variant.id) };
}

const intentFor = (order: string) => ({ id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 5000, currency: "usd", metadata: { voidbase_order: order } });

describe("a claim on an order is the records service's own update", () => {
  test("an onRecordUpdate hook on orders sees the order go from pending to paid, and a second claim from pending writes nothing and runs no hook", async () => {
    const i = await instance();
    const { id } = await orderPlaced(i);
    const seen: string[][] = [], after: string[] = [];
    onEvent("onRecordUpdate", async (e: unknown) => { const ev = e as HookEvent; seen.push([String(ev.record.original().get("status")), String(ev.record.get("status"))]); return ev.next(); }, ["orders"]);
    onEvent("onRecordAfterUpdateSuccess", async (e: unknown) => { const ev = e as HookEvent; after.push(String(ev.record.get("status"))); return ev.next(); }, ["orders"]);
    expect((await i.webhook("payment_intent.succeeded", intentFor(id))).status).toBe(200);
    expect(i.q("SELECT status FROM orders WHERE id = ?", id)[0]).toMatchObject({ status: "paid" });
    expect(seen).toEqual([["pending", "paid"]]);
    expect(after).toEqual(["paid"]);
    expect(i.actions(id)).toEqual(["order.placed", "order.paid"]);
    // the same claim again from pending, and one to another status: the order is paid, so neither writes or runs a hook
    const rows = d1Rows(i.env);
    expect(await rows.updateWhere("orders", id, { status: "pending" }, { status: "paid" })).toBe(false);
    expect(await rows.updateWhere("orders", id, { status: "pending" }, { status: "cancelled" })).toBe(false);
    expect(i.q("SELECT status FROM orders WHERE id = ?", id)[0]).toMatchObject({ status: "paid" });
    expect(seen).toHaveLength(1);
    expect(after).toHaveLength(1);
  });

  test("a claim that finds the order moved between its read and its write changes nothing: updateWhere says false, and no after-success hook or realtime row follows", async () => {
    const i = await instance();
    const { id } = await orderPlaced(i);
    // a client is connected, so a write announces itself in _changes
    i.sqlite.run("INSERT INTO _realtime_clients (id) VALUES ('client00000001')");
    const announced = () => i.q("SELECT action FROM _changes WHERE collection = 'orders' AND recordId = ?", id).length;
    const after: string[] = [];
    let meddle = true;
    onEvent("onRecordUpdate", async (e: unknown) => {
      // another request cancels the order while this claim's hooks run: after the claim read it, before its UPDATE
      if (meddle) { meddle = false; i.sqlite.query("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id); }
      return (e as HookEvent).next();
    }, ["orders"]);
    onEvent("onRecordAfterUpdateSuccess", async (e: unknown) => { after.push(String((e as HookEvent).record.get("status"))); return (e as HookEvent).next(); }, ["orders"]);
    const rows = d1Rows(i.env), before = announced();
    expect(await rows.updateWhere("orders", id, { status: "pending" }, { status: "paid" })).toBe(false);
    expect(i.q("SELECT status FROM orders WHERE id = ?", id)[0]).toMatchObject({ status: "cancelled" });
    expect(after).toEqual([]);
    expect(announced()).toBe(before);
    // a claim whose precondition holds writes, runs the hook, and is announced once
    expect(await rows.updateWhere("orders", id, { status: "cancelled" }, { status: "paid" })).toBe(true);
    expect(i.q("SELECT status FROM orders WHERE id = ?", id)[0]).toMatchObject({ status: "paid" });
    expect(after).toEqual(["paid"]);
    expect(announced()).toBe(before + 1);
  });

  test("a hook on orders that refuses the move to paid leaves the order pending with no audit row; the provider's retry moves nothing while it refuses, and pays the order once when it stops", async () => {
    const i = await instance();
    const { id, variant } = await orderPlaced(i);
    let refuse = true;
    onEvent("onRecordUpdate", async (e: unknown) => {
      const ev = e as HookEvent;
      if (refuse && ev.record.get("status") === "paid") throw new ApiError(400, "a hook refuses this order being paid");
      return ev.next();
    }, ["orders"]);
    const first = await i.webhook("payment_intent.succeeded", intentFor(id));
    expect(first.status).toBe(400);
    expect(String(first.json.message)).toBe("A hook refuses this order being paid.");
    expect(i.q("SELECT status, payment FROM orders WHERE id = ?", id)[0]).toEqual({ status: "pending", payment: "" });
    expect(i.actions(id)).toEqual(["order.placed"]);
    // Stripe retries while the hook still refuses: still pending, and no order.paid row for a move that never happened
    expect((await i.webhook("payment_intent.succeeded", intentFor(id))).status).toBe(400);
    expect(i.q("SELECT status, payment FROM orders WHERE id = ?", id)[0]).toEqual({ status: "pending", payment: "" });
    expect(i.actions(id)).toEqual(["order.placed"]);
    // the hook lets it through, and the next retry pays it, once however often it is told
    refuse = false;
    expect((await i.webhook("payment_intent.succeeded", intentFor(id))).status).toBe(200);
    expect((await i.webhook("payment_intent.succeeded", intentFor(id))).status).toBe(200);
    expect(i.q("SELECT status FROM orders WHERE id = ?", id)[0]).toMatchObject({ status: "paid" });
    expect(i.actions(id)).toEqual(["order.placed", "order.paid"]);
    expect(i.q("SELECT reserved FROM inventory WHERE variant = ?", variant)[0]).toMatchObject({ reserved: 2 });
  });

  test("a claim that loses runs no hook after it at all, neither after-success nor after-error, whether the row fails the precondition as it was read or at the UPDATE", async () => {
    const i = await instance();
    const { id } = await orderPlaced(i);
    // an update that deliberately writes nothing has not failed, and Stripe tells of one payment twice, so the losing
    // twin ran the after-error hooks on every delivery until the error was raised outside the hook chain
    const fired: string[] = [];
    for (const name of ["onRecordAfterUpdateError", "onModelAfterUpdateError", "onRecordAfterUpdateSuccess"]) {
      onEvent(name, async (e: unknown) => { fired.push(name); return (e as HookEvent).next(); }, ["orders"]);
    }
    const rows = d1Rows(i.env);
    // the row as read already fails the precondition
    expect(await rows.updateWhere("orders", id, { status: "paid" }, { status: "fulfilled" })).toBe(false);
    expect(fired).toEqual([]);
    // and one whose precondition holds when the row is read and fails at the UPDATE, because another request moved it
    let meddle = true;
    onEvent("onRecordUpdate", async (e: unknown) => {
      if (meddle) { meddle = false; i.sqlite.query("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id); }
      return (e as HookEvent).next();
    }, ["orders"]);
    expect(await rows.updateWhere("orders", id, { status: "pending" }, { status: "paid" })).toBe(false);
    expect(fired).toEqual([]);
    expect(i.q("SELECT status FROM orders WHERE id = ?", id)[0]).toMatchObject({ status: "cancelled" });
    // a claim that holds writes and runs the after-success hook, once
    expect(await rows.updateWhere("orders", id, { status: "cancelled" }, { status: "paid" })).toBe(true);
    expect(fired).toEqual(["onRecordAfterUpdateSuccess"]);
  });
});

describe("a step and the stock it moves", () => {
  test("createOnce writes the row and its updates as one batch, writes nothing when the row is there, and takes the updates back when another request wrote the row meanwhile", async () => {
    const i = await instance();
    const { id, variant } = await orderPlaced(i);
    const inv = String(i.q("SELECT id FROM inventory WHERE variant = ?", variant)[0]!.id);
    const reserved = () => Number(i.q("SELECT reserved FROM inventory WHERE id = ?", inv)[0]!.reserved);
    const rows = d1Rows(i.env);
    const step = (step: string, to: number) => rows.createOnce("commerce_audit", { id: step, actor: "test", action: "stock.released", subject: `order:${id}`, detail: { line: "l1" } }, [{ collection: "inventory", id: inv, values: { reserved: to } }]);
    expect(reserved()).toBe(2);
    expect(await step("stepaaaaaaaaaa1", 0)).toBe(true);
    expect(reserved()).toBe(0);
    expect(i.q("SELECT actor FROM commerce_audit WHERE id = 'stepaaaaaaaaaa1'")).toEqual([{ actor: "test" }]);
    // the same step again: its row is there, so nothing is written
    expect(await step("stepaaaaaaaaaa1", 7)).toBe(false);
    expect(reserved()).toBe(0);
    // another request writes the step's row while this one's update is being issued: the batch fails on the row's
    // primary key, and the inventory update goes back with it
    let meddle = true;
    onEvent("onRecordUpdate", async (e: unknown) => {
      if (meddle) { meddle = false; i.sqlite.query("INSERT INTO commerce_audit (id, at, actor, action, subject, detail, created, updated) VALUES ('stepbbbbbbbbbb2', '', 'another', 'stock.released', ?, '{}', '', '')").run(`order:${id}`); }
      return (e as HookEvent).next();
    }, ["inventory"]);
    expect(await step("stepbbbbbbbbbb2", 9)).toBe(false);
    expect(reserved()).toBe(0);
    expect(i.q("SELECT actor FROM commerce_audit WHERE id = 'stepbbbbbbbbbb2'")).toEqual([{ actor: "another" }]);
  });
});
