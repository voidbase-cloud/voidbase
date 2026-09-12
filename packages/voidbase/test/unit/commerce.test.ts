// The commerce plugin: the cart's lifecycle, inventory reserved and released, the tax and shipping quotes arriving
// through `tax@1` and `shipping@1`, checkout handing the right line items to `payments@1`, a paid webhook moving
// the order through the seam the providers call, fulfilment, a refund, the audit trail, and the rules that keep one
// customer out of another's order.
//
// The two interfaces are fakes here, which is the point of the design being tested: commerce requires `tax@1` and
// `shipping@1` and not the shipped flat-rate plugins, so a test's own provider is as good as ours. Payments is the
// real stripe plugin over a fake `fetch`, because the webhook seam is exactly what has to be measured end to end, with
// polar or lemonsqueezy as the active provider where a test needs a merchant of record and its webhooks.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Hono } from "hono";
import { logger } from "#platform/log";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { invalidateCollections } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import type { Auth, CheckoutRequest, Payments, QuoteAddress, QuoteItem, Shipping, ShippingRate, Tax } from "../../src/server/interfaces";
import { KNOWN } from "../../src/server/interfaces";
import { createKernel, load, serve, using, type Kernel } from "../../src/server/kernel";
import {
  API, collectionDefinitions, COMMERCE_COLLECTIONS, commerceOn, commerceWith, defaultCurrency,
  type CommerceCollection, type CommerceRows,
} from "../../src/server/plugins/commerce";
import { KEY_VAR as LS_KEY, lemonsqueezyWith, signPayload as lsSign, STORE_VAR as LS_STORE, WEBHOOK_SECRET_VAR as LS_WEBHOOK_SECRET } from "../../src/server/plugins/lemonsqueezy";
import type { Plugin } from "../../src/server/plugins/manifest";
import { KEY_VAR as POLAR_KEY, polarWith, signPayload as polarSign, WEBHOOK_SECRET_VAR as POLAR_WEBHOOK_SECRET } from "../../src/server/plugins/polar";
import { SHIPPED, SHIPPED_FACTS } from "../../src/server/plugins/shipped";
import { flatRates, freeOver, shippingFlat, SHIPPING_FLAT_VAR, SHIPPING_FREE_OVER_VAR } from "../../src/server/plugins/shipping-flat";
import { KEY_VAR, signPayload, stripeWith, WEBHOOK_SECRET_VAR } from "../../src/server/plugins/stripe";
import { taxFlat, taxQuote, taxRate, TAX_RATE_VAR } from "../../src/server/plugins/tax-flat";
import type { PaymentCollection, PaymentRows } from "../../src/server/plugins/payments-shared";
import type { AppEnv, AuthRecord, Bindings, Row } from "../../src/server/types";

// ---- fakes ------------------------------------------------------------------------------------------

function paymentRows(seed: Partial<Record<PaymentCollection, Row[]>> = {}) {
  const tables: Record<PaymentCollection, Row[]> = { customers: [...(seed.customers ?? [])], subscriptions: [...(seed.subscriptions ?? [])], payments: [...(seed.payments ?? [])] };
  const n: Record<string, number> = {};
  const rows: PaymentRows = {
    async find(c, where) { return tables[c].find((r) => Object.entries(where).every(([k, v]) => String(r[k] ?? "") === v)) ?? null; },
    async create(c, values) { const row: Row = { id: `${c.slice(0, 3)}_${(n[c] = (n[c] ?? 0) + 1)}`, ...values }; tables[c].push(row); return row; },
    async update(c, id, values) { const row = tables[c].find((r) => r.id === id); if (!row) throw new Error(`no ${c} ${id}`); Object.assign(row, values); return row; },
  };
  return { rows, tables };
}

/**
 * The shop's rows in memory. `updateWhere` compares and writes in one step, as its one statement does at D1, and
 * `createOnce` writes its row and the updates that belong to it in one step, as its one batch does. With `slow`, every
 * other read and write waits a macrotask first, the way a D1 round trip yields, and reads answer copies, so that two
 * deliveries at once interleave as they would on a Worker.
 *
 * An inventory row's read and write do not wait, so that two reservations of one line add up here rather than overwrite
 * each other. That is the fake being kind: `reserve` and `release` read the row and write back a count they worked out,
 * so two of them at once do lose one of the two writes on a real database, which is among the things commerce does not
 * do (docs/plugins.md). These tests are about what else moves an order's stock, not about that.
 */
function commerceRows(seed: Partial<Record<CommerceCollection, Row[]>>, customers: () => Row[], o: { slow?: boolean } = {}) {
  const tables = Object.fromEntries(COMMERCE_COLLECTIONS.map((c) => [c, [...(seed[c] ?? [])]])) as Record<CommerceCollection, Row[]>;
  const n: Record<string, number> = {};
  const slow = (c: CommerceCollection) => !!o.slow && c !== "inventory";
  const wait = async (c: CommerceCollection) => { if (slow(c)) await new Promise((r) => setTimeout(r, 1)); };
  const list = async (c: CommerceCollection, where: Record<string, string>): Promise<Row[]> => {
    await wait(c);
    const found = tables[c].filter((r) => Object.entries(where).every(([k, v]) => String(r[k] ?? "") === v));
    return slow(c) ? found.map((r) => ({ ...r })) : found;
  };
  const rows: CommerceRows = {
    list,
    async find(c, where) { return (await list(c, where))[0] ?? null; },
    async create(c, values) { await wait(c); const row: Row = { id: `${c}_${(n[c] = (n[c] ?? 0) + 1)}`, ...values }; tables[c].push(row); return row; },
    async update(c, id, values) { await wait(c); const row = tables[c].find((r) => r.id === id); if (!row) throw new Error(`no ${c} ${id}`); Object.assign(row, values); return row; },
    async updateWhere(c, id, where, values) {
      const row = tables[c].find((r) => r.id === id && Object.entries(where).every(([k, v]) => String(r[k] ?? "") === v));
      if (row) Object.assign(row, values);
      await wait(c);
      return !!row;
    },
    async createOnce(c, values, alongside = []) {
      const id = String(values.id);
      if (tables[c].some((r) => String(r.id) === id)) { await wait(c); return false; }
      for (const u of alongside) {
        const row = tables[u.collection].find((r) => String(r.id) === u.id);
        if (!row) throw new Error(`no ${u.collection} ${u.id}`);
        Object.assign(row, u.values);
      }
      tables[c].push({ ...values });
      await wait(c);
      return true;
    },
    async remove(c, id) { const i = tables[c].findIndex((r) => r.id === id); if (i >= 0) tables[c].splice(i, 1); },
    async customers(user) { return customers().filter((r) => String(r.user ?? "") === user); },
  };
  return { rows, tables };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: URLSearchParams; raw: string };
function fakeFetch(answers: Record<string, Row> = {}) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    // Stripe's bodies are forms and Polar's are JSON: `body` reads the first, `raw` keeps either
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = new URLSearchParams(raw);
    calls.push({ url, method: init?.method ?? "GET", headers, body, raw });
    const answer = answers[`${init?.method ?? "GET"} ${new URL(url).pathname}`];
    if (!answer) return new Response(JSON.stringify({ error: { message: "unexpected call" } }), { status: 500 });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, f };
}

/** a tax engine of the test's own: a fifth on everything, and a record of what it was asked */
function fakeTax() {
  const asked: { items: QuoteItem[]; to: QuoteAddress; customer?: string }[] = [];
  const tax: Tax = {
    async quote(_env, o) {
      asked.push(o);
      const subtotal = o.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      const amount = Math.round(subtotal * 0.2);
      return amount ? { lines: [{ label: "VAT (20%)", amount }], total: amount } : { lines: [], total: 0 };
    },
  };
  const plugin: Plugin = {
    manifest: { name: "tax-fake", version: "1.0.0", tier: "community", voidbase: "*", provides: ["tax@1"] },
    apply: (ctx: Kernel) => serve<Tax>(ctx, "tax@1", tax),
  };
  return { plugin, asked };
}

/** a carrier of the test's own: two rates, and a record of what it was asked */
function fakeShipping(rates: ShippingRate[] = [{ id: "std", label: "Standard", amount: 500 }, { id: "express", label: "Express", amount: 1500, eta: "next day" }]) {
  const asked: { items: QuoteItem[]; to: QuoteAddress }[] = [];
  const shipping: Shipping = { async rates(_env, o) { asked.push(o); return rates; } };
  const plugin: Plugin = {
    manifest: { name: "shipping-fake", version: "1.0.0", tier: "community", voidbase: "*", provides: ["shipping@1"] },
    apply: (ctx: Kernel) => serve<Shipping>(ctx, "shipping@1", shipping),
  };
  return { plugin, asked };
}

/** a payment provider of the test's own: a customers row id per user, and a record of every checkout it was handed */
function fakePayments() {
  const checkouts: (CheckoutRequest & { customer: string })[] = [];
  const payments: Payments = {
    route: () => ({ via: "fake", webhook: "/api/payments/fake/webhook", livemode: false }),
    customer: async (_env, auth) => `cust_${String(auth.row.id)}`,
    checkout: async (_env, o) => { checkouts.push(o); return { url: "https://pay.test/fake" }; },
    portal: async () => ({ url: "https://pay.test/portal" }),
    webhook: async () => null,
    cancel: async () => undefined,
  };
  const plugin: Plugin = {
    manifest: { name: "payments-fake", version: "1.0.0", tier: "community", voidbase: "*", provides: ["payments@1"] },
    apply: (ctx: Kernel) => serve<Payments>(ctx, "payments@1", payments),
  };
  return { plugin, checkouts };
}

// ---- the shop ---------------------------------------------------------------------------------------

const users = { name: "users", id: "_pb_users_auth_" } as unknown as Collection;
const ada: AuthRecord = { collection: users, row: { id: "u1", email: "ada@b.test" } };
const bob: AuthRecord = { collection: users, row: { id: "u2", email: "bob@b.test" } };
const admin: AuthRecord = { collection: { name: "_superusers" } as unknown as Collection, row: { id: "admin" } };

const SECRET = "sk_test_abc", WHSEC = "whsec_test_123";
const POLAR_WHSEC = `whsec_${btoa("polar-signing-key-0123456789")}`, LS_WHSEC = "ls_signing_secret";
const T = 1_757_500_000; // a fixed "now", in unix seconds
const NOW = T * 1000;

const catalogue = (): Partial<Record<CommerceCollection, Row[]>> => ({
  products: [{ id: "p1", title: "Kettle", slug: "kettle", active: true }],
  variants: [
    { id: "v1", product: "p1", sku: "KET-1", title: "Kettle, black", price: 2500, currency: "usd", weight: 900, active: true },
    { id: "v2", product: "p1", sku: "KET-2", title: "Kettle, white", price: 2700, currency: "usd", priceId: "price_white", active: true },
  ],
  inventory: [{ id: "i1", variant: "v1", onHand: 3, reserved: 0 }],
});

const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); provideAuthLookup(() => undefined); });

async function shop(o: { auth?: AuthRecord | null; seed?: Partial<Record<CommerceCollection, Row[]>>; money?: Partial<Record<PaymentCollection, Row[]>>; answers?: Record<string, Row>; env?: Partial<Bindings>; payments?: Plugin; polar?: boolean; lemonsqueezy?: boolean; flat?: boolean; slow?: boolean } = {}) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
  let auth = o.auth ?? null;
  app.use("*", async (c, next) => { c.set("auth", auth); await next(); });
  const kernel = createKernel(app);
  const money = paymentRows(o.money);
  const shopRows = commerceRows(o.seed ?? catalogue(), () => money.tables.customers, { slow: o.slow });
  const { calls, f } = fakeFetch(o.answers ?? {});
  const stripe = stripeWith({ fetch: f, rows: () => money.rows, now: () => T });
  const tax = fakeTax(), shipping = fakeShipping();
  let numbers = 0;
  const plugin = commerceWith({ rows: () => shopRows.rows, now: () => NOW, token: () => "tok_1", number: () => `VB-${++numbers}` });
  stops.push(() => plugin.stopWatchingPayments());
  // payments@1 is the real stripe plugin, with polar or lemonsqueezy in its family when a test asks, or a provider of
  // the test's own; tax@1 and shipping@1 are the test's own, or when a test asks the shipped flat-rate pair, which with
  // nothing set charges neither
  const moneyDeps = { fetch: f, rows: () => money.rows, now: () => T };
  const providers = o.payments ? [o.payments] : [stripe, ...(o.polar ? [polarWith(moneyDeps)] : []), ...(o.lemonsqueezy ? [lemonsqueezyWith(moneyDeps)] : [])];
  await load(kernel, [...providers, ...(o.flat ? [taxFlat, shippingFlat] : [tax.plugin, shipping.plugin]), plugin], "0.9.0");
  provideAuthLookup(() => ({ isSuperuser: (r) => r?.row.id === "admin" }) as unknown as Auth);
  const env = {
    DB: {} as D1Database, STORAGE: {} as R2Bucket, [KEY_VAR]: SECRET, [WEBHOOK_SECRET_VAR]: WHSEC, [POLAR_WEBHOOK_SECRET]: POLAR_WHSEC, [LS_STORE]: "1", [LS_WEBHOOK_SECRET]: LS_WHSEC,
    VOIDBASE_COMMERCE: "1", ...o.env,
  } as unknown as Bindings;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await app.request(`http://x${path}`, init, env);
    return { status: res.status, json: (await res.json()) as Row };
  };
  const webhook = async (type: string, object: Row) => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", type, data: { object } });
    return call("POST", "/api/payments/stripe/webhook", payload, { "stripe-signature": `t=${T},v1=${await signPayload(WHSEC, payload, T)}` });
  };
  let delivery = 0;
  /** a Polar webhook: the Standard Webhooks headers over `{ type, timestamp, data }` */
  const polarHook = async (type: string, data: Row) => {
    const payload = JSON.stringify({ type, timestamp: new Date(NOW).toISOString(), data }), id = `msg_${++delivery}`;
    return call("POST", "/api/payments/polar/webhook", payload, { "webhook-id": id, "webhook-timestamp": String(T), "webhook-signature": `v1,${await polarSign(POLAR_WHSEC, id, T, payload)}` });
  };
  /** a Lemon Squeezy webhook: the event name and the checkout's custom data in `meta`, the JSON:API resource in `data` */
  const lsHook = async (name: string, data: Row, custom: Row = {}) => {
    const payload = JSON.stringify({ meta: { event_name: name, custom_data: custom }, data });
    return call("POST", "/api/payments/lemonsqueezy/webhook", payload, { "x-signature": await lsSign(LS_WHSEC, payload) });
  };
  return {
    app, kernel, env, calls, plugin, money, rows: shopRows.rows, tables: shopRows.tables, tax, shipping, webhook, polarHook, lsHook,
    as: (who: AuthRecord | null) => { auth = who; },
    get: (path: string, headers?: Record<string, string>) => call("GET", path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => call("POST", path, body ?? {}, headers),
    patch: (path: string, body?: unknown, headers?: Record<string, string>) => call("PATCH", path, body ?? {}, headers),
    del: (path: string, headers?: Record<string, string>) => call("DELETE", path, undefined, headers),
    payments: () => using<Payments>(kernel, "payments@1"),
    audit: () => shopRows.tables.commerce_audit.map((r) => String(r.action)),
  };
}

