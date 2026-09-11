// The commerce plugin: the cart's lifecycle, inventory reserved and released, the tax and shipping quotes arriving
// through `tax@1` and `shipping@1`, checkout handing the right line items to `payments@1`, a paid webhook moving
// the order through the seam the providers call, fulfilment, a refund, the audit trail, and the rules that keep one
// customer out of another's order.
//
// The two interfaces are fakes here, which is the point of the design being tested: commerce requires `tax@1` and
// `shipping@1` and not the shipped flat-rate plugins, so a test's own provider is as good as ours. Payments is the
// real stripe plugin over a fake `fetch`, because the webhook seam is exactly what has to be measured end to end.
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { invalidateCollections } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import type { Auth, Payments, QuoteAddress, QuoteItem, Shipping, ShippingRate, Tax } from "../../src/server/interfaces";
import { KNOWN } from "../../src/server/interfaces";
import { createKernel, load, serve, using, type Kernel } from "../../src/server/kernel";
import {
  API, collectionDefinitions, COMMERCE_COLLECTIONS, commerceOn, commerceWith, defaultCurrency,
  type CommerceCollection, type CommerceRows,
} from "../../src/server/plugins/commerce";
import type { Plugin } from "../../src/server/plugins/manifest";
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

function commerceRows(seed: Partial<Record<CommerceCollection, Row[]>>, customers: () => Row[]) {
  const tables = Object.fromEntries(COMMERCE_COLLECTIONS.map((c) => [c, [...(seed[c] ?? [])]])) as Record<CommerceCollection, Row[]>;
  const n: Record<string, number> = {};
  const list = async (c: CommerceCollection, where: Record<string, string>): Promise<Row[]> =>
    tables[c].filter((r) => Object.entries(where).every(([k, v]) => String(r[k] ?? "") === v));
  const rows: CommerceRows = {
    list,
    async find(c, where) { return (await list(c, where))[0] ?? null; },
    async create(c, values) { const row: Row = { id: `${c}_${(n[c] = (n[c] ?? 0) + 1)}`, ...values }; tables[c].push(row); return row; },
    async update(c, id, values) { const row = tables[c].find((r) => r.id === id); if (!row) throw new Error(`no ${c} ${id}`); Object.assign(row, values); return row; },
    async remove(c, id) { const i = tables[c].findIndex((r) => r.id === id); if (i >= 0) tables[c].splice(i, 1); },
    async customers(user) { return customers().filter((r) => String(r.user ?? "") === user); },
  };
  return { rows, tables };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: URLSearchParams };
function fakeFetch(answers: Record<string, Row> = {}) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    calls.push({ url, method: init?.method ?? "GET", headers, body });
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

// ---- the shop ---------------------------------------------------------------------------------------

const users = { name: "users", id: "_pb_users_auth_" } as unknown as Collection;
const ada: AuthRecord = { collection: users, row: { id: "u1", email: "ada@b.test" } };
const bob: AuthRecord = { collection: users, row: { id: "u2", email: "bob@b.test" } };
const admin: AuthRecord = { collection: { name: "_superusers" } as unknown as Collection, row: { id: "admin" } };

const SECRET = "sk_test_abc", WHSEC = "whsec_test_123";
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

async function shop(o: { auth?: AuthRecord | null; seed?: Partial<Record<CommerceCollection, Row[]>>; answers?: Record<string, Row>; env?: Partial<Bindings> } = {}) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
  let auth = o.auth ?? null;
  app.use("*", async (c, next) => { c.set("auth", auth); await next(); });
  const kernel = createKernel(app);
  const money = paymentRows();
  const shopRows = commerceRows(o.seed ?? catalogue(), () => money.tables.customers);
  const { calls, f } = fakeFetch(o.answers ?? {});
  const stripe = stripeWith({ fetch: f, rows: () => money.rows, now: () => T });
  const tax = fakeTax(), shipping = fakeShipping();
  let numbers = 0;
  const plugin = commerceWith({ rows: () => shopRows.rows, now: () => NOW, token: () => "tok_1", number: () => `VB-${++numbers}` });
  stops.push(() => plugin.stopWatchingPayments());
  await load(kernel, [stripe, tax.plugin, shipping.plugin, plugin], "0.9.0");
  provideAuthLookup(() => ({ isSuperuser: (r) => r?.row.id === "admin" }) as unknown as Auth);
  const env = { DB: {} as D1Database, STORAGE: {} as R2Bucket, [KEY_VAR]: SECRET, [WEBHOOK_SECRET_VAR]: WHSEC, VOIDBASE_COMMERCE: "1", ...o.env } as unknown as Bindings;
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
  return {
    app, kernel, env, calls, plugin, money, tables: shopRows.tables, tax, shipping, webhook,
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
async function readyToPay(o: { seed?: Partial<Record<CommerceCollection, Row[]>>; answers?: Record<string, Row> } = {}) {
  const s = await shop({ auth: ada, answers: SESSION, ...o });
  await s.post(`${API}/cart/items`, { variant: "v1", quantity: 2 });
  await s.post(`${API}/cart/items`, { variant: "v2", quantity: 1 });
  await s.post(`${API}/cart/address`, { address: ADDRESS });
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
    expect(fields("order_items")).toEqual(["order", "variant", "sku", "title", "quantity", "unitPrice", "total", "created", "updated"]);
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
    const failed = await s.webhook("payment_intent.payment_failed", { id: "pi_9", customer: "cus_1", amount: 10740, currency: "usd" });
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
});

// ---- the seam ---------------------------------------------------------------------------------------

describe("learning that an order was paid", () => {
  test("the provider's own webhook writes a payments row, and commerce moves the order behind it", async () => {
    const s = await readyToPay();
    await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b", shipping: "express" });
    expect(s.tables.orders[0]!.status).toBe("pending");
    const paid = await s.webhook("checkout.session.completed", { id: "cs_1", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 10740, currency: "usd" });
    expect(paid.json).toMatchObject({ received: true, handled: true, kind: "checkout.session.completed" });
    expect(s.tables.orders[0]).toMatchObject({ status: "paid", payment: "pay_1" });
    const row = s.tables.commerce_audit.find((r) => r.action === "order.paid")!;
    expect(row.actor).toBe("payments:stripe");
    expect(row.detail).toMatchObject({ provider: "stripe", payment: "pay_1", amount: 10740, currency: "usd" });
    // a replayed webhook is the same upsert and the same move: the order is still paid, once
    await s.webhook("checkout.session.completed", { id: "cs_1", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 10740, currency: "usd" });
    expect(s.money.tables.payments).toHaveLength(1);
    expect(s.tables.orders.filter((o) => o.status === "paid")).toHaveLength(1);
  });

  test("the watchers belong to one app, so another instance's webhook does not move this one's order", async () => {
    const one = await readyToPay();
    await one.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    const two = await readyToPay();
    await two.post(`${API}/checkout`, { success: "https://a", cancel: "https://b" });
    await two.webhook("checkout.session.completed", { id: "cs_2", customer: "cus_1", mode: "payment", payment_intent: "pi_2", payment_status: "paid", amount_total: 9740, currency: "usd" });
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
});

// ---- fulfilment and refunds -------------------------------------------------------------------------

async function paidShop() {
  const s = await readyToPay();
  await s.post(`${API}/checkout`, { success: "https://a", cancel: "https://b", shipping: "express" });
  await s.webhook("checkout.session.completed", { id: "cs_1", customer: "cus_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid", amount_total: 10740, currency: "usd" });
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
