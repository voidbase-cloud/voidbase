// What the payment providers share: the family that makes stripe, polar and lemonsqueezy one provider of
// payments@1, which one answers with these bindings, what /api/plugins says with no key, one key and two keys, the
// 409 on a configured provider that is not the active one, and the collections created by their one owner.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Collection } from "../../src/server/collections/model";
import { invalidateCollections } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import type { Payments } from "../../src/server/interfaces";
import { createKernel, load, using } from "../../src/server/kernel";
import { KEY_VAR as LS_KEY, lemonsqueezyWith, STORE_VAR } from "../../src/server/plugins/lemonsqueezy";
import { collectionDefinitions, customerForUser, ensureCustomer, upsert, type PaymentCollection, type PaymentProvider, type PaymentRows } from "../../src/server/plugins/payments-shared";
import { KEY_VAR as POLAR_KEY, polarWith } from "../../src/server/plugins/polar";
import { KEY_VAR as STRIPE_KEY, stripeWith } from "../../src/server/plugins/stripe";
import type { AppEnv, AuthRecord, Bindings, Row } from "../../src/server/types";

function memoryRows(seed: Partial<Record<PaymentCollection, Row[]>> = {}) {
  const tables: Record<PaymentCollection, Row[]> = { customers: [...(seed.customers ?? [])], subscriptions: [...(seed.subscriptions ?? [])], payments: [...(seed.payments ?? [])] };
  let n = 0;
  const rows: PaymentRows = {
    async find(c, where) { return tables[c].find((r) => Object.entries(where).every(([k, v]) => String(r[k] ?? "") === v)) ?? null; },
    async create(c, values) { const row: Row = { id: `${c.slice(0, 3)}_${++n}`, ...values }; tables[c].push(row); return row; },
    async update(c, id, values) { const row = tables[c].find((r) => r.id === id); if (!row) throw new Error(`no ${c} ${id}`); Object.assign(row, values); return row; },
  };
  return { rows, tables };
}

const users = { name: "users", id: "_pb_users_auth_" } as unknown as Collection;
const ada: AuthRecord = { collection: users, row: { id: "u1", email: "ada@b.test" } };
const env = (keys: Partial<Record<string, string>> = {}): Bindings => ({ DB: {} as D1Database, STORAGE: {} as R2Bucket, [STORE_VAR]: "42", ...keys }) as unknown as Bindings;

/** the three shipped providers on one app, in shipped order, with a fetch that refuses everything */
async function family(rows?: PaymentRows) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
  app.use("*", async (c, next) => { c.set("auth", ada); await next(); });
  const kernel = createKernel(app);
  const deps = { fetch: async () => new Response("{}", { status: 500 }), rows: rows ? () => rows : undefined };
  const stripe = stripeWith(deps), polar = polarWith(deps), lemonsqueezy = lemonsqueezyWith(deps);
  const loaded = await load(kernel, [stripe, polar, lemonsqueezy], "0.9.0");
  const post = async (path: string, body: unknown, bindings: Bindings) => {
    const res = await app.request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, bindings);
    return { status: res.status, json: (await res.json()) as Row };
  };
  return { app, kernel, loaded, stripe, polar, lemonsqueezy, post, payments: using<Payments>(kernel, "payments@1") };
}