const SESSION = { "POST /v1/customers": { id: "cus_1" }, "POST /v1/checkout/sessions": { url: "https://checkout.test/x" } };
const ADDRESS = { line1: "1 High Street", city: "Cambridge", postcode: "CB1 1AA", country: "gb" };

/** a signed-in shop with a cart of two black kettles and one white, an address, and Stripe answering */
async function readyToPay(o: Parameters<typeof shop>[0] = {}) {
  const s = await shop({ auth: ada, answers: SESSION, ...o });
  await s.post(`${API}/cart/items`, { variant: "v1", quantity: 2 });
  await s.post(`${API}/cart/items`, { variant: "v2", quantity: 1 });
  await s.post(`${API}/cart/address`, { address: ADDRESS });
  return s;
}

/**
 * Make one write of the shop's rows fail once, the way D1 goes away for a moment: the first `create`, `update`,
 * `updateWhere` or `createOnce` for which `failing` says yes throws, and every other write goes through. A `createOnce`
 * is tripped by its row or by an update that belongs to it, and then it has written neither, as its batch would have
 * landed neither.
 */
function breakOnce(s: Awaited<ReturnType<typeof shop>>, failing: (collection: CommerceCollection, values: Row) => boolean) {
  let broken = true;
  const trip = (collection: CommerceCollection, values: Row) => {
    if (broken && failing(collection, values)) { broken = false; throw new Error("D1 went away for a moment"); }
  };
  const create = s.rows.create.bind(s.rows), update = s.rows.update.bind(s.rows);
  const updateWhere = s.rows.updateWhere.bind(s.rows), createOnce = s.rows.createOnce.bind(s.rows);
  s.rows.create = async (collection, values) => { trip(collection, values); return create(collection, values); };
  s.rows.update = async (collection, id, values) => { trip(collection, values); return update(collection, id, values); };
  s.rows.updateWhere = async (collection, id, where, values) => { trip(collection, values); return updateWhere(collection, id, where, values); };
  s.rows.createOnce = async (collection, values, alongside) => {
    trip(collection, values);
    for (const u of alongside ?? []) trip(u.collection, u.values);
    return createOnce(collection, values, alongside);
  };
}

/** a signed-in shop on Stripe with no tax and no shipping, and `quantity` black kettles checked out: orders_1 is 2500 each */
async function kettles(quantity: number, o: Parameters<typeof shop>[0] = {}) {
  const s = await shop({ auth: ada, answers: SESSION, flat: true, ...o });
  await s.post(`${API}/cart/items`, { variant: "v1", quantity });
  await s.post(`${API}/cart/address`, { address: ADDRESS });
  expect((await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" })).status).toBe(200);
  return s;
}

const POLAR_ANSWERS = { "GET /v1/customers/": { items: [] }, "POST /v1/customers/": { id: "pcus_1" }, "POST /v1/checkouts/": { url: "https://polar.test/co_1" } };
const LEMON_ANSWERS = { "GET /v1/customers": { data: [] }, "POST /v1/customers": { data: { type: "customers", id: "7" } }, "POST /v1/checkouts": { data: { type: "checkouts", id: "co_1", attributes: { url: "https://ls.test/co_1" } } } };

/**
 * A signed-in shop whose active provider is a merchant of record, Polar or Lemon Squeezy, with the shipped flat-rate
 * pair charging no tax and no shipping (neither provider takes an amount line), and one steel kettle checked out: the
 * order `orders_1` of 10000 usd is pending with its kettle reserved, and the checkout named it. The buyer's customers
 * row is `cus_1`, which is `pcus_1` at Polar and `7` at Lemon Squeezy.
 */
async function merchantOfRecordOrder(provider: "polar" | "lemonsqueezy") {
  const steel = { id: "v4", product: "p1", sku: "KET-4", title: "Kettle, steel", price: 10000, currency: "usd", priceId: "123", active: true };
  const s = await shop({
    auth: ada, flat: true, polar: provider === "polar", lemonsqueezy: provider === "lemonsqueezy",
    seed: { ...catalogue(), variants: [...catalogue().variants!, steel], inventory: [{ id: "i4", variant: "v4", onHand: 3, reserved: 0 }] },
    env: { [KEY_VAR]: "", ...(provider === "polar" ? { [POLAR_KEY]: "polar_oat_1" } : { [LS_KEY]: "ls_key_1" }) } as Partial<Bindings>,
    answers: provider === "polar" ? POLAR_ANSWERS : LEMON_ANSWERS,
  });
  await s.post(`${API}/cart/items`, { variant: "v4" });
  await s.post(`${API}/cart/address`, { address: ADDRESS });
  const out = await s.post(`${API}/checkout`, { success: "https://a" });
  expect(out.status).toBe(200);
  expect(out.json.order).toMatchObject({ id: "orders_1", status: "pending", subtotal: 10000, tax: 0, shipping: 0, total: 10000 });
  expect(s.tables.inventory[0]).toMatchObject({ variant: "v4", reserved: 1 });
  return s;
}

// ---- the graph --------------------------------------------------------------------------------------

describe("the plugin and the two interfaces beside it", () => {
  test("tax@1 and shipping@1 are interfaces this voidbase defines, and the flat-rate plugins provide them", () => {
    expect(KNOWN).toContain("tax@1");
    expect(KNOWN).toContain("shipping@1");
    expect(taxFlat.manifest).toMatchObject({ name: "tax-flat", tier: "official", provides: ["tax@1"] });
    expect(shippingFlat.manifest).toMatchObject({ name: "shipping-flat", tier: "official", provides: ["shipping@1"] });
  });

  test("commerce requires the three interfaces, owns ten collections, and loads after whoever provides them", async () => {
    const s = await shop();
    expect(s.plugin.manifest.requires).toEqual(["payments@1", "tax@1", "shipping@1"]);
    expect(s.plugin.manifest.collections).toEqual([...COMMERCE_COLLECTIONS]);
    expect(s.plugin.manifest.collections).toHaveLength(10);
    expect(s.kernel.bootstraps.map((b) => b.plugin).at(-1)).toBe("commerce");
  });

  test("the shipped table says the same as the manifests, so the CLI reads it without importing them", () => {
    for (const name of ["tax-flat", "shipping-flat", "commerce"] as const) expect(SHIPPED).toContain(name);
    expect(SHIPPED_FACTS["tax-flat"]).toEqual({ tier: "official", provides: ["tax@1"] });
    expect(SHIPPED_FACTS["shipping-flat"]).toEqual({ tier: "official", provides: ["shipping@1"] });
    expect(SHIPPED_FACTS.commerce).toEqual({ tier: "official", requires: ["payments@1", "tax@1", "shipping@1"] });
  });

  test("the knobs: the shop is off unless VOIDBASE_COMMERCE says otherwise, and every route says so", async () => {
    expect(commerceOn({})).toBe(false);
    expect(commerceOn({ VOIDBASE_COMMERCE: "0" })).toBe(false);
    expect(commerceOn({ VOIDBASE_COMMERCE: "1" })).toBe(true);
    expect(defaultCurrency({})).toBe("usd");
    expect(defaultCurrency({ VOIDBASE_COMMERCE_CURRENCY: "GBP" })).toBe("gbp");
    const s = await shop({ auth: ada, env: { VOIDBASE_COMMERCE: "" } });
    for (const r of [await s.get(`${API}/cart`), await s.post(`${API}/cart/items`, { variant: "v1" }), await s.post(`${API}/checkout`, { success: "https://a" }), await s.get(`${API}/orders`)]) {
      expect(r.status).toBe(503);
      expect(String(r.json.message)).toContain("VOIDBASE_COMMERCE");
    }
  });
});

// ---- the collections --------------------------------------------------------------------------------

describe("the collections it owns", () => {
  test("the catalogue is public and active-only, everything else is the owner's, and nothing has a write rule", async () => {
    const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
    const db = { prepare: () => stmt } as unknown as D1Database;
    let defs: Record<string, unknown>[];
    try { defs = await collectionDefinitions(db); } finally { invalidateCollections(); }
    const by = Object.fromEntries(defs.map((d) => [String(d.name), d]));
    expect(Object.keys(by)).toEqual([...COMMERCE_COLLECTIONS]);
    expect(by.products).toMatchObject({ listRule: "active = true", viewRule: "active = true" });
    expect(by.variants!.listRule).toBe("active = true && product.active = true");
    expect(by.inventory!.listRule).toBe("variant.active = true");
    expect(by.carts).toMatchObject({ listRule: "user = @request.auth.id" });
    expect(by.cart_items!.listRule).toBe("cart.user = @request.auth.id");
    expect(by.orders!.listRule).toBe("user = @request.auth.id");
    for (const name of ["order_items", "shipments", "refunds"]) expect(by[name]!.listRule).toBe("order.user = @request.auth.id");
    // the rules name the order's own user rather than the payments plugin's customers.user: that collection exists
    // only once a provider key is set, and a rule naming a collection that is not there fails the create
    expect(JSON.stringify(by.orders!.fields)).toContain('"name":"user"');
    // the audit trail is superuser-read and, like every other collection here, superuser-write
    expect(by.commerce_audit).toMatchObject({ listRule: null, viewRule: null });
    for (const d of defs) expect([d.createRule, d.updateRule, d.deleteRule]).toEqual([null, null, null]);
    const fields = (name: string) => (by[name]!.fields as { name: string }[]).map((f) => f.name);
    expect(fields("orders")).toEqual(["number", "customer", "user", "email", "status", "currency", "subtotal", "tax", "shipping", "total", "address", "payment", "placedAt", "created", "updated"]);
    expect(fields("order_items")).toEqual(["order", "variant", "sku", "title", "quantity", "unitPrice", "total", "priceId", "created", "updated"]);
    expect(fields("commerce_audit")).toEqual(["at", "actor", "action", "subject", "detail", "created", "updated"]);
  });
});

// ---- the cart ---------------------------------------------------------------------------------------

describe("the cart's lifecycle", () => {
  test("an anonymous cart is made once, carried by its token, added to, changed and emptied", async () => {
    const s = await shop();
    const made = await s.post(`${API}/cart`);
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ token: "tok_1", status: "open", currency: "usd", items: [], subtotal: 0 });
    expect(String(made.json.expires)).toBe(new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString());
    const tok = { "x-cart-token": "tok_1" };

    const added = await s.post(`${API}/cart/items`, { variant: "v1", quantity: 2 }, tok);
    expect(added.json.subtotal).toBe(5000);
    expect(added.json.items).toEqual([{ id: "cart_items_1", variant: "v1", sku: "KET-1", title: "Kettle, black", quantity: 2, unitPrice: 2500, total: 5000 }]);
    // the same variant again is the same line, not a second one
    expect((await s.post(`${API}/cart/items`, { variant: "v1" }, tok)).json.subtotal).toBe(7500);
    expect(s.tables.cart_items).toHaveLength(1);
    // and the cart is found by its token rather than made again
    expect((await s.get(`${API}/cart?token=tok_1`)).json.id).toBe(made.json.id);
    expect(s.tables.carts).toHaveLength(1);

    expect((await s.patch(`${API}/cart/items/cart_items_1`, { quantity: 1 }, tok)).json.subtotal).toBe(2500);
    expect((await s.patch(`${API}/cart/items/cart_items_1`, { quantity: 0 }, tok)).json.items).toEqual([]);
    expect(s.tables.cart_items).toHaveLength(0);
    expect(s.audit()).toEqual(["cart.created", "cart.item.added", "cart.item.changed", "cart.item.changed", "cart.item.removed"]);
  });

  test("a bad quantity, an unknown variant and somebody else's line are refused before anything is written", async () => {
    const s = await shop();
    await s.post(`${API}/cart`);
    const tok = { "x-cart-token": "tok_1" };
    expect((await s.post(`${API}/cart/items`, { variant: "v1", quantity: 0 }, tok)).status).toBe(400);
    expect((await s.post(`${API}/cart/items`, { variant: "v1", quantity: 1.5 }, tok)).status).toBe(400);
    expect((await s.post(`${API}/cart/items`, { variant: "nope" }, tok)).status).toBe(404);
    expect((await s.post(`${API}/cart/items`, {}, tok)).status).toBe(404);
    expect((await s.del(`${API}/cart/items/cart_items_9`, tok)).status).toBe(404);
    expect(s.tables.cart_items).toHaveLength(0);
  });

  test("a signed-in cart is the session's, and signing in with a token in hand claims that cart", async () => {
    const s = await shop();
    await s.post(`${API}/cart/items`, { variant: "v1" }); // anonymous: token tok_1
    s.as(ada);
    const mine = await s.post(`${API}/cart`, { token: "tok_1" });
    expect(mine.json.id).toBe("carts_1");
    expect(s.tables.carts).toHaveLength(1);
    expect(String(s.tables.carts[0]!.user)).toBe("u1");
    expect(s.audit()).toContain("cart.claimed");
    // and from then on the session finds it without the token
    expect((await s.get(`${API}/cart`)).json.id).toBe("carts_1");
  });
});

// ---- inventory --------------------------------------------------------------------------------------

describe("inventory", () => {
  test("a variant with a row cannot be over-sold; one without a row is untracked and never blocks", async () => {
    const s = await shop();
    await s.post(`${API}/cart`);
    const tok = { "x-cart-token": "tok_1" };
    const over = await s.post(`${API}/cart/items`, { variant: "v1", quantity: 4 }, tok);
    expect(over.status).toBe(409);
    expect(String(over.json.message)).toContain("Only 3 of KET-1 are available and 4 were asked for");
    expect((await s.post(`${API}/cart/items`, { variant: "v1", quantity: 3 }, tok)).status).toBe(200);
    expect((await s.post(`${API}/cart/items`, { variant: "v1" }, tok)).status).toBe(409);
    // v2 has no inventory row at all
    expect((await s.post(`${API}/cart/items`, { variant: "v2", quantity: 99 }, tok)).status).toBe(200);
  });

  test("stock is reserved at checkout and released when the payment fails", async () => {
    const s = await readyToPay();
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    // the payment intent names the order it was started for, as commerce's checkout asked Stripe to
    const failed = await s.webhook("payment_intent.payment_failed", { id: "pi_9", customer: "cus_1", amount: 9740, currency: "usd", metadata: { voidbase_order: "orders_1" } });
    expect(failed.status).toBe(200);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 0 });
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_1" });
    expect(s.audit()).toContain("order.payment_failed");
  });

  test("a provider that refuses the checkout gives the stock back and cancels the order it had just made", async () => {
    // the provider answers the customer call and then refuses the session
    const s = await readyToPay({ answers: { "POST /v1/customers": { id: "cus_1" } } });
    const refused = await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(refused.status).toBe(502);
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 0 });
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled" });
    expect(s.audit()).toContain("order.checkout_failed");
  });
});

