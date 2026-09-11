// What the payment providers share: the family that makes stripe, polar and lemonsqueezy one provider of
// payments@1, which one answers with these bindings, what /api/plugins says with no key, one key and two keys, the
// 409 on a configured provider that is not the active one, and the collections created by their one owner.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Hono } from "hono";
import type { Collection } from "../../src/server/collections/model";
import { invalidateCollections } from "../../src/server/collections/model";
import { ApiError, badRequest } from "../../src/server/errors";
import type { Payments } from "../../src/server/interfaces";
import { createKernel, load, using } from "../../src/server/kernel";
import { applyEvent as applyLemonSqueezyEvent, KEY_VAR as LS_KEY, lemonsqueezyWith, STORE_VAR } from "../../src/server/plugins/lemonsqueezy";
import {
  chargedBeforeProviderTax, collectionDefinitions, customerForUser, ensureCustomer, paymentReference, paymentsPlugin, purchasedItems, upsert, type CheckoutInput, type PaymentCollection, type PaymentProvider, type PaymentRows,
} from "../../src/server/plugins/payments-shared";
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

  test("a provider's own checkout route makes its checkCheckout and its checkCharge, and payments@1 makes only checkCharge, so a plugin is never held to a route's rule", async () => {
    const made: string[] = [];
    const provider = {
      name: "fake", label: "Fake", keyVar: "FAKE_KEY", webhookSecretVar: "FAKE_WEBHOOK_SECRET", key: () => "fake_key", webhookSecret: () => "", livemode: () => false,
      createCustomer: async () => ({ providerId: "f_u1", email: "ada@b.test" }),
      // a rule of the route's about its body, and what the provider cannot charge
      checkCheckout: (o: CheckoutInput) => { made.push("checkCheckout"); if (!o.cancel) throw badRequest("the fake route wants cancel"); },
      checkCharge: (o: CheckoutInput) => { made.push("checkCharge"); if (o.items.length > 1) throw badRequest("the fake charges one item"); },
      checkout: async () => ({ url: "https://fake.test/co" }),
    } as unknown as PaymentProvider;
    const { rows, tables } = memoryRows();
    const app = new Hono<AppEnv>();
    app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
    app.use("*", async (c, next) => { c.set("auth", ada); await next(); });
    const kernel = createKernel(app);
    await load(kernel, [paymentsPlugin(provider, { fetch: async () => new Response("{}"), rows: () => rows, now: () => 0 }, { anchor: true })], "0.9.0");
    const route = async (body: Row) => (await app.request("http://x/api/payments/fake/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env())).status;
    expect(await route({ items: [{ price: "p" }], success: "https://a" })).toBe(400);
    expect(await route({ items: [{ price: "p" }, { price: "q" }], success: "https://a", cancel: "https://b" })).toBe(400);
    expect(await route({ items: [{ price: "p" }], success: "https://a", cancel: "https://b" })).toBe(200);
    expect(made).toEqual(["checkCheckout", "checkCheckout", "checkCharge", "checkCheckout", "checkCharge"]);
    made.length = 0;
    const payments = using<Payments>(kernel, "payments@1");
    const one = { customer: String(tables.customers[0]!.id), items: [{ price: "p", quantity: 1 }], success: "https://a" };
    expect(() => payments.checkCheckout!(env(), one)).not.toThrow();
    expect(await payments.checkout(env(), one)).toEqual({ url: "https://fake.test/co" });
    await expect(payments.checkout(env(), { ...one, items: [...one.items, { price: "q", quantity: 1 }] })).rejects.toMatchObject({ status: 400 });
    expect(made).toEqual(["checkCharge", "checkCharge", "checkCharge"]);
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

  test("paymentReference reads the order a checkout was started for off what each provider sent back, and nothing else", async () => {
    // Stripe: the session and its payment intent both carry it in their metadata
    expect(paymentReference({ object: "checkout.session", metadata: { voidbase_customer: "c1", voidbase_order: "ord_1" } })).toBe("ord_1");
    expect(paymentReference({ object: "payment_intent", metadata: { voidbase_order: "ord_2" } })).toBe("ord_2");
    // Polar: the checkout's metadata, which Polar copies onto the order
    expect(paymentReference({ id: "po_1", total_amount: 5900, metadata: { voidbase_order: "ord_3" } })).toBe("ord_3");
    // Lemon Squeezy: the webhook's custom data, which the payments row keeps beside the object
    const { rows, tables } = memoryRows();
    await applyLemonSqueezyEvent(rows, { meta: { event_name: "order_created", custom_data: { voidbase_user: "u1", voidbase_order: "ord_4" } }, data: { type: "orders", id: "9", attributes: { customer_id: 7, user_email: "ada@b.test", total: 5900, currency: "USD", status: "paid" } } });
    expect(paymentReference(tables.payments[0]!.raw)).toBe("ord_4");
    for (const none of [null, undefined, "ord_5", {}, { metadata: {} }, { metadata: { voidbase_order: "" } }, { meta: { custom_data: {} } }]) expect(paymentReference(none)).toBe("");
  });

  test("purchasedItems reads what a payment bought off what each provider sent back: the variant and its quantity at Lemon Squeezy, the product at Polar, and null at Stripe, which reports none", async () => {
    // Lemon Squeezy, through its own rows: the order's first_order_item, whose quantity its SDK types and whose docs
    // do not, so an item with no quantity says which variant was bought and not how many; an order with no item bought
    // nothing that can be read. A quantity that is not a whole number above zero is no quantity reported
    const { rows, tables } = memoryRows();
    const order = (id: string, item?: Row) => applyLemonSqueezyEvent(rows, { meta: { event_name: "order_created", custom_data: { voidbase_order: "ord_1" } }, data: { type: "orders", id, attributes: { customer_id: 7, user_email: "ada@b.test", total: 5900, currency: "USD", status: "paid", ...(item ? { first_order_item: item } : {}) } } });
    await order("1", { id: 11, order_id: 1, product_id: 5, variant_id: 123, price_id: 9, quantity: 2, product_name: "Kettle" });
    await order("2", { variant_id: 123 });
    await order("3");
    await order("4", { variant_id: 123, quantity: "2" });
    expect(tables.payments.map((p) => purchasedItems(p))).toEqual([[{ id: "123", quantity: 2 }], [{ id: "123" }], [], [{ id: "123" }]]);
    for (const item of tables.payments.map((p) => purchasedItems(p)?.[0])) expect(item?.quantity).not.toBeNaN();
    // Polar: the order's product, once; its items when product_id is null, which the schema allows; and no purchase at
    // all when neither names one, since a line item of the 2026-04 document carries a product_price_id and no product
    expect(purchasedItems({ raw: { id: "po_1", product_id: "prod_1", net_amount: 5900, total_amount: 5900, metadata: { voidbase_order: "ord_1" } } })).toEqual([{ id: "prod_1", quantity: 1 }]);
    expect(purchasedItems({ raw: { id: "po_2", product_id: null, items: [{ id: "oi_1", label: "Pro plan", amount: 5900, product_id: "prod_2" }], net_amount: 5900, total_amount: 5900 } })).toEqual([{ id: "prod_2", quantity: 1 }]);
    expect(purchasedItems({ raw: { id: "po_3", product_id: null, items: [{ id: "oi_2", label: "Pro plan", amount: 5900, product_price_id: "price_1" }], net_amount: 5900, total_amount: 5900 } })).toBeNull();
    expect(purchasedItems({ raw: { id: "po_4", product_id: null, net_amount: 5900, total_amount: 5900 } })).toBeNull();
    // Stripe: a session or a payment intent carries no line items, and no buyer sets its metadata
    expect(purchasedItems({ raw: { object: "checkout.session", amount_total: 5900, metadata: { voidbase_order: "ord_1" } } })).toBeNull();
    expect(purchasedItems({ raw: { object: "payment_intent", amount: 5900, metadata: { voidbase_order: "ord_1" } } })).toBeNull();
    expect(purchasedItems({ amount: 5900 })).toBeNull();
  });

  test("chargedBeforeProviderTax reads what a payment charged before the provider's own tax off what each provider sent back, and the row's amount otherwise", async () => {
    // Polar: net_amount is after discounts and before taxes, total_amount (the row's amount) after both
    expect(chargedBeforeProviderTax({ amount: 9720, raw: { id: "po_1", subtotal_amount: 10000, discount_amount: 1000, net_amount: 9000, tax_amount: 720, total_amount: 9720 } })).toBe(9000);
    // Lemon Squeezy, through its own rows: the total less the tax added to it, and the total when the price held the tax
    const { rows, tables } = memoryRows();
    const order = (id: string, attributes: Row) => applyLemonSqueezyEvent(rows, { meta: { event_name: "order_created", custom_data: {} }, data: { type: "orders", id, attributes: { customer_id: 7, user_email: "ada@b.test", currency: "USD", status: "paid", ...attributes } } });
    await order("1", { subtotal: 10000, discount_total: 0, tax: 2000, tax_inclusive: false, total: 12000 });
    await order("2", { subtotal: 10000, discount_total: 0, tax: 1667, tax_inclusive: true, total: 10000 });
    await order("3", { subtotal: 10000, discount_total: 1000, tax: 1800, tax_inclusive: false, total: 10800 });
    expect(tables.payments.map((p) => [p.amount, chargedBeforeProviderTax(p)])).toEqual([[12000, 10000], [10000, 10000], [10800, 9000]]);
    // Stripe is asked to add no tax of its own, so what it charged is its amount, and so is a row with no object to read
    expect(chargedBeforeProviderTax({ amount: 9740, raw: { object: "payment_intent", amount: 9740, metadata: {} } })).toBe(9740);
    expect(chargedBeforeProviderTax({ amount: 9740, raw: { object: "checkout.session", amount_total: 9740, total_details: { amount_tax: 0 } } })).toBe(9740);
    expect(chargedBeforeProviderTax({ amount: 500 })).toBe(500);
    expect(chargedBeforeProviderTax({})).toBe(0);
  });

  test("chargedBeforeProviderTax takes the figure what the provider sent says the price was, and NaN when that figure cannot be read, never the amount with the provider's tax in it", () => {
    // Polar: an order says nothing of how its price was taxed, so net_amount; an object that says tax_behavior (a
    // checkout's shape) is read by it, total_amount when inclusive and net_amount when exclusive
    const polar = { subtotal_amount: 8333, discount_amount: 0, net_amount: 8333, tax_amount: 1667, total_amount: 10000 };
    expect(chargedBeforeProviderTax({ amount: 10000, raw: polar })).toBe(8333);
    expect(chargedBeforeProviderTax({ amount: 10000, raw: { ...polar, tax_behavior: "inclusive" } })).toBe(10000);
    expect(chargedBeforeProviderTax({ amount: 10000, raw: { ...polar, tax_behavior: "exclusive" } })).toBe(8333);
    // a Polar object whose figure cannot be read: total_amount and tax_amount with no net_amount, a tax_amount alone, a
    // net_amount that is not a number, and an inclusive one with no total_amount
    expect(chargedBeforeProviderTax({ amount: 10000, raw: { subtotal_amount: 9260, discount_amount: 0, tax_amount: 740, total_amount: 10000 } })).toBeNaN();
    expect(chargedBeforeProviderTax({ amount: 10000, raw: { tax_amount: 740 } })).toBeNaN();
    expect(chargedBeforeProviderTax({ amount: 10000, raw: { net_amount: "9260", total_amount: 10000 } })).toBeNaN();
    expect(chargedBeforeProviderTax({ amount: 10000, raw: { net_amount: 8333, tax_behavior: "inclusive" } })).toBeNaN();
    // Lemon Squeezy: a tax that is there and not a number while tax_inclusive is not true, or a total that is not a number
    const lemon = (attributes: Row) => chargedBeforeProviderTax({ amount: 10000, raw: { attributes } });
    expect(lemon({ subtotal: 8333, tax: "1667", total: 10000 })).toBeNaN();
    expect(lemon({ tax: null, tax_inclusive: false, total: 10000 })).toBeNaN();
    expect(lemon({ tax: 0, tax_inclusive: false, total: "10000" })).toBeNaN();
    // and what can be read still is: a total that held its tax needs no tax figure, and no tax at all is none added
    expect(lemon({ tax: "1667", tax_inclusive: true, total: 10000 })).toBe(10000);
    expect(lemon({ total: 10000 })).toBe(10000);
  });
});

describe("what a checkout charges, as the interface, the provider and the docs say it", () => {
  const read = (f: string) => readFileSync(resolvePath(import.meta.dir, "../..", f), "utf8");

  test("a checkout with a reference is charged in full or refused, and one without is too but at Polar, whose buyer picks one of the products listed and pays for it once", () => {
    const interfaces = read("src/server/interfaces/index.ts"), shared = read("src/server/plugins/payments-shared.ts"), docs = read("docs/plugins.md");
    // what the three said until 2026-09-11: that every checkout charges everything it was given
    expect(interfaces).not.toContain("it charges every item and every amount line, or refuses");
    expect(shared).not.toContain("so no caller starts a checkout that charges less than it was given");
    expect(shared).not.toContain("start a checkout for a customers row, charging every item and every amount line");
    expect(docs).not.toContain("it never starts one that\ncharges less than it was given");
    const said = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from))).replace(/\s*\*?\s+/g, " ");
    const places = [
      said(interfaces, "Start a checkout for a customers row and return where", "checkout(env: Bindings"),
      said(shared, "Refuse (400) a checkout this provider would charge less of", "checkCharge?(o: CheckoutInput)"),
      said(docs, "**What a checkout charges.**", "**What a payment charged before"),
    ];
    for (const text of places) {
      expect(text).toContain("charged in full or refused");
      expect(text).toMatch(/Polar/);
      expect(text).toMatch(/moves no (commerce )?order|moves no order of commerce's/);
    }
  });
});