describe("the family: three shipped plugins, one provider of payments@1", () => {
  test("stripe provides payments@1 and owns the collections; polar and lemonsqueezy require it; the load order is the shipped order", async () => {
    const { loaded, stripe, polar, lemonsqueezy, kernel, payments } = await family();
    expect(loaded.names).toEqual(["stripe", "polar", "lemonsqueezy"]);
    expect(loaded.providers).toEqual({ "payments@1": "stripe" });
    expect(stripe.manifest.collections).toEqual(["customers", "subscriptions", "payments"]);
    expect(polar.manifest.collections).toBeUndefined();
    expect(lemonsqueezy.manifest.collections).toBeUndefined();
    expect(payments).toBe(stripe.payments);
    expect(kernel.bootstraps.map((b) => b.plugin)).toEqual(["stripe", "polar", "lemonsqueezy"]);
  });

  test("no keys: route(env) is null, so /api/plugins says via none; every interface call refuses naming all three knobs", async () => {
    const { payments } = await family();
    expect(payments.route(env())).toBeNull();
    await expect(payments.checkout(env(), { customer: "c1", items: [{ price: "p", quantity: 1 }], success: "https://a" })).rejects.toThrow(/STRIPE_SECRET_KEY, POLAR_ACCESS_TOKEN, LEMONSQUEEZY_API_KEY/);
    await expect(payments.portal(env(), { customer: "c1", return: "https://a" })).rejects.toThrow(/No payment provider is configured/);
  });

  test("one key: that provider answers, whichever it is, through the one payments@1", async () => {
    const { payments } = await family(memoryRows().rows);
    expect(payments.route(env({ [STRIPE_KEY]: "sk_live_1" }))).toEqual({ via: "stripe", webhook: "/api/payments/stripe/webhook", livemode: true });
    expect(payments.route(env({ [POLAR_KEY]: "polar_oat_1" }))).toEqual({ via: "polar", webhook: "/api/payments/polar/webhook", livemode: true });
    expect(payments.route(env({ [LS_KEY]: "ls_1" }))).toEqual({ via: "lemonsqueezy", webhook: "/api/payments/lemonsqueezy/webhook", livemode: true });
    // a call with polar's key alone reaches polar: its refusal, not stripe's
    await expect(payments.portal(env({ [POLAR_KEY]: "polar_oat_1" }), { customer: "nope", return: "https://a" })).rejects.toThrow(/no Polar customer "nope"/i);
  });

  test("two keys: the first in shipped order wins, /api/plugins says which and why, and the other's routes answer 409", async () => {
    const { payments, post } = await family(memoryRows().rows);
    const both = env({ [POLAR_KEY]: "polar_oat_1", [LS_KEY]: "ls_1" });
    const route = payments.route(both);
    expect(route).toMatchObject({ via: "polar", webhook: "/api/payments/polar/webhook", also: ["lemonsqueezy"] });
    expect(route?.reason).toContain("LEMONSQUEEZY_API_KEY is set too");
    expect(route?.reason).toContain("polar answers because it comes first in the shipped order");
    const three = env({ [STRIPE_KEY]: "sk_test_1", [POLAR_KEY]: "polar_oat_1", [LS_KEY]: "ls_1" });
    expect(payments.route(three)).toMatchObject({ via: "stripe", also: ["polar", "lemonsqueezy"] });
    expect(payments.route(three)?.reason).toContain("POLAR_ACCESS_TOKEN and LEMONSQUEEZY_API_KEY are set too");

    const refused = await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1" }], success: "https://a" }, both);
    expect(refused.status).toBe(409);
    expect(String(refused.json.message)).toContain("Lemon Squeezy is configured but not active");
    expect(String(refused.json.message)).toContain("POLAR_ACCESS_TOKEN is set too");
    expect((await post("/api/payments/lemonsqueezy/webhook", {}, both)).status).toBe(409);
    expect((await post("/api/payments/lemonsqueezy/cancel", { subscription: "s1" }, both)).status).toBe(409);
    // the winner's routes go on: polar's checkout reaches its (refusing) fetch, which is a 502, not a 409
    expect((await post("/api/payments/polar/checkout", { items: [{ price: "p" }], success: "https://a" }, both)).status).toBe(502);
    // and a provider with no key at all is 503, whoever else is configured
    expect((await post("/api/payments/stripe/checkout", { items: [{ price: "p" }], success: "https://a", cancel: "https://b" }, both)).status).toBe(503);
  });

  test("the interface's webhook goes to the provider the request path names, whatever key is active", async () => {
    const { payments } = await family(memoryRows().rows);
    const both = env({ [STRIPE_KEY]: "sk_test_1", [POLAR_KEY]: "polar_oat_1", POLAR_WEBHOOK_SECRET: "whsec_x" });
    await expect(payments.webhook(both, new Request("http://x/api/payments/polar/webhook", { method: "POST", body: "{}" }))).rejects.toThrow(/Polar webhook refused/);
    await expect(payments.webhook(both, new Request("http://x/api/payments/stripe/webhook", { method: "POST", body: "{}" }))).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/);
    await expect(payments.webhook(both, new Request("http://x/somewhere/else", { method: "POST", body: "{}" }))).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  test("the collections are created once, by their owner, on the first request that carries any provider's key", async () => {
    const { kernel } = await family();
    const untouched = new Proxy({}, { get() { throw new Error("the database was touched"); } }) as unknown as D1Database;
    for (const b of kernel.bootstraps) await b.run({ DB: untouched } as Bindings);
    // polar's bootstrap, with polar's key, creates the collections stripe owns: the definitions are asked for
    const asked: string[] = [];
    const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
    const db = { prepare: (sql: string) => { asked.push(sql); return stmt; } } as unknown as D1Database;
    try {
      await kernel.bootstraps[1]!.run({ DB: db, [POLAR_KEY]: "polar_oat_1" } as unknown as Bindings).catch(() => undefined);
    } finally { invalidateCollections(); }
    expect(asked.length).toBeGreaterThan(0);
  });
});

describe("the shared rows helpers", () => {
  test("ensureCustomer creates once per provider and id, fills in an email or user it lacked, and never overwrites one it has", async () => {
    const { rows, tables } = memoryRows();
    const a = await ensureCustomer(rows, "polar", "cus_1", {});
    const b = await ensureCustomer(rows, "polar", "cus_1", { email: "ada@b.test", user: "u1" });
    expect(a!.id).toBe(b!.id);
    expect(tables.customers).toEqual([{ id: a!.id as string, provider: "polar", providerId: "cus_1", email: "ada@b.test", user: "u1" }]);
    await ensureCustomer(rows, "polar", "cus_1", { email: "other@b.test", user: "u2" });
    expect(tables.customers[0]).toMatchObject({ email: "ada@b.test", user: "u1" });
    // the same id under another provider is another customer
    await ensureCustomer(rows, "stripe", "cus_1", {});
    expect(tables.customers).toHaveLength(2);
    expect(await ensureCustomer(rows, "stripe", "", {})).toBeNull();
  });

  test("upsert keys a subscriptions or payments row on the provider id", async () => {
    const { rows, tables } = memoryRows();
    const first = await upsert(rows, "payments", "order_1", { amount: 1, status: "pending" });
    const second = await upsert(rows, "payments", "order_1", { status: "succeeded" });
    expect(second.id).toBe(first.id);
    expect(tables.payments).toEqual([{ id: first.id as string, providerId: "order_1", amount: 1, status: "succeeded" }]);
  });

  test("customerForUser finds the user's row for that provider or asks the provider to create one", async () => {
    const created: string[] = [];
    const provider = { name: "fake", createCustomer: async (_env: Bindings, auth: AuthRecord) => { created.push(String(auth.row.id)); return { providerId: `f_${auth.row.id}`, email: String(auth.row.email) }; } } as unknown as PaymentProvider;
    const { rows, tables } = memoryRows({ customers: [{ id: "c0", user: "u1", provider: "stripe", providerId: "cus_1" }] });
    const row = await customerForUser(rows, provider, env(), ada);
    expect(row).toMatchObject({ user: "u1", provider: "fake", providerId: "f_u1", email: "ada@b.test" });
    expect(await customerForUser(rows, provider, env(), ada)).toBe(row);
    expect(created).toEqual(["u1"]);
    expect(tables.customers).toHaveLength(2);
  });

  test("the collections are the same three whoever the provider is: a text `provider` on customers says which", async () => {
    const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
    const db = { prepare: () => stmt } as unknown as D1Database;
    try {
      const defs = await collectionDefinitions(db);
      expect(defs.map((d) => d.name)).toEqual(["customers", "subscriptions", "payments"]);
      const customers = defs[0] as { fields: { name: string; type: string }[]; indexes: string[] };
      expect(customers.fields.find((f) => f.name === "provider")).toEqual({ name: "provider", type: "text", required: true });
      expect(customers.indexes[0]).toContain("(`provider`, `providerId`)");
    } finally { invalidateCollections(); }
  });
});