// ---- the two interfaces -----------------------------------------------------------------------------

describe("tax and shipping, quoted through the interfaces", () => {
  test("the address step asks both providers with the cart's lines and answers what they said", async () => {
    const s = await shop({ auth: ada });
    await s.post(`${API}/cart/items`, { variant: "v1", quantity: 2 });
    const quoted = await s.post(`${API}/cart/address`, { address: { ...ADDRESS, region: "" } });
    expect(quoted.status).toBe(200);
    expect(quoted.json).toMatchObject({
      currency: "usd", subtotal: 5000,
      address: { line1: "1 High Street", city: "Cambridge", postcode: "CB1 1AA", country: "GB" },
      tax: { lines: [{ label: "VAT (20%)", amount: 1000 }], total: 1000 },
      shipping: [{ id: "std", label: "Standard", amount: 500 }, { id: "express", label: "Express", amount: 1500, eta: "next day" }],
    });
    expect(s.tax.asked).toHaveLength(1);
    expect(s.tax.asked[0]!.items).toEqual([{ variant: "v1", sku: "KET-1", title: "Kettle, black", quantity: 2, unitPrice: 2500, weight: 900 }]);
    expect(s.tax.asked[0]!.to.country).toBe("GB");
    expect(s.shipping.asked[0]!.items).toEqual(s.tax.asked[0]!.items);
    expect(s.tables.carts[0]!.address).toMatchObject({ country: "GB" });
    expect(s.audit()).toContain("cart.address.set");
  });

  test("an address with nothing in it is refused, and so is a checkout with no address at all", async () => {
    const s = await shop({ auth: ada });
    await s.post(`${API}/cart/items`, { variant: "v1" });
    expect((await s.post(`${API}/cart/address`, { address: { nonsense: "x" } })).status).toBe(400);
    const no = await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(no.status).toBe(400);
    expect(String(no.json.message)).toContain("/cart/address");
  });

  test("the shipped flat-rate pair: a percentage, one rate, and free over a threshold", () => {
    const items = [{ quantity: 2, unitPrice: 2500 }];
    expect(taxRate({})).toBe(0);
    expect(taxQuote({}, items)).toEqual({ lines: [], total: 0 });
    expect(taxRate({ [TAX_RATE_VAR]: "20" })).toBe(20);
    expect(taxQuote({ [TAX_RATE_VAR]: "20" }, items)).toEqual({ lines: [{ label: "Tax (20%)", amount: 1000 }], total: 1000 });
    expect(taxQuote({ [TAX_RATE_VAR]: "7.5" }, items).total).toBe(375);
    expect(taxQuote({ [TAX_RATE_VAR]: "nonsense" }, items).total).toBe(0);
    expect(flatRates({}, items)).toEqual([{ id: "flat", label: "Free shipping", amount: 0 }]);
    expect(flatRates({ [SHIPPING_FLAT_VAR]: "599" }, items)).toEqual([{ id: "flat", label: "Standard shipping", amount: 599 }]);
    expect(freeOver({ [SHIPPING_FREE_OVER_VAR]: "5000" })).toBe(5000);
    expect(flatRates({ [SHIPPING_FLAT_VAR]: "599", [SHIPPING_FREE_OVER_VAR]: "5000" }, items)).toEqual([{ id: "flat", label: "Free shipping", amount: 0 }]);
    expect(flatRates({ [SHIPPING_FLAT_VAR]: "599", [SHIPPING_FREE_OVER_VAR]: "5001" }, items)[0]!.amount).toBe(599);
  });
});

// ---- checkout ---------------------------------------------------------------------------------------

describe("checkout", () => {
  test("the cart becomes a pending order and the line items go to payments@1, which answers the URL", async () => {
    const s = await readyToPay();
    const out = await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b", shipping: "express" });
    expect(out.status).toBe(200);
    expect(out.json.url).toBe("https://checkout.test/x");
    expect(out.json.order).toMatchObject({ number: "VB-1", status: "pending", email: "ada@b.test", currency: "usd", subtotal: 7700, tax: 1540, shipping: 1500, total: 10740, placedAt: new Date(NOW).toISOString() });

    // the customers row was made through payments@1 and the order points at it
    expect(s.money.tables.customers[0]).toMatchObject({ id: "cus_1", user: "u1", provider: "stripe", providerId: "cus_1" });
    expect(s.tables.orders[0]!.customer).toBe("cus_1");

    // what Stripe was actually handed: the variant's provider price when it has one, its sku when it does not
    const session = s.calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!;
    expect(session.body.get("line_items[0][price]")).toBe("KET-1");
    expect(session.body.get("line_items[0][quantity]")).toBe("2");
    expect(session.body.get("line_items[1][price]")).toBe("price_white");
    expect(session.body.get("line_items[1][quantity]")).toBe("1");
    expect(session.body.get("mode")).toBe("payment");
    expect(session.body.get("success_url")).toBe("https://a");
    // and what Stripe has no price for, the tax and the chosen rate, as amounts of their own, so the session charges
    // the order's total; the order's id rides along on the session and on its payment intent
    expect(session.body.get("line_items[2][price_data][product_data][name]")).toBe("VAT (20%)");
    expect(session.body.get("line_items[2][price_data][unit_amount]")).toBe("1540");
    expect(session.body.get("line_items[2][price_data][currency]")).toBe("usd");
    expect(session.body.get("line_items[2][quantity]")).toBe("1");
    expect(session.body.get("line_items[3][price_data][product_data][name]")).toBe("Express");
    expect(session.body.get("line_items[3][price_data][unit_amount]")).toBe("1500");
    expect([...session.body.keys()].filter((k) => k.startsWith("line_items[4]"))).toEqual([]);
    expect(session.body.get("metadata[voidbase_order]")).toBe("orders_1");
    expect(session.body.get("payment_intent_data[metadata][voidbase_order]")).toBe("orders_1");

    // the order's items are a record of what was bought, not a pointer to a variant that may change
    expect(s.tables.order_items.map((r) => ({ sku: r.sku, title: r.title, quantity: r.quantity, unitPrice: r.unitPrice, total: r.total }))).toEqual([
      { sku: "KET-1", title: "Kettle, black", quantity: 2, unitPrice: 2500, total: 5000 },
      { sku: "KET-2", title: "Kettle, white", quantity: 1, unitPrice: 2700, total: 2700 },
    ]);
    expect(s.tables.carts[0]!.status).toBe("ordered");
    expect(s.audit()).toContain("order.placed");
    // the quotes were taken again at checkout rather than trusted from the address step
    expect(s.tax.asked).toHaveLength(2);
  });

  test("the default rate is the first one; a rate the carrier did not offer is refused; an empty cart is refused", async () => {
    const s = await readyToPay();
    expect((await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b", shipping: "hovercraft" })).status).toBe(400);
    const out = await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(out.json.order).toMatchObject({ shipping: 500, total: 9740 });
    // the cart is spent, so the next checkout has nothing to sell
    const again = await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(again.status).toBe(404);
  });

  test("checkout needs a session, because the customers row payments@1 takes belongs to a signed-in user", async () => {
    const s = await shop({ answers: SESSION });
    expect((await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" })).status).toBe(401);
    expect(s.calls).toHaveLength(0);
  });

  test("what payments@1 is asked to charge adds up to the order's total: the variants' prices, then the tax and the shipping as amounts", async () => {
    const fake = fakePayments();
    const s = await readyToPay({ payments: fake.plugin });
    const out = await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b", shipping: "express" });
    expect(out.status).toBe(200);
    const order = out.json.order as Row;
    expect(order).toMatchObject({ subtotal: 7700, tax: 1540, shipping: 1500, total: 10740 });
    expect(fake.checkouts).toHaveLength(1);
    const asked = fake.checkouts[0]!;
    expect(asked.items).toEqual([{ price: "KET-1", quantity: 2 }, { price: "price_white", quantity: 1 }]);
    expect(asked.amounts).toEqual([{ name: "VAT (20%)", amount: 1540, currency: "usd" }, { name: "Express", amount: 1500, currency: "usd" }]);
    // a price id stands for the variant's price at the provider, so the lines can be added up here
    const priceOf = Object.fromEntries((catalogue().variants ?? []).map((v) => [String(v.priceId || v.sku), Number(v.price)]));
    const charged = asked.items.reduce((sum, i) => sum + priceOf[i.price]! * i.quantity, 0) + (asked.amounts ?? []).reduce((sum, a) => sum + a.amount, 0);
    expect(charged).toBe(Number(order.total));
    expect(asked).toMatchObject({ customer: "cust_u1", reference: String(order.id), currency: "usd", success: "https://a", cancel: "https://b", mode: "payment" });
  });

  test("a provider that cannot charge the tax and the shipping refuses the cart before the customer, the order or the reservation exist", async () => {
    // Polar is the active provider (its key alone is set), and a Polar checkout has no line for an amount
    const s = await readyToPay({
      polar: true, env: { [KEY_VAR]: "", [POLAR_KEY]: "polar_oat_1" } as Partial<Bindings>,
      answers: { "GET /v1/customers/": { items: [] }, "POST /v1/customers/": { id: "pcus_1" }, "POST /v1/checkouts/": { url: "https://polar.test/co_1" } },
    });
    const refused = await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(refused.status).toBe(400);
    expect(String(refused.json.message)).toContain("Polar charges the products it sells and has no line for an amount");
    expect(s.calls).toHaveLength(0);
    expect(s.money.tables.customers).toHaveLength(0);
    expect(s.tables.orders).toHaveLength(0);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 0 });
    expect(s.tables.carts[0]!.status).toBe("open");
    expect(s.audit()).not.toContain("order.placed");
  });

  test("through Polar, which charges one product once, a cart of two lines or of two of one line is refused before an order exists, even with no tax or shipping to refuse, because commerce's checkout is for an order", async () => {
    // Polar is the active provider, and the shipped flat-rate pair with nothing set charges no tax and no shipping, so
    // there is no amount line to refuse: what is left is what Polar would charge for only one of. Polar's own route
    // lists several products for a buyer to pick from; commerce asks about a checkout for an order, which may not
    const polar = {
      auth: ada, polar: true, flat: true, env: { [KEY_VAR]: "", [POLAR_KEY]: "polar_oat_1" } as Partial<Bindings>,
      answers: { "GET /v1/customers/": { items: [] }, "POST /v1/customers/": { id: "pcus_1" }, "POST /v1/checkouts/": { url: "https://polar.test/co_1" } },
    };
    // two black kettles and a white one: Polar would have listed two products and charged for the one picked
    const lines = await readyToPay(polar);
    const refused = await lines.post(`${API}/checkout`, { success: "https://a" });
    expect(refused.status).toBe(400);
    expect(String(refused.json.message)).toContain("A Polar checkout for an order takes one item");
    // two of one kettle: Polar would have charged for it once
    const twice = await shop(polar);
    await twice.post(`${API}/cart/items`, { variant: "v1", quantity: 2 });
    await twice.post(`${API}/cart/address`, { address: ADDRESS });
    const again = await twice.post(`${API}/checkout`, { success: "https://a" });
    expect(again.status).toBe(400);
    expect(String(again.json.message)).toContain("A Polar checkout for an order takes a quantity of 1");
    for (const s of [lines, twice]) {
      expect(s.calls).toHaveLength(0);
      expect(s.money.tables.customers).toHaveLength(0);
      expect(s.tables.orders).toHaveLength(0);
      expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 0 });
      expect(s.tables.carts[0]!.status).toBe("open");
    }
    // one white kettle, once, is what Polar charges in full: the checkout goes, names its order, offers no discount code,
    // and is shown in the cart's currency rather than the buyer's own
    const one = await shop(polar);
    await one.post(`${API}/cart/items`, { variant: "v2" });
    await one.post(`${API}/cart/address`, { address: ADDRESS });
    const out = await one.post(`${API}/checkout`, { success: "https://a" });
    expect(out.status).toBe(200);
    expect(out.json.order).toMatchObject({ subtotal: 2700, tax: 0, shipping: 0, total: 2700 });
    const checkout = one.calls.find((c) => c.url.endsWith("/v1/checkouts/"))!;
    expect(JSON.parse(checkout.raw)).toMatchObject({ products: ["price_white"], metadata: { voidbase_order: "orders_1" }, allow_discount_codes: false, currency: "usd" });
  });

  test("a checkout on Stripe with only a success URL goes: that cancel is given is the rule of Stripe's route and not of payments@1, and the session is sent no cancel_url", async () => {
    const s = await readyToPay();
    const out = await s.post(`${API}/checkout`, { success: "https://a" });
    expect(out.status).toBe(200);
    expect(out.json.url).toBe("https://checkout.test/x");
    expect(out.json.order).toMatchObject({ status: "pending", total: 9740 });
    const session = s.calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!;
    expect(session.body.get("success_url")).toBe("https://a");
    expect(session.body.has("cancel_url")).toBe(false);
    expect(s.audit()).not.toContain("order.checkout_failed");
  });
});

// ---- the seam ---------------------------------------------------------------------------------------

describe("learning that an order was paid", () => {
  test("the provider's own webhook writes a payments row, and commerce moves the order behind it", async () => {
    const s = await readyToPay();
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b", shipping: "express" });
    expect(s.tables.orders[0]!.status).toBe("pending");
    const paid = await s.webhook("checkout.session.completed", { id: "cs_1", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 10740, currency: "usd", metadata: { voidbase_order: "orders_1" } });
    expect(paid.json).toMatchObject({ received: true, handled: true, kind: "checkout.session.completed" });
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    const row = s.tables.commerce_audit.find((r) => r.action === "order.paid")!;
    expect(row.actor).toBe("payments:stripe");
    expect(row.detail).toMatchObject({ provider: "stripe", payment: "pay_1", amount: 10740, currency: "usd" });
    // a replayed webhook is the same upsert and the same move: the order is still paid, once
    await s.webhook("checkout.session.completed", { id: "cs_1", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 10740, currency: "usd", metadata: { voidbase_order: "orders_1" } });
    expect(s.money.tables.payments).toHaveLength(1);
    expect(s.tables.orders.filter((o) => o.status === "paid")).toHaveLength(1);
  });

  test("the watchers belong to one app, so another instance's webhook does not move this one's order", async () => {
    const one = await readyToPay();
    await one.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    const two = await readyToPay();
    await two.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    await two.webhook("checkout.session.completed", { id: "cs_2", customer: "cus_1", mode: "payment", payment_intent: "pi_2", payment_status: "paid", amount_total: 9740, currency: "usd", metadata: { voidbase_order: "orders_1" } });
    expect(two.tables.orders[0]!.status).toBe("paid");
    expect(one.tables.orders[0]!.status).toBe("pending");
  });

  test("a payment for a customer with no pending order of ours is left alone", async () => {
    const s = await shop({ auth: ada, answers: SESSION });
    const answered = await s.webhook("payment_intent.succeeded", { id: "pi_5", customer: "cus_9", amount: 100, currency: "usd" });
    expect(answered.status).toBe(200);
    expect(s.tables.orders).toHaveLength(0);
    expect(s.tables.commerce_audit).toHaveLength(0);
  });

  test("a payment that does not pay its order's total leaves the order pending, and the audit trail says so once", async () => {
    // the demo's numbers: a 4500 lamp, a fifth on top in tax, 500 to post it, and a session that charged only the lamp
    const lamp = { id: "v3", product: "p1", sku: "LAMP-1", title: "Lamp", price: 4500, currency: "usd", priceId: "price_lamp", active: true };
    const s = await shop({ auth: ada, answers: SESSION, seed: { ...catalogue(), variants: [lamp], inventory: [] } });
    await s.post(`${API}/cart/items`, { variant: "v3" });
    await s.post(`${API}/cart/address`, { address: ADDRESS });
    const placed = await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(placed.json.order).toMatchObject({ subtotal: 4500, tax: 900, shipping: 500, total: 5900, status: "pending" });
    // a session that names the order and charged only the lamp, and Stripe tells of it twice: the session, then its payment intent
    const named = { customer: "cus_1", currency: "usd", metadata: { voidbase_order: "orders_1" } };
    await s.webhook("checkout.session.completed", { id: "cs_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 4500, ...named });
    await s.webhook("payment_intent.succeeded", { id: "pi_1", amount: 4500, ...named });
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.orders[0]!.payment).toBeUndefined();
    expect(s.audit()).not.toContain("order.paid");
    const unmatched = s.tables.commerce_audit.filter((r) => r.action === "order.payment_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({ actor: "payments:stripe", subject: "order:orders_1" });
    expect(unmatched[0]!.detail).toMatchObject({ provider: "stripe", payment: "pay_1", amount: 4500, currency: "usd", status: "succeeded", customer: "cus_1", reference: "orders_1", owed: [{ order: "orders_1", total: 5900, currency: "usd" }] });
    expect((unmatched[0]!.detail as Row).reason).toBe(`it names order "orders_1" and pays 4500 usd, where the order's total is 5900 usd`);
  });

  test("a payment that names its order pays that order, even beside another pending order of the same total", async () => {
    const s = await readyToPay({ seed: { ...catalogue(), inventory: [{ id: "i1", variant: "v1", onHand: 10, reserved: 0 }] } });
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    // the same cart again, so the customer has two pending orders of 9740
    await s.post(`${API}/cart/items`, { variant: "v1", quantity: 2 });
    await s.post(`${API}/cart/items`, { variant: "v2", quantity: 1 });
    await s.post(`${API}/cart/address`, { address: ADDRESS });
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(s.tables.orders.map((o) => [o.id, o.status, o.total])).toEqual([["orders_1", "pending", 9740], ["orders_2", "pending", 9740]]);
    // what commerce handed Stripe for the second order is what Stripe sends back, on the session and on its payment intent
    const reference = s.calls.filter((c) => c.url.endsWith("/v1/checkout/sessions"))[1]!.body.get("metadata[voidbase_order]");
    expect(reference).toBe("orders_2");
    await s.webhook("checkout.session.completed", { id: "cs_2", customer: "cus_1", mode: "payment", payment_intent: "pi_2", payment_status: "paid", amount_total: 9740, currency: "usd", metadata: { voidbase_customer: "cus_1", voidbase_order: reference } });
    await s.webhook("payment_intent.succeeded", { id: "pi_2", customer: "cus_1", amount: 9740, currency: "usd", metadata: { voidbase_order: reference } });
    expect(s.tables.orders.map((o) => [o.id, o.status, o.payment])).toEqual([["orders_1", "pending", undefined], ["orders_2", "paid", "pay_1"]]);
    expect(s.tables.commerce_audit.filter((r) => r.action === "order.paid").map((r) => [r.subject, (r.detail as Row).reference])).toEqual([["order:orders_2", "orders_2"]]);
    expect(s.audit()).not.toContain("order.payment_unmatched");
  });

  test("a payment that names somebody else's order moves neither that order nor one of the payer's own", async () => {
    const money = { customers: [{ id: "c_ada", user: "u1", provider: "stripe", providerId: "cus_ada" }, { id: "c_bob", user: "u2", provider: "stripe", providerId: "cus_bob" }] };
    const order = (id: string, customer: string, user: string): Row => ({ id, number: id.toUpperCase(), customer, user, status: "pending", currency: "usd", subtotal: 4500, tax: 900, shipping: 500, total: 5900 });
    const s = await shop({ money, seed: { ...catalogue(), orders: [order("o_ada", "c_ada", "u1"), order("o_bob", "c_bob", "u2")] } });
    // bob pays exactly what his own pending order costs, but the payment names ada's
    await s.webhook("checkout.session.completed", { id: "cs_9", customer: "cus_bob", mode: "payment", payment_intent: "pi_9", payment_status: "paid", amount_total: 5900, currency: "usd", metadata: { voidbase_order: "o_ada" } });
    expect(s.tables.orders.map((o) => [o.id, o.status])).toEqual([["o_ada", "pending"], ["o_bob", "pending"]]);
    const row = s.tables.commerce_audit.find((r) => r.action === "order.payment_unmatched")!;
    expect(row).toMatchObject({ actor: "payments:stripe", subject: "order:o_ada" });
    expect(row.detail).toMatchObject({ reference: "o_ada", customer: "c_bob", amount: 5900, status: "succeeded" });
    expect(String((row.detail as Row).reason)).toContain("another customer's");
    expect(s.audit()).toEqual(["order.payment_unmatched"]);
    // and bob's failed payment naming ada's order cancels neither: a failure cancels only a pending order of the payer's
    await s.webhook("payment_intent.payment_failed", { id: "pi_10", customer: "cus_bob", amount: 5900, currency: "usd", metadata: { voidbase_order: "o_ada" } });
    expect(s.tables.orders.map((o) => [o.id, o.status])).toEqual([["o_ada", "pending"], ["o_bob", "pending"]]);
    expect(s.tables.commerce_audit.map((r) => [r.action, (r.detail as Row).status])).toEqual([["order.payment_unmatched", "succeeded"], ["order.payment_unmatched", "failed"]]);
  });

  test("a payment that names its order but is not its total in its currency leaves it pending, whoever started it, and the audit trail says what was paid against what was owed", async () => {
    const s = await readyToPay();
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(s.tables.orders[0]).toMatchObject({ id: "orders_1", status: "pending", total: 9740, currency: "usd" });
    // a name is not proof: any plugin calling payments@1 can give one, here for a sticker of 100, naming ada's order
    await s.payments().checkout(s.env, { customer: "cus_1", items: [{ price: "price_sticker", quantity: 1 }], success: "https://a", cancel: "https://b", reference: "orders_1" });
    expect(s.calls.filter((c) => c.url.endsWith("/v1/checkout/sessions"))[1]!.body.get("metadata[voidbase_order]")).toBe("orders_1");
    // Stripe tells of that session and of its payment intent, 100 each time, and then of the whole total in euros
    const named = { customer: "cus_1", currency: "usd", metadata: { voidbase_order: "orders_1" } };
    await s.webhook("checkout.session.completed", { id: "cs_9", mode: "payment", payment_intent: "pi_9", payment_status: "paid", amount_total: 100, ...named });
    await s.webhook("payment_intent.succeeded", { id: "pi_9", amount: 100, ...named });
    await s.webhook("payment_intent.succeeded", { id: "pi_10", amount: 9740, ...named, currency: "eur" });
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.orders[0]!.payment).toBeUndefined();
    expect(s.audit()).not.toContain("order.paid");
    const unmatched = s.tables.commerce_audit.filter((r) => r.action === "order.payment_unmatched");
    expect(unmatched.map((r) => [r.subject, (r.detail as Row).payment, (r.detail as Row).amount, (r.detail as Row).currency])).toEqual([["order:orders_1", "pay_1", 100, "usd"], ["order:orders_1", "pay_2", 9740, "eur"]]);
    for (const r of unmatched) expect((r.detail as Row).owed).toEqual([{ order: "orders_1", total: 9740, currency: "usd" }]);
    expect((unmatched[0]!.detail as Row).reason).toBe(`it names order "orders_1" and pays 100 usd, where the order's total is 9740 usd`);
    // the total in the order's currency pays it, however the provider writes the currency
    await s.webhook("payment_intent.succeeded", { id: "pi_11", amount: 9740, ...named, currency: "USD" });
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_3" });
  });

  test("a payment that has moved its order never looks for another: a failure told after its success cancels no second order of the same total, whichever order it names, and is said once", async () => {
    const s = await readyToPay({ seed: { ...catalogue(), inventory: [{ id: "i1", variant: "v1", onHand: 10, reserved: 0 }] } });
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    await s.post(`${API}/cart/items`, { variant: "v1", quantity: 2 });
    await s.post(`${API}/cart/items`, { variant: "v2", quantity: 1 });
    await s.post(`${API}/cart/address`, { address: ADDRESS });
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 4 });
    // the payment intent names the older of the two orders and pays it
    const intent = { id: "pi_1", customer: "cus_1", amount: 9740, currency: "usd" };
    const naming = (order: string) => ({ ...intent, metadata: { voidbase_order: order } });
    await s.webhook("payment_intent.succeeded", naming("orders_1"));
    expect(s.tables.orders.map((o) => [o.id, o.status, o.payment])).toEqual([["orders_1", "paid", "pay_1"], ["orders_2", "pending", undefined]]);
    // then Stripe tells of a failure of that same payment intent twice, the second time naming the other pending order
    // of the same total (as any payments@1 caller could have it), and of its success once more
    await s.webhook("payment_intent.payment_failed", naming("orders_1"));
    await s.webhook("payment_intent.payment_failed", naming("orders_2"));
    await s.webhook("payment_intent.succeeded", naming("orders_1"));
    expect(s.tables.orders.map((o) => [o.id, o.status, o.payment])).toEqual([["orders_1", "paid", "pay_1"], ["orders_2", "pending", undefined]]);
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 4 });
    expect(s.audit().filter((a) => a.startsWith("order.") && a !== "order.placed")).toEqual(["order.paid", "order.payment_contradicted"]);
    const row = s.tables.commerce_audit.find((r) => r.action === "order.payment_contradicted")!;
    expect(row).toMatchObject({ actor: "payments:stripe", subject: "order:orders_1", detail: { payment: "pay_1", status: "failed", orderStatus: "paid" } });
    expect(String((row.detail as Row).reason)).toContain("now says it failed");
  });

  test("a subscription's money is not an order's: invoices that cost exactly what a pending order costs move nothing and write no audit row", async () => {
    const s = await readyToPay();
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    const before = s.audit();
    // Stripe's invoices for 9740, naming no order: for a subscription the rows know, for one they do not know yet
    // (only the invoice's parent says so), and one that says only that it is an invoice
    await s.webhook("customer.subscription.created", { id: "sub_1", customer: "cus_1", status: "active", items: { data: [{ price: { id: "price_plan" }, current_period_end: T + 86400 }] } });
    await s.webhook("invoice.paid", { id: "in_1", customer: "cus_1", amount_paid: 9740, currency: "usd", subscription: "sub_1", payment_intent: "pi_in_1" });
    await s.webhook("invoice.paid", { id: "in_2", customer: "cus_1", amount_paid: 9740, currency: "usd", parent: { subscription_details: { subscription: "sub_9" } }, payments: { data: [{ payment: { payment_intent: "pi_in_2" } }] } });
    await s.webhook("invoice.payment_failed", { id: "in_3", object: "invoice", customer: "cus_1", amount_due: 9740, currency: "usd", payment_intent: "pi_in_3" });
    expect(s.money.tables.payments.map((p) => [p.providerId, p.status, p.subscription])).toEqual([["pi_in_1", "succeeded", "sub_1"], ["pi_in_2", "succeeded", undefined], ["pi_in_3", "failed", undefined]]);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.orders[0]!.payment).toBeUndefined();
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 2 });
    expect(s.audit()).toEqual(before);
  });

  test("a payment whose decline cancelled its order and which then succeeds on a retry brings the order back: its stock reserved again, or oversold and said so", async () => {
    const declined = async (o: { taken?: number; amount?: number } = {}) => {
      const s = await readyToPay();
      await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
      const named = { id: "pi_1", customer: "cus_1", amount: 9740, currency: "usd", metadata: { voidbase_order: "orders_1" } };
      // the card is declined: the order is cancelled and its two kettles go back on the shelf
      await s.webhook("payment_intent.payment_failed", named);
      expect(s.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_1" });
      expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 0 });
      // somebody else may reserve kettles meanwhile; then the buyer tries another card on the same session, and it goes
      if (o.taken) s.tables.inventory[0]!.reserved = o.taken;
      await s.webhook("payment_intent.succeeded", { ...named, amount: o.amount ?? named.amount });
      return s;
    };

    const s = await declined();
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    expect(s.tables.commerce_audit.at(-1)).toMatchObject({ action: "order.paid", actor: "payments:stripe", subject: "order:orders_1", detail: { payment: "pay_1", amount: 9740, reference: "orders_1", revived: true } });
    // and the session's own telling of the same success changes nothing more
    await s.webhook("checkout.session.completed", { id: "cs_1", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 9740, currency: "usd", metadata: { voidbase_order: "orders_1" } });
    expect(s.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.payment_failed", "order.paid"]);
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 2 });

    // the money is captured, so an order whose kettles went to somebody else is paid all the same, and said to be oversold
    const t = await declined({ taken: 2 });
    expect(t.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(t.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 4 });
    expect(t.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.payment_failed", "order.paid", "order.oversold"]);
    expect(t.tables.commerce_audit.at(-1)).toMatchObject({ actor: "payments:stripe", subject: "order:orders_1", detail: { payment: "pay_1", variants: [{ variant: "v1", sku: "KET-1", quantity: 2, available: 1 }] } });

    // a success that is not the order's total brings nothing back: the order stays cancelled, and that is said
    const u = await declined({ amount: 100 });
    expect(u.tables.orders[0]).toMatchObject({ status: "cancelled" });
    expect(u.tables.inventory[0]).toMatchObject({ reserved: 0 });
    expect(u.tables.commerce_audit.at(-1)).toMatchObject({ action: "order.payment_contradicted", subject: "order:orders_1", detail: { payment: "pay_1", amount: 100, status: "succeeded", orderStatus: "cancelled" } });
  });

  test("a payment that names no order never pays, cancels or revives one, whatever it costs, and writes no audit row", async () => {
    const s = await readyToPay();
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(s.tables.orders[0]).toMatchObject({ id: "orders_1", status: "pending", total: 9740 });
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 2 });
    const placed = s.audit();
    // exactly the order's total from the order's own customer, naming nothing: a purchase on Stripe's own route, say.
    // Stripe tells of a payment intent that succeeded, of one that failed, and of a session with no order in its metadata
    await s.webhook("payment_intent.succeeded", { id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 9740, currency: "usd", metadata: {} });
    await s.webhook("payment_intent.payment_failed", { id: "pi_2", object: "payment_intent", customer: "cus_1", amount: 9740, currency: "usd", metadata: {} });
    await s.webhook("checkout.session.completed", { id: "cs_3", object: "checkout.session", customer: "cus_1", mode: "payment", payment_intent: "pi_3", payment_status: "paid", amount_total: 9740, currency: "usd", metadata: { voidbase_customer: "cus_1" } });
    expect(s.money.tables.payments.map((p) => [p.providerId, p.status])).toEqual([["pi_1", "succeeded"], ["pi_2", "failed"], ["pi_3", "succeeded"]]);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.orders[0]!.payment).toBeUndefined();
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    expect(s.audit()).toEqual(placed);

    // and the payment whose failure named the order and cancelled it brings nothing back by succeeding without the name
    const intent = { id: "pi_4", object: "payment_intent", customer: "cus_1", amount: 9740, currency: "usd" };
    await s.webhook("payment_intent.payment_failed", { ...intent, metadata: { voidbase_order: "orders_1" } });
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_4" });
    const cancelled = s.audit();
    await s.webhook("payment_intent.succeeded", { ...intent, metadata: {} });
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_4" });
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 0 });
    expect(s.audit()).toEqual(cancelled);
  });

  test("a subscription invoice's payment intent pays no order, told before invoice.paid or after it, and the subscription filter only keeps such money out of the log", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => undefined);
    const said = () => info.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("voidbase: commerce"));
    try {
      // A1: Stripe pays the subscription's first invoice with a payment intent that carries no metadata and no mark of
      // the subscription, and tells of it first; then of the subscription, and of invoice.paid on the same row
      const a = await readyToPay();
      await a.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
      const placed = a.audit();
      info.mockClear();
      await a.webhook("payment_intent.succeeded", { id: "pi_sub_1", object: "payment_intent", customer: "cus_1", amount: 9740, currency: "usd", description: "Subscription creation", metadata: {} });
      expect(a.tables.orders[0]).toMatchObject({ status: "pending" });
      // the filter cannot see it; that it names no order is what leaves the order alone, and a log line says so
      expect(said()).toEqual(["voidbase: commerce saw a payment that names no order and left the orders alone"]);
      info.mockClear();
      await a.webhook("customer.subscription.created", { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", items: { data: [{ price: { id: "price_plan" }, current_period_end: T + 86400 }] } });
      await a.webhook("invoice.paid", { id: "in_1", object: "invoice", customer: "cus_1", amount_paid: 9740, currency: "usd", parent: { subscription_details: { subscription: "sub_1" } }, payments: { data: [{ payment: { payment_intent: "pi_sub_1" } }] } });
      expect(a.money.tables.payments.map((p) => [p.providerId, p.status, p.subscription])).toEqual([["pi_sub_1", "succeeded", "sub_1"]]);
      // the invoice is subscription money, which the filter keeps out of the log altogether
      expect(said()).toEqual([]);
      expect(a.tables.orders[0]).toMatchObject({ status: "pending" });
      expect(a.tables.orders[0]!.payment).toBeUndefined();
      expect(a.tables.inventory[0]).toMatchObject({ reserved: 2 });
      expect(a.audit()).toEqual(placed);

      // A2: the invoice first, keyed on its payment intent, for a subscription the rows do not know yet (the filter
      // sees an invoice); then the payment intent's own event on that row puts itself in `raw` in the invoice's place,
      // and nothing on the row says subscription any more. A renewal that fails, and then one that succeeds
      const b = await readyToPay();
      await b.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
      const pending = b.audit();
      const invoice = { id: "in_2", object: "invoice", customer: "cus_1", currency: "usd", parent: { subscription_details: { subscription: "sub_9" } }, payments: { data: [{ payment: { payment_intent: "pi_in_2" } }] } };
      const intent = { id: "pi_in_2", object: "payment_intent", customer: "cus_1", amount: 9740, currency: "usd", description: "Subscription update", metadata: {} };
      await b.webhook("invoice.payment_failed", { ...invoice, amount_due: 9740 });
      await b.webhook("payment_intent.payment_failed", intent);
      expect(b.tables.orders[0]).toMatchObject({ status: "pending" });
      expect(b.tables.inventory[0]).toMatchObject({ reserved: 2 });
      await b.webhook("invoice.paid", { ...invoice, amount_paid: 9740 });
      await b.webhook("payment_intent.succeeded", intent);
      expect(b.money.tables.payments.map((p) => [p.providerId, p.status, p.subscription, (p.raw as Row).object])).toEqual([["pi_in_2", "succeeded", undefined, "payment_intent"]]);
      expect(b.tables.orders[0]).toMatchObject({ status: "pending" });
      expect(b.tables.orders[0]!.payment).toBeUndefined();
      expect(b.tables.inventory[0]).toMatchObject({ reserved: 2 });
      expect(b.audit()).toEqual(pending);
    } finally { info.mockRestore(); }
  });

  test("a Lemon Squeezy order that names no order, such as a subscription's first order, pays no pending order of the same total; the order's own purchase does", async () => {
    const s = await merchantOfRecordOrder("lemonsqueezy");
    const placed = s.audit();
    const order = (id: string, o: Row = {}) => ({ type: "orders", id, attributes: { store_id: 1, customer_id: 7, user_email: "ada@b.test", currency: "USD", subtotal: 10000, discount_total: 0, tax: 0, tax_inclusive: false, total: 10000, status: "paid", refunded: false, first_order_item: { variant_id: 555, product_name: "Pro plan", quantity: 1 }, ...o } });
    // B: the buyer subscribes to a 10000 plan through Lemon Squeezy's own route: its custom data carries the user and
    // the customers row, and no order
    expect((await s.lsHook("order_created", order("900"), { voidbase_customer: "cus_1", voidbase_user: "u1" })).status).toBe(200);
    expect(s.money.tables.payments.map((p) => [p.providerId, p.customer, p.amount, p.status])).toEqual([["order_900", "cus_1", 10000, "succeeded"]]);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.orders[0]!.payment).toBeUndefined();
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 1 });
    expect(s.audit()).toEqual(placed);
    // the order's own purchase names it, and pays it
    await s.lsHook("order_created", order("901", { first_order_item: { variant_id: 123, quantity: 1 } }), { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" });
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_2" });
    // and the checkout that order came from named it, and hid the discount code field, which would have paid less
    const checkout = JSON.parse(s.calls.find((c) => c.url.endsWith("/v1/checkouts"))!.raw) as Row;
    expect((checkout.data as Row).attributes).toMatchObject({ checkout_options: { discount: false }, checkout_data: { custom: { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" } } });
  });

  test("a merchant of record's own tax is not the order's: a Polar order pays when what Polar charged before its tax (net_amount) is the order's total, and not when that falls short", async () => {
    const s = await merchantOfRecordOrder("polar");
    // `product_id` is the product the checkout named, which is the steel kettle's `priceId` here
    const paid = (id: string, amounts: Row) => ({
      id, status: "paid", paid: true, billing_reason: "purchase", subscription_id: null, currency: "usd", customer_id: "pcus_1", customer: { id: "pcus_1", email: "ada@b.test", external_id: "u1" },
      product_id: "123", metadata: { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" }, ...amounts,
    });
    // the product costs 9000 at Polar and not the 10000 the variant says here, and Polar adds 8% on top: 9720
    await s.polarHook("order.paid", paid("po_1", { subtotal_amount: 9000, discount_amount: 0, net_amount: 9000, tax_amount: 720, total_amount: 9720 }));
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    const short = s.tables.commerce_audit.find((r) => r.action === "order.payment_unmatched")!;
    expect(short.detail).toMatchObject({ provider: "polar", payment: "pay_1", amount: 9720, beforeProviderTax: 9000, currency: "usd", owed: [{ order: "orders_1", total: 10000, currency: "usd" }] });
    expect((short.detail as Row).reason).toBe(`it names order "orders_1" and pays 9000 usd before the provider's own tax (9720 usd with it), where the order's total is 10000 usd`);
    // the order's total, and Polar's 8% on top of it: 10800 charged, of which 10000 is the order's
    await s.polarHook("order.paid", paid("po_2", { subtotal_amount: 10000, discount_amount: 0, net_amount: 10000, tax_amount: 800, total_amount: 10800 }));
    expect(s.money.tables.payments.map((p) => [p.providerId, p.amount])).toEqual([["po_1", 9720], ["po_2", 10800]]);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_2" });
    expect(s.tables.commerce_audit.find((r) => r.action === "order.paid")!.detail).toMatchObject({ provider: "polar", payment: "pay_2", amount: 10800, beforeProviderTax: 10000, currency: "usd", reference: "orders_1" });
  });

  test("a Lemon Squeezy order pays when its total less the tax Lemon Squeezy added is the order's total, and not when that falls short", async () => {
    const s = await merchantOfRecordOrder("lemonsqueezy");
    const named = { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" };
    const order = (id: string, a: Row) => ({ type: "orders", id, attributes: { store_id: 1, customer_id: 7, user_email: "ada@b.test", currency: "USD", status: "paid", refunded: false, discount_total: 0, tax_inclusive: false, first_order_item: { variant_id: 123, quantity: 1 }, ...a } });
    // the variant costs 9000 at Lemon Squeezy, with 20% on top: 10800, of which 9000 is short of the order's 10000
    await s.lsHook("order_created", order("55", { subtotal: 9000, tax: 1800, total: 10800 }), named);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.commerce_audit.find((r) => r.action === "order.payment_unmatched")!.detail).toMatchObject({ provider: "lemonsqueezy", payment: "pay_1", amount: 10800, beforeProviderTax: 9000, currency: "USD" });
    // the order's total with Lemon Squeezy's 20% added: total = subtotal + tax, and tax_inclusive false
    await s.lsHook("order_created", order("56", { subtotal: 10000, tax: 2000, total: 12000 }), named);
    expect(s.money.tables.payments.map((p) => [p.providerId, p.amount])).toEqual([["order_55", 10800], ["order_56", 12000]]);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_2" });
    expect(s.tables.commerce_audit.find((r) => r.action === "order.paid")!.detail).toMatchObject({ provider: "lemonsqueezy", payment: "pay_2", amount: 12000, beforeProviderTax: 10000, currency: "USD", reference: "orders_1" });
  });

  test("the Polar prices commerce charges are tax-exclusive: a price that held its tax, so that net_amount is below it and total_amount is the order's total, leaves the order pending with both amounts said, unless what Polar sent says tax_behavior inclusive", async () => {
    const s = await merchantOfRecordOrder("polar");
    const paid = (o: Row = {}) => ({
      id: "po_1", status: "paid", paid: true, billing_reason: "purchase", subscription_id: null, currency: "usd", customer_id: "pcus_1", customer: { id: "pcus_1", email: "ada@b.test", external_id: "u1" },
      product_id: "123", metadata: { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" }, subtotal_amount: 8333, discount_amount: 0, net_amount: 8333, tax_amount: 1667, total_amount: 10000, ...o,
    });
    // the product costs 10000 at Polar with the tax inside it, and Polar's order says nothing of how the price was taxed
    await s.polarHook("order.paid", paid());
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.orders[0]!.payment).toBeUndefined();
    const note = s.tables.commerce_audit.find((r) => r.action === "order.payment_unmatched")!;
    expect(note.detail).toMatchObject({ provider: "polar", payment: "pay_1", amount: 10000, beforeProviderTax: 8333, currency: "usd", owed: [{ order: "orders_1", total: 10000, currency: "usd" }] });
    expect((note.detail as Row).reason).toBe(`it names order "orders_1" and pays 8333 usd before the provider's own tax (10000 usd with it), where the order's total is 10000 usd`);
    // the same payment told with tax_behavior inclusive, as a checkout's shape carries it: the price held the tax, so
    // the total is what the checkout asked for
    await s.polarHook("order.paid", paid({ tax_behavior: "inclusive" }));
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.commerce_audit.find((r) => r.action === "order.paid")!.detail).toMatchObject({ provider: "polar", payment: "pay_1", amount: 10000, currency: "usd", reference: "orders_1" });
  });

  test("a merchant of record's payment whose figure before its tax cannot be read pays no order: a Polar order with no net_amount, a Lemon Squeezy tax that is not a number", async () => {
    // Polar's tax_amount and total_amount with no net_amount, where total_amount (Polar's tax in it) is the order's total
    const polar = await merchantOfRecordOrder("polar");
    await polar.polarHook("order.paid", {
      id: "po_nonet", status: "paid", paid: true, billing_reason: "purchase", subscription_id: null, currency: "USD", customer_id: "pcus_1", customer: { id: "pcus_1", email: "ada@b.test", external_id: "u1" },
      product_id: "123", metadata: { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" }, subtotal_amount: 9260, discount_amount: 0, tax_amount: 740, total_amount: 10000,
    });
    // Lemon Squeezy's tax as a string beside a total of the order's total, with tax_inclusive left out
    const lemon = await merchantOfRecordOrder("lemonsqueezy");
    await lemon.lsHook("order_created", { type: "orders", id: "57", attributes: { store_id: 1, customer_id: 7, user_email: "ada@b.test", currency: "USD", subtotal: 8333, tax: "1667", total: 10000, status: "paid", refunded: false, first_order_item: { variant_id: 123, quantity: 1 } } }, { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" });
    for (const s of [polar, lemon]) {
      expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
      expect(s.tables.inventory[0]).toMatchObject({ reserved: 1 });
      expect(s.audit()).not.toContain("order.paid");
      const note = s.tables.commerce_audit.find((r) => r.action === "order.payment_unmatched")!;
      expect(note.detail).toMatchObject({ payment: "pay_1", amount: 10000, beforeProviderTax: null, currency: "USD", owed: [{ order: "orders_1", total: 10000, currency: "usd" }] });
      expect((note.detail as Row).reason).toBe(`it names order "orders_1" and pays 10000 USD with the provider's own tax (what it charged before that tax cannot be read), where the order's total is 10000 usd`);
    }
  });

  test("a failure moves no money, so it cancels the pending order it names and releases the stock whatever amount it names; the same payment's success still has to be the whole total", async () => {
    const s = await readyToPay();
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 2 });
    // Stripe says the payment intent failed for 100 in euros: neither is the order's 9740 usd, and nothing was taken
    const named = { id: "pi_1", object: "payment_intent", customer: "cus_1", metadata: { voidbase_order: "orders_1" } };
    await s.webhook("payment_intent.payment_failed", { ...named, amount: 100, currency: "eur" });
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_1" });
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 0 });
    expect(s.tables.commerce_audit.at(-1)).toMatchObject({ action: "order.payment_failed", actor: "payments:stripe", subject: "order:orders_1", detail: { payment: "pay_1", amount: 100, currency: "eur", reference: "orders_1" } });
    // that payment succeeding for that amount brings nothing back
    await s.webhook("payment_intent.succeeded", { ...named, amount: 100, currency: "eur" });
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled" });
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 0 });
    expect(s.audit().at(-1)).toBe("order.payment_contradicted");
    // and succeeding for the order's whole total in its currency does
    await s.webhook("payment_intent.succeeded", { ...named, amount: 9740, currency: "usd" });
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 2 });
    expect(s.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.payment_failed", "order.payment_contradicted", "order.paid"]);
  });

  test("an order brought back is finished by the provider's retry whichever write failed: its lines reserved again once, never twice and never short, and one order.paid row", async () => {
    // the order the decline cancelled holds two kettles of five on hand, and a second pending order holds one more
    const retried = async (failing: (collection: CommerceCollection, values: Row) => boolean) => {
      const s = await kettles(2, { seed: { ...catalogue(), inventory: [{ id: "i1", variant: "v1", onHand: 5, reserved: 0 }] } });
      const named = { id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } };
      await s.webhook("payment_intent.payment_failed", named);
      await s.post(`${API}/cart/items`, { variant: "v1", quantity: 1 });
      await s.post(`${API}/cart/address`, { address: ADDRESS });
      expect((await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" })).status).toBe(200);
      expect(s.tables.inventory[0]).toMatchObject({ onHand: 5, reserved: 1 });
      // one write of bringing the order back fails, once: the webhook answers 500, and Stripe delivers the success again
      breakOnce(s, failing);
      expect((await s.webhook("payment_intent.succeeded", named)).status).toBe(500);
      expect((await s.webhook("payment_intent.succeeded", named)).status).toBe(200);
      // and the session's telling of the same success, after it, writes nothing more
      await s.webhook("checkout.session.completed", { id: "cs_1", object: "checkout.session", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } });
      return s;
    };
    const cases: { write: string; failing: (collection: CommerceCollection, values: Row) => boolean }[] = [
      { write: "the claim on the order", failing: (collection, values) => collection === "orders" && values.status === "paid" },
      { write: "a line's stock", failing: (collection) => collection === "inventory" },
      { write: "the order.paid row", failing: (collection, values) => collection === "commerce_audit" && values.action === "order.paid" },
    ];
    for (const { write, failing } of cases) {
      const s = await retried(failing), said = `${write} failed`;
      expect([said, s.tables.orders.map((o) => [o.id, o.status, o.payment])]).toEqual([said, [["orders_1", "paid", "pay_1"], ["orders_2", "pending", undefined]]]);
      // the retry finished what was left: the two kettles are reserved again, once, and the other order still holds one
      expect([said, s.tables.inventory[0]!.reserved]).toEqual([said, 3]);
      expect([said, s.audit().filter((x) => x.startsWith("order."))]).toEqual([said, ["order.placed", "order.payment_failed", "order.placed", "order.paid"]]);
      expect([said, s.tables.commerce_audit.filter((r) => r.action === "order.paid").map((r) => (r.detail as Row).revived)]).toEqual([said, [true]]);
      // the steps are one per line and payment: released when it was cancelled, reserved again when it came back
      expect([said, s.tables.commerce_audit.filter((r) => String(r.action).startsWith("stock.")).map((r) => [r.action, (r.detail as Row).payment, (r.detail as Row).quantity])])
        .toEqual([said, [["stock.released", "pay_1", 2], ["stock.reserved", "pay_1", 2]]]);
      // and fulfilling it takes its two off the shelf and off the reservation, leaving the other order's one
      s.as(admin);
      expect((await s.post(`${API}/orders/orders_1/fulfil`, {})).status).toBe(200);
      expect([said, s.tables.inventory[0]!.onHand, s.tables.inventory[0]!.reserved]).toEqual([said, 3, 1]);
    }
  });

  test("an order a payments@1 caller's declined payment cancelled comes back when the order's own payment then succeeds: paid once, its stock reserved once", async () => {
    const s = await kettles(2);
    expect(s.tables.orders[0]).toMatchObject({ id: "orders_1", status: "pending", total: 5000 });
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    // a plugin calling payments@1 starts a checkout for a 100 sticker that names the order, and the card is declined: a
    // failure cancels the pending order it names whatever it was for
    await s.payments().checkout(s.env, { customer: "cus_1", items: [{ price: "price_sticker", quantity: 1 }], success: "https://a", reference: "orders_1" });
    await s.webhook("payment_intent.payment_failed", { id: "pi_sticker", object: "payment_intent", customer: "cus_1", amount: 100, currency: "usd", metadata: { voidbase_order: "orders_1" } });
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_1" });
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 0 });
    // then the order's own checkout is paid in full, and Stripe tells of its session and of its payment intent
    const own = { customer: "cus_1", currency: "usd", metadata: { voidbase_order: "orders_1" } };
    await s.webhook("checkout.session.completed", { id: "cs_order", object: "checkout.session", mode: "payment", payment_intent: "pi_order", payment_status: "paid", amount_total: 5000, ...own });
    await s.webhook("payment_intent.succeeded", { id: "pi_order", object: "payment_intent", amount: 5000, ...own });
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_2" });
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    expect(s.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.payment_failed", "order.paid"]);
    expect(s.tables.commerce_audit.at(-1)).toMatchObject({ action: "order.paid", actor: "payments:stripe", subject: "order:orders_1", detail: { payment: "pay_2", amount: 5000, reference: "orders_1", revived: true } });

    // an order a refused checkout cancelled was moved last by that refusal and not by a failed payment, so a payment
    // of its whole total brings it back no more than one that is short
    const refused = await shop({ auth: ada, flat: true, answers: { "POST /v1/customers": { id: "cus_1" } } });
    await refused.post(`${API}/cart/items`, { variant: "v1", quantity: 2 });
    await refused.post(`${API}/cart/address`, { address: ADDRESS });
    expect((await refused.post(`${API}/checkout`, { success: "https://a" })).status).toBe(502);
    expect(refused.tables.orders[0]).toMatchObject({ id: "orders_1", status: "cancelled", total: 5000 });
    await refused.webhook("payment_intent.succeeded", { id: "pi_x", object: "payment_intent", amount: 5000, ...own });
    expect(refused.tables.orders[0]).toMatchObject({ status: "cancelled" });
    expect(refused.tables.inventory[0]).toMatchObject({ reserved: 0 });
    const note = refused.tables.commerce_audit.at(-1)!;
    expect(note).toMatchObject({ action: "order.payment_unmatched", subject: "order:orders_1", detail: { payment: "pay_1", amount: 5000, status: "succeeded" } });
    expect(String((note.detail as Row).reason)).toContain("order.checkout_failed");
  });

  test("a failure claims its order before it releases a line: a retry after that claim's write failed releases the order's own stock once and never another pending order's, and a failure after the claim leaves stock reserved rather than release it twice", async () => {
    const s = await kettles(2);
    await s.post(`${API}/cart/items`, { variant: "v1", quantity: 1 });
    await s.post(`${API}/cart/address`, { address: ADDRESS });
    expect((await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" })).status).toBe(200);
    expect(s.tables.orders.map((o) => [o.id, o.status, o.total])).toEqual([["orders_1", "pending", 5000], ["orders_2", "pending", 2500]]);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 3 });
    const failed = (id: string, order: string) => ({ id, object: "payment_intent", customer: "cus_1", amount: 5000, currency: "usd", metadata: { voidbase_order: order } });

    // marking the first order cancelled fails once: the webhook answers 500, and Stripe delivers the failure again
    breakOnce(s, (collection, values) => collection === "orders" && values.status === "cancelled");
    expect((await s.webhook("payment_intent.payment_failed", failed("pi_1", "orders_1"))).status).toBe(500);
    expect((await s.webhook("payment_intent.payment_failed", failed("pi_1", "orders_1"))).status).toBe(200);
    expect(s.tables.orders.map((o) => [o.id, o.status])).toEqual([["orders_1", "cancelled"], ["orders_2", "pending"]]);
    // its two kettles went back once, and the second order still holds its one
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 1 });
    expect(s.tables.commerce_audit.filter((r) => r.action === "order.payment_failed").map((r) => r.subject)).toEqual(["order:orders_1"]);

    // releasing the second order's kettle fails once, after its claim: the retry finds it cancelled by that payment,
    // finishes the release its first attempt left, once, and writes the order.payment_failed row it lacked
    breakOnce(s, (collection) => collection === "inventory");
    expect((await s.webhook("payment_intent.payment_failed", failed("pi_2", "orders_2"))).status).toBe(500);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 1 });
    expect((await s.webhook("payment_intent.payment_failed", failed("pi_2", "orders_2"))).status).toBe(200);
    expect(s.tables.orders.map((o) => [o.id, o.status, o.payment])).toEqual([["orders_1", "cancelled", "pay_1"], ["orders_2", "cancelled", "pay_2"]]);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 0 });
    expect(s.tables.commerce_audit.filter((r) => r.action === "order.payment_failed").map((r) => r.subject)).toEqual(["order:orders_1", "order:orders_2"]);
    // and each order's lines were released once, by whichever telling of the failure got to them
    expect(s.tables.commerce_audit.filter((r) => r.action === "stock.released").map((r) => [r.subject, (r.detail as Row).quantity])).toEqual([["order:orders_1", 2], ["order:orders_2", 1]]);
  });

  test("a move whose audit row failed to write gets that row from the provider's retry, once: a success's order.paid and a failure's order.payment_failed", async () => {
    const intent = { id: "pi_1", object: "payment_intent", customer: "cus_1", currency: "usd", metadata: { voidbase_order: "orders_1" } };
    const s = await kettles(2);
    breakOnce(s, (collection, values) => collection === "commerce_audit" && values.action === "order.paid");
    expect((await s.webhook("payment_intent.succeeded", { ...intent, amount: 5000 })).status).toBe(500);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect((await s.webhook("payment_intent.succeeded", { ...intent, amount: 5000 })).status).toBe(200);
    // and the session's telling of the same success after it writes nothing more
    await s.webhook("checkout.session.completed", { ...intent, id: "cs_1", object: "checkout.session", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 5000 });
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.commerce_audit.filter((r) => String(r.action).startsWith("order.")).map((r) => [r.action, (r.detail as Row).payment ?? "", (r.detail as Row).revived ?? false])).toEqual([["order.placed", "", false], ["order.paid", "pay_1", false]]);
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 2 });

    const f = await kettles(2);
    breakOnce(f, (collection, values) => collection === "commerce_audit" && values.action === "order.payment_failed");
    expect((await f.webhook("payment_intent.payment_failed", { ...intent, amount: 5000 })).status).toBe(500);
    expect((await f.webhook("payment_intent.payment_failed", { ...intent, amount: 5000 })).status).toBe(200);
    await f.webhook("payment_intent.payment_failed", { ...intent, amount: 5000 });
    expect(f.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_1" });
    expect(f.tables.inventory[0]).toMatchObject({ reserved: 0 });
    expect(f.tables.commerce_audit.filter((r) => String(r.action).startsWith("order.")).map((r) => [r.action, (r.detail as Row).payment ?? ""])).toEqual([["order.placed", ""], ["order.payment_failed", "pay_1"]]);

    // the row a revived order's retry writes says it was revived
    const r = await kettles(2);
    await r.webhook("payment_intent.payment_failed", { ...intent, amount: 5000 });
    breakOnce(r, (collection, values) => collection === "commerce_audit" && values.action === "order.paid");
    expect((await r.webhook("payment_intent.succeeded", { ...intent, amount: 5000 })).status).toBe(500);
    expect((await r.webhook("payment_intent.succeeded", { ...intent, amount: 5000 })).status).toBe(200);
    expect(r.tables.commerce_audit.filter((x) => x.action === "order.paid").map((x) => (x.detail as Row).revived)).toEqual([true]);
  });

  test("two deliveries of one success at once, as Stripe sends a session and its payment intent, move the order once: one order.paid row, and a revived order's stock reserved once", async () => {
    const intent = { id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } };
    const session = { id: "cs_1", object: "checkout.session", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } };
    const moves = (s: Awaited<ReturnType<typeof shop>>) => s.tables.commerce_audit.filter((r) => String(r.action).startsWith("order.")).map((r) => [r.action, (r.detail as Row).revived ?? false]);

    // a pending order: both requests read it pending, and only one claim moves it
    const s = await kettles(2, { slow: true });
    const both = await Promise.all([s.webhook("checkout.session.completed", session), s.webhook("payment_intent.succeeded", intent)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(s.money.tables.payments).toHaveLength(1);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(moves(s)).toEqual([["order.placed", false], ["order.paid", false]]);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });

    // an order its decline cancelled, and the retry's success told twice at once: one revive, one reservation
    const t = await kettles(2, { slow: true });
    await t.webhook("payment_intent.payment_failed", intent);
    expect(t.tables.inventory[0]).toMatchObject({ reserved: 0 });
    const again = await Promise.all([t.webhook("checkout.session.completed", session), t.webhook("payment_intent.succeeded", intent)]);
    expect(again.map((r) => r.status)).toEqual([200, 200]);
    expect(t.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(moves(t)).toEqual([["order.placed", false], ["order.payment_failed", false], ["order.paid", true]]);
    expect(t.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
  });

  test("a payment pays or brings back the order it names only when it bought what that order is, where the provider says what was bought", async () => {
    // At Lemon Squeezy any checkout URL takes ?checkout[custom][voidbase_order]=, which comes back as the webhook's
    // custom data, so a buyer can name somebody's pending order on an order of their own: an e-book at the order's
    // price, bought with the same email, was that order's total from that order's customer and paid it
    const s = await merchantOfRecordOrder("lemonsqueezy");
    const named = { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" };
    const order = (id: string, item: Row, a: Row = {}) => ({ type: "orders", id, attributes: { store_id: 1, customer_id: 7, user_email: "ada@b.test", currency: "USD", subtotal: 10000, discount_total: 0, tax: 0, tax_inclusive: false, total: 10000, status: "paid", refunded: false, first_order_item: item, ...a } });
    expect((await s.lsHook("order_created", order("77", { variant_id: 999, product_id: 55, product_name: "E-book", quantity: 1, price: 10000 }), named)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.orders[0]!.payment).toBeUndefined();
    expect(s.tables.inventory[0]).toMatchObject({ variant: "v4", reserved: 1 });
    const note = s.tables.commerce_audit.find((r) => r.action === "order.payment_unmatched")!;
    expect(note.detail).toMatchObject({ payment: "pay_1", amount: 10000, bought: [{ id: "999", quantity: 1 }], ordered: [{ id: "123", quantity: 1 }] });
    expect((note.detail as Row).reason).toBe(`it names order "orders_1" and bought 1 of "999", where the order is 1 of "123"`);
    // a subscription variant's first order, which is an order like any other until subscription_created links it
    expect((await s.lsHook("order_created", order("78", { variant_id: 555, product_name: "Monthly plan", quantity: 1, price: 10000 }), named)).status).toBe(200);
    await s.lsHook("subscription_created", { type: "subscriptions", id: "900", attributes: { store_id: 1, customer_id: 7, order_id: 78, variant_id: 555, user_email: "ada@b.test", status: "active", renews_at: "2026-10-11T00:00:00Z" } }, named);
    // and two of the order's own variant for the price of one is not the order either
    expect((await s.lsHook("order_created", order("79", { variant_id: 123, quantity: 2, price: 5000 }), named)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.commerce_audit.filter((r) => r.action === "order.payment_unmatched").map((r) => (r.detail as Row).payment)).toEqual(["pay_1", "pay_2", "pay_3"]);
    expect(String((s.tables.commerce_audit.at(-1)!.detail as Row).reason)).toContain(`bought 2 of "123", where the order is 1 of "123"`);
    // the order's own variant, once, is what pays it
    expect((await s.lsHook("order_created", order("80", { variant_id: 123, quantity: 1, price: 10000 }), named)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_4" });

    // a cancelled order comes back only for a payment that bought what it is, too
    const t = await merchantOfRecordOrder("lemonsqueezy");
    await t.lsHook("order_created", order("81", { variant_id: 123, quantity: 1, price: 10000 }, { status: "failed" }), named);
    expect(t.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_1" });
    await t.lsHook("order_created", order("82", { variant_id: 999, quantity: 1, price: 10000 }), named);
    expect(t.tables.orders[0]).toMatchObject({ status: "cancelled" });
    expect(String((t.tables.commerce_audit.at(-1)!.detail as Row).reason)).toContain(`bought 1 of "999"`);
    await t.lsHook("order_created", order("83", { variant_id: 123, quantity: 1, price: 10000 }), named);
    expect(t.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_3" });
    expect(t.tables.inventory[0]).toMatchObject({ variant: "v4", reserved: 1 });

    // Polar copies a checkout's metadata onto the order it makes, so an order for another product can name this one
    const p = await merchantOfRecordOrder("polar");
    const polarOrder = (id: string, product: string) => ({
      id, status: "paid", paid: true, billing_reason: "purchase", subscription_id: null, currency: "usd", customer_id: "pcus_1", customer: { id: "pcus_1", email: "ada@b.test", external_id: "u1" },
      product_id: product, metadata: { voidbase_order: "orders_1" }, subtotal_amount: 10000, discount_amount: 0, net_amount: 10000, tax_amount: 0, total_amount: 10000,
    });
    await p.polarHook("order.paid", polarOrder("po_other", "another-product"));
    expect(p.tables.orders[0]).toMatchObject({ status: "pending" });
    expect((p.tables.commerce_audit.find((r) => r.action === "order.payment_unmatched")!.detail as Row).reason).toBe(`it names order "orders_1" and bought 1 of "another-product", where the order is 1 of "123"`);
    await p.polarHook("order.paid", polarOrder("po_own", "123"));
    expect(p.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_2" });
  });

  test("a Lemon Squeezy order exactly as its own docs print it, which carry no quantity, pays the order it names; one for another variant, or for a quantity that is not the line's, does not", async () => {
    // Lemon Squeezy's page for the order object lists first_order_item's fields (id, order_id, product_id, variant_id,
    // product_name, variant_name, price, created_at, updated_at, test_mode) and no quantity, in the attribute list or
    // in the example payload; its own SDK types one, "Not in the documentation, but in the response". So a quantity is
    // compared only where one was reported, and the variant always: an unreadable quantity was no order's line, the
    // webhook answered 200, and a fully paid order stayed pending with only a superuser able to put it right.
    const s = await merchantOfRecordOrder("lemonsqueezy");
    const named = { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" };
    const documented = { id: 1, order_id: 1, product_id: 5, variant_id: 123, product_name: "Kettle, steel", variant_name: "Default", price: 10000, created_at: "2021-08-17T09:45:53.000000Z", updated_at: "2021-08-17T09:45:53.000000Z", test_mode: false };
    const order = (id: string, item: Row) => ({ type: "orders", id, attributes: { store_id: 1, customer_id: 7, user_email: "ada@b.test", currency: "USD", subtotal: 10000, discount_total: 0, tax: 0, tax_inclusive: false, total: 10000, status: "paid", refunded: false, first_order_item: item } });
    // another variant, with no quantity either: the id is what closes the hole a reference a buyer can set opens
    expect((await s.lsHook("order_created", order("77", { ...documented, variant_id: 999 }), named)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(String((s.tables.commerce_audit.at(-1)!.detail as Row).reason)).toBe(`it names order "orders_1" and bought "999", where the order is 1 of "123"`);
    // the order's own variant, at a quantity that is not the order's line's
    expect((await s.lsHook("order_created", order("78", { ...documented, quantity: 2 }), named)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(String((s.tables.commerce_audit.at(-1)!.detail as Row).reason)).toContain(`bought 2 of "123", where the order is 1 of "123"`);
    // and the documented payload itself, quantity and all absent, pays it
    expect((await s.lsHook("order_created", order("79", documented), named)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_3" });
    expect(s.tables.inventory[0]).toMatchObject({ variant: "v4", reserved: 1 });
  });

  test("a declined purchase cancels the order it names only when it bought that order's lines, where the provider says what was bought; where it says nothing, as at Stripe, a decline still cancels", async () => {
    // A failure needs no amount, so the amount is no protection here: at Lemon Squeezy, where any checkout URL takes
    // ?checkout[custom][voidbase_order]=, a declined one-cent purchase of any variant would cancel somebody's pending
    // order and release its stock for them to buy
    const s = await merchantOfRecordOrder("lemonsqueezy");
    const named = { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" };
    const declined = (id: string, item: Row) => ({ type: "orders", id, attributes: { store_id: 1, customer_id: 7, user_email: "ada@b.test", currency: "USD", subtotal: 100, discount_total: 0, tax: 0, tax_inclusive: false, total: 100, status: "failed", refunded: false, first_order_item: item } });
    expect((await s.lsHook("order_created", declined("81", { variant_id: 999, product_name: "Sticker", quantity: 1, price: 100 }), named)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(s.tables.orders[0]!.payment).toBeUndefined();
    expect(s.tables.inventory[0]).toMatchObject({ variant: "v4", reserved: 1 });
    const note = s.tables.commerce_audit.at(-1)!;
    expect(note).toMatchObject({ action: "order.payment_unmatched", subject: "order:orders_1", detail: { payment: "pay_1", status: "failed", bought: [{ id: "999", quantity: 1 }], ordered: [{ id: "123", quantity: 1 }] } });
    expect(String((note.detail as Row).reason)).toBe(`it names order "orders_1" and bought 1 of "999", where the order is 1 of "123"`);
    // the order's own purchase, declined, cancels it and gives the stock back whatever it cost
    expect((await s.lsHook("order_created", declined("82", { variant_id: 123, quantity: 1, price: 100 }), named)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_2" });
    expect(s.tables.inventory[0]).toMatchObject({ variant: "v4", reserved: 0 });
    // and at Stripe, which reports no purchase and whose metadata only the secret key sets, a decline that names the
    // order cancels it as it always did
    const t = await kettles(2);
    expect((await t.webhook("payment_intent.payment_failed", { id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 100, currency: "usd", metadata: { voidbase_order: "orders_1" } })).status).toBe(200);
    expect(t.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_1" });
    expect(t.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 0 });
  });

  test("a Polar order whose product_id is null says what its items say, and reports no purchase at all when they name none, which leaves the reference and the amount to gate it", async () => {
    // Polar's Order.product_id is nullable. An empty list of purchases matched no order, so such an order left a paid
    // order pending; a line item of the 2026-04 document carries a product_price_id and no product, and Polar's own
    // reference is not a buyer's to set (its public checkout update carries no metadata), so nothing is reported and
    // the reference and the amount before tax are what hold it
    const order = (id: string, extra: Row) => ({
      id, status: "paid", paid: true, billing_reason: "purchase", subscription_id: null, currency: "usd", customer_id: "pcus_1",
      customer: { id: "pcus_1", email: "ada@b.test", external_id: "u1" }, product_id: null, metadata: { voidbase_order: "orders_1" },
      subtotal_amount: 10000, discount_amount: 0, net_amount: 10000, tax_amount: 0, total_amount: 10000, ...extra,
    });
    const p = await merchantOfRecordOrder("polar");
    await p.polarHook("order.paid", order("po_items", { items: [{ id: "oi_1", label: "Another product", amount: 10000, tax_amount: 0, proration: false, product_id: "another-product" }] }));
    expect(p.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(String((p.tables.commerce_audit.at(-1)!.detail as Row).reason)).toBe(`it names order "orders_1" and bought 1 of "another-product", where the order is 1 of "123"`);
    const q = await merchantOfRecordOrder("polar");
    await q.polarHook("order.paid", order("po_none", { items: [{ id: "oi_2", label: "Kettle, steel", amount: 10000, tax_amount: 0, proration: false, product_price_id: "price_1" }] }));
    expect(q.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(q.tables.inventory[0]).toMatchObject({ variant: "v4", reserved: 1 });
  });

  test("an order's line is held to the id stored on it and to the one its variant names it by now, so a shop that re-pointed a variant still has its orders paid", async () => {
    const order = (id: string, variant: number) => ({ type: "orders", id, attributes: { store_id: 1, customer_id: 7, user_email: "ada@b.test", currency: "USD", subtotal: 10000, discount_total: 0, tax: 0, tax_inclusive: false, total: 10000, status: "paid", refunded: false, first_order_item: { variant_id: variant, quantity: 1, price: 10000 } } });
    const named = { voidbase_customer: "cus_1", voidbase_user: "u1", voidbase_order: "orders_1" };
    // a line written by 0.9.0-beta.45, before order_items.priceId existed, whose variant is what it was: the id the
    // variant names it by now stands in for the one the checkout sent
    const old = await merchantOfRecordOrder("lemonsqueezy");
    delete old.tables.order_items[0]!.priceId;
    expect((await old.lsHook("order_created", order("90", 123), named)).status).toBe(200);
    expect(old.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    // and a line that stored its own id whose variant has been re-pointed since: the two disagree, either may be what
    // the checkout sent, so either pays it rather than one of them being guessed at
    const moved = await merchantOfRecordOrder("lemonsqueezy");
    moved.tables.variants.find((v) => v.id === "v4")!.priceId = "456";
    expect((await moved.lsHook("order_created", order("91", 456), named)).status).toBe(200);
    expect(moved.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    // what no id can witness: a line from before the field whose variant was re-pointed before the payment came back.
    // Nothing on the order says what its checkout sent, so it stays pending and a superuser matches it by hand
    const lost = await merchantOfRecordOrder("lemonsqueezy");
    delete lost.tables.order_items[0]!.priceId;
    lost.tables.variants.find((v) => v.id === "v4")!.priceId = "456";
    expect((await lost.lsHook("order_created", order("92", 123), named)).status).toBe(200);
    expect(lost.tables.orders[0]).toMatchObject({ status: "pending" });
    expect(String((lost.tables.commerce_audit.at(-1)!.detail as Row).reason)).toContain(`bought 1 of "123", where the order is 1 of "456"`);
  });

  test("a success read between a failure's claim and that failure's order.payment_failed row brings the order back all the same: the order row, cancelled and carrying a payment, is the witness", async () => {
    const intent = { id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } };
    const session = { id: "cs_1", object: "checkout.session", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } };
    /** hold back the first write of `action`, and say when a request is waiting on it: the window itself */
    const holdBack = (s: Awaited<ReturnType<typeof shop>>, action: string) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let waiting = false;
      const held = async (values: Row) => { if (values.action === action && !waiting) { waiting = true; await gate; } };
      const create = s.rows.create.bind(s.rows), createOnce = s.rows.createOnce.bind(s.rows);
      s.rows.create = async (c, v) => { await held(v); return create(c, v); };
      s.rows.createOnce = async (c, v, a) => { await held(v); return createOnce(c, v, a); };
      return { open: () => open(), waiting: () => waiting };
    };
    const settle = () => new Promise((r) => setTimeout(r, 1));

    // the same payment intent: its decline cancels the order and releases its kettles, and the buyer's retry on the
    // same session succeeds before the failure's own row is written
    const s = await kettles(2);
    const row = holdBack(s, "order.payment_failed");
    const failure = s.webhook("payment_intent.payment_failed", intent);
    while (!row.waiting()) await settle();
    const both = await Promise.all([s.webhook("payment_intent.succeeded", intent), s.webhook("checkout.session.completed", session)]);
    row.open();
    expect([(await failure).status, ...both.map((b) => b.status)]).toEqual([200, 200, 200]);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    expect(s.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.paid", "order.payment_failed"]);
    expect(s.tables.commerce_audit.filter((r) => r.action === "order.paid").map((r) => (r.detail as Row).revived)).toEqual([true]);
    expect(s.audit()).not.toContain("order.payment_contradicted");

    // another payment's decline, its row held back the same way, and the order's own payment succeeding in the window
    const t = await kettles(2);
    const other = holdBack(t, "order.payment_failed");
    const declined = t.webhook("payment_intent.payment_failed", { id: "pi_sticker", object: "payment_intent", customer: "cus_1", amount: 100, currency: "usd", metadata: { voidbase_order: "orders_1" } });
    while (!other.waiting()) await settle();
    const own = await t.webhook("payment_intent.succeeded", { id: "pi_order", object: "payment_intent", customer: "cus_1", amount: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } });
    other.open();
    expect([(await declined).status, own.status]).toEqual([200, 200]);
    expect(t.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_2" });
    expect(t.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    expect(t.tables.commerce_audit.filter((r) => r.action === "order.paid").map((r) => [(r.detail as Row).payment, (r.detail as Row).revived, (r.detail as Row).cancelledBy])).toEqual([["pay_2", true, "pay_1"]]);

    // and the release itself held back: the success brings the order back before any release is recorded, so it
    // reserves nothing, and the failure, finding the order paid once its release has landed, reserves the line for
    // that success, once
    const u = await kettles(2);
    const release = holdBack(u, "stock.released");
    const late = u.webhook("payment_intent.payment_failed", intent);
    while (!release.waiting()) await settle();
    const back = await u.webhook("payment_intent.succeeded", intent);
    release.open();
    expect([(await late).status, back.status]).toEqual([200, 200]);
    expect(u.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(u.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    expect(u.tables.commerce_audit.filter((r) => String(r.action).startsWith("stock.")).map((r) => [r.action, (r.detail as Row).quantity])).toEqual([["stock.released", 2], ["stock.reserved", 2]]);
  });

  test("a decline whose release failed after its claim is finished by the provider's retry, and the success that then brings the order back reserves its lines once", async () => {
    const s = await kettles(2);
    const intent = { id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } };
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    // the release throws once, after the claim: the order is cancelled with its stock still reserved, and Stripe retries
    breakOnce(s, (collection) => collection === "inventory");
    expect((await s.webhook("payment_intent.payment_failed", intent)).status).toBe(500);
    expect(s.tables.orders[0]).toMatchObject({ status: "cancelled", payment: "pay_1" });
    expect(s.tables.inventory[0]).toMatchObject({ reserved: 2 });
    expect(s.audit()).not.toContain("order.payment_failed");
    // the retry finishes the release the first attempt left: the two kettles go back, once
    expect((await s.webhook("payment_intent.payment_failed", intent)).status).toBe(200);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 0 });
    expect(s.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.payment_failed"]);
    // and the same intent succeeding brings the order back with its two kettles reserved again, not four
    expect((await s.webhook("payment_intent.succeeded", intent)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
    expect(s.tables.commerce_audit.filter((r) => String(r.action).startsWith("stock.")).map((r) => [r.action, (r.detail as Row).quantity])).toEqual([["stock.released", 2], ["stock.reserved", 2]]);
    expect(s.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.payment_failed", "order.paid"]);
  });

  test("a failure whose release dies part-way after a success has brought the order back is finished by the provider's retry: the order ends paid with every line reserved", async () => {
    // two lines, both tracked: the decline claims the order and releases them one at a time
    const s = await shop({ auth: ada, answers: SESSION, flat: true, seed: { ...catalogue(), inventory: [{ id: "i1", variant: "v1", onHand: 3, reserved: 0 }, { id: "i2", variant: "v2", onHand: 3, reserved: 0 }] } });
    await s.post(`${API}/cart/items`, { variant: "v1", quantity: 2 });
    await s.post(`${API}/cart/items`, { variant: "v2", quantity: 1 });
    await s.post(`${API}/cart/address`, { address: ADDRESS });
    expect((await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" })).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ id: "orders_1", status: "pending", total: 7700 });
    expect(s.tables.inventory.map((i) => [i.variant, i.reserved])).toEqual([["v1", 2], ["v2", 1]]);

    // the buyer's retry on the same intent succeeds while the first line is being released, so that success finds no
    // release recorded and reserves nothing back; the second line's step then throws, the way a round trip fails
    const intent = { id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 7700, currency: "usd", metadata: { voidbase_order: "orders_1" } };
    const createOnce = s.rows.createOnce.bind(s.rows);
    let releases = 0, success: Promise<{ status: number }> | undefined;
    s.rows.createOnce = async (collection, values, alongside) => {
      if (collection === "commerce_audit" && values.action === "stock.released") {
        releases++;
        if (releases === 1) { success = s.webhook("payment_intent.succeeded", intent); await success; }
        if (releases === 2) throw new Error("D1 went away for a moment");
      }
      return createOnce(collection, values, alongside);
    };
    expect((await s.webhook("payment_intent.payment_failed", intent)).status).toBe(500);
    expect((await success!).status).toBe(200);
    // the order is paid, with the line the failure released still released and no order.payment_failed row yet
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.inventory.map((i) => [i.variant, i.reserved])).toEqual([["v1", 0], ["v2", 1]]);
    expect(s.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.paid"]);

    // the provider retries the failure: it writes its row and finishes what the success left, so the paid order holds
    // every one of its lines again
    expect((await s.webhook("payment_intent.payment_failed", intent)).status).toBe(200);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.inventory.map((i) => [i.variant, i.reserved])).toEqual([["v1", 2], ["v2", 1]]);
    expect(s.audit().filter((a) => a.startsWith("order."))).toEqual(["order.placed", "order.paid", "order.payment_failed"]);
    expect(s.tables.commerce_audit.filter((r) => String(r.action).startsWith("stock.")).map((r) => [r.action, (r.detail as Row).variant, (r.detail as Row).quantity])).toEqual([["stock.released", "v1", 2], ["stock.reserved", "v1", 2]]);
    // and told again it repeats none of it, since every step is written once by its own id
    expect((await s.webhook("payment_intent.payment_failed", intent)).status).toBe(200);
    expect(s.tables.inventory.map((i) => [i.variant, i.reserved])).toEqual([["v1", 2], ["v2", 1]]);
    expect(s.tables.commerce_audit.filter((r) => String(r.action).startsWith("stock."))).toHaveLength(2);
  });

  test("a telling of a success that runs to its end while another is still writing its order.paid row writes no second one", async () => {
    const s = await kettles(2);
    const intent = { id: "pi_1", object: "payment_intent", customer: "cus_1", amount: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } };
    const session = { id: "cs_1", object: "checkout.session", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 5000, currency: "usd", metadata: { voidbase_order: "orders_1" } };
    // the session's claim wins, and the intent's telling of the same payment runs to its end before the session writes
    // its own order.paid row: the lagging twin wrote a second row until the row's id became the step's own
    const updateWhere = s.rows.updateWhere.bind(s.rows);
    let twin: Promise<{ status: number }> | undefined;
    s.rows.updateWhere = async (collection, id, where, values) => {
      const moved = await updateWhere(collection, id, where, values);
      if (moved && !twin) { twin = s.webhook("payment_intent.succeeded", intent); await twin; }
      return moved;
    };
    const first = await s.webhook("checkout.session.completed", session);
    expect([first.status, (await twin!).status]).toEqual([200, 200]);
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    expect(s.tables.commerce_audit.filter((r) => r.action === "order.paid")).toHaveLength(1);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
  });
});

// ---- what the docs say a shop needs -----------------------------------------------------------------

describe("what the docs say a shop needs of its provider, and of an upgrade", () => {
  const docs = readFileSync(resolvePath(import.meta.dir, "../../docs/plugins.md"), "utf8");
  const section = (from: string, to: string) => docs.slice(docs.indexOf(from), docs.indexOf(to, docs.indexOf(from))).replace(/\s+/g, " ");
  const polar = section("### polar", "### lemonsqueezy");
  const lemon = section("### lemonsqueezy", "## A shop the other plugins plug into");
  const shop = section("## A shop the other plugins plug into", "## Backups worth relying on");

  test("Polar: the prices commerce charges are tax-exclusive and in the shop's currency, in the Polar section and in commerce's, with what happens otherwise", () => {
    for (const text of [polar, shop]) {
      expect(text).toContain("tax-exclusive");
      expect(text).toContain("shop's currency");
      expect(text).toMatch(/leaves the order `pending`, and an `order.payment_unmatched` row names both amounts/);
    }
    // the reason: a Polar order says nothing of how its price was taxed, and a checkout's price shows a buyer's own currency
    expect(polar).toContain("A Polar order carries no `tax_behavior`");
    expect(polar).toContain("`default_presentment_currency` is only the fallback");
  });

  test("Lemon Squeezy: a variant with a setup fee pays no commerce order, said beside the other Lemon Squeezy requirements", () => {
    expect(lemon).toContain("A variant with a setup fee pays no commerce order");
    expect(lemon).toContain("`setup_fee`");
    expect(shop).toContain("variants without a setup fee");
  });

  test("an upgrade: orders pending from before references never move, and a superuser matches them by hand against payments that name no order, with no matching on the amount", () => {
    expect(shop).toContain("**Upgrading from 0.9.0-beta.45 or earlier.**");
    const note = shop.slice(shop.indexOf("**Upgrading from 0.9.0-beta.45 or earlier.**"));
    expect(note).toContain("their payments name no order and will never move them");
    expect(note).toContain("A superuser matches them by hand");
    expect(note).toContain("placed before the deploy");
    expect(note).toContain("`payments` rows that name no order");
    expect(note).toContain("nothing in commerce matches a payment to an order by its amount any more");
  });
});

// ---- fulfilment and refunds -------------------------------------------------------------------------

async function paidShop() {
  const s = await readyToPay();
  await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b", shipping: "express" });
  await s.webhook("checkout.session.completed", { id: "cs_1", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 10740, currency: "usd", metadata: { voidbase_order: "orders_1" } });
  return s;
}

describe("fulfilment and refunds", () => {
  test("a superuser fulfils a paid order: a shipment, the stock gone, the reservation with it", async () => {
    const s = await paidShop();
    s.as(admin);
    const out = await s.post(`${API}/orders/orders_1/fulfil`, { carrier: "Royal Mail", tracking: "RM1" });
    expect(out.status).toBe(200);
    expect(out.json.order).toMatchObject({ status: "fulfilled" });
    expect(out.json.shipment).toMatchObject({ carrier: "Royal Mail", tracking: "RM1", shippedAt: new Date(NOW).toISOString() });
    expect(s.tables.shipments[0]!.items).toEqual([{ variant: "v1", sku: "KET-1", title: "Kettle, black", quantity: 2 }, { variant: "v2", sku: "KET-2", title: "Kettle, white", quantity: 1 }]);
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 1, reserved: 0 });
    expect(s.audit()).toContain("order.fulfilled");
    // and once is once
    expect((await s.post(`${API}/orders/orders_1/fulfil`, {})).status).toBe(409);
  });

  test("a refund is recorded whether or not the provider can give the money back", async () => {
    const s = await paidShop();
    s.as(admin);
    const out = await s.post(`${API}/orders/orders_1/refund`, { reason: "she changed her mind" });
    expect(out.status).toBe(200);
    expect(out.json.order).toMatchObject({ status: "refunded" });
    expect(out.json.refund).toMatchObject({ amount: 10740, reason: "she changed her mind", providerId: "" });
    const row = s.tables.commerce_audit.find((r) => r.action === "order.refunded")!;
    expect(row.detail).toMatchObject({ amount: 10740, atProvider: false });
    // the stock is not put back: a refunded order is not an unsold one, and only a person knows which it is
    expect(s.tables.inventory[0]).toMatchObject({ onHand: 3, reserved: 2 });
  });

  test("when the payments plugin has a refund method, commerce calls it and keeps the provider's id", async () => {
    const s = await paidShop();
    const asked: Row[] = [];
    (s.payments() as Payments).refund = async (_env, o) => { asked.push(o as Row); return { providerId: "re_7" }; };
    try {
      s.as(admin);
      const out = await s.post(`${API}/orders/orders_1/refund`, { amount: 500 });
      expect(out.json.refund).toMatchObject({ amount: 500, providerId: "re_7" });
      expect(asked).toEqual([{ payment: "pay_1", amount: 500 }]);
      expect(s.tables.commerce_audit.find((r) => r.action === "order.refunded")!.detail).toMatchObject({ atProvider: true });
    } finally { delete (s.payments() as Payments).refund; }
  });

  test("fulfilment and refunds are a superuser's, and an amount over the total is refused", async () => {
    const s = await paidShop();
    expect((await s.post(`${API}/orders/orders_1/fulfil`, {})).status).toBe(403);
    expect((await s.post(`${API}/orders/orders_1/refund`, {})).status).toBe(403);
    s.as(admin);
    expect((await s.post(`${API}/orders/orders_1/refund`, { amount: 99999 })).status).toBe(400);
    expect((await s.post(`${API}/orders/nope/fulfil`, {})).status).toBe(404);
  });
});

// ---- reading your own -------------------------------------------------------------------------------

describe("an order is the customer's own", () => {
  test("the caller reads their orders and not anybody else's; a superuser reads either", async () => {
    const s = await paidShop();
    const mine = await s.get(`${API}/orders`);
    expect(mine.status).toBe(200);
    expect((mine.json.items as Row[]).map((o) => o.number)).toEqual(["VB-1"]);
    const one = await s.get(`${API}/orders/orders_1`);
    expect(one.json).toMatchObject({ number: "VB-1", status: "paid", total: 10740 });
    expect((one.json.items as Row[]).map((i) => i.sku)).toEqual(["KET-1", "KET-2"]);
    expect(one.json.shipments).toEqual([]);
    expect(one.json.refunds).toEqual([]);

    s.as(bob);
    const theirs = await s.get(`${API}/orders/orders_1`);
    expect(theirs.status).toBe(403);
    expect(String(theirs.json.message)).toContain("somebody else");
    expect((await s.get(`${API}/orders`)).json.items).toEqual([]);

    s.as(admin);
    expect((await s.get(`${API}/orders/orders_1`)).status).toBe(200);
    s.as(null);
    expect((await s.get(`${API}/orders`)).status).toBe(401);
  });

  test("every state change left a row in the audit trail, in the order it happened", async () => {
    const s = await paidShop();
    s.as(admin);
    await s.post(`${API}/orders/orders_1/fulfil`, {});
    expect(s.audit()).toEqual([
      "cart.created", "cart.item.added", "cart.item.added", "cart.address.set", "order.placed", "order.paid", "order.fulfilled",
    ]);
    for (const row of s.tables.commerce_audit) {
      expect(String(row.at)).toBe(new Date(NOW).toISOString());
      expect(String(row.subject)).toMatch(/^(cart|order):/);
      expect(typeof row.detail).toBe("object");
    }
  });
});
