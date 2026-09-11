// The lemonsqueezy plugin: the X-Signature check, the JSON:API bodies of checkout, portal and cancel against a fake
// fetch, each webhook event's effect on the rows through in-memory rows, idempotent replay, and the no-key state.
// It joins stripe's family for payments@1, so it is loaded alongside a keyless stripe here.
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import type { Auth, Payments } from "../../src/server/interfaces";
import { createKernel, load, using } from "../../src/server/kernel";
import {
  applyEvent, KEY_VAR, lemonsqueezy, lemonsqueezyProvider, lemonsqueezyWith, signPayload, STORE_VAR, verifySignature, WEBHOOK_PATH, WEBHOOK_SECRET_VAR,
} from "../../src/server/plugins/lemonsqueezy";
import type { PaymentCollection, PaymentRows } from "../../src/server/plugins/payments-shared";
import { stripeWith } from "../../src/server/plugins/stripe";
import type { AppEnv, AuthRecord, Bindings, Row } from "../../src/server/types";

// ---- fakes ----------------------------------------------------------------------------------------

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

type Call = { url: string; method: string; headers: Record<string, string>; body: Row };
function fakeFetch(answers: Record<string, Row | ((body: Row, url: URL) => Row | Response)> = {}) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Row) : {};
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    const answer = answers[key];
    if (!answer) return new Response(JSON.stringify({ errors: [{ detail: `unexpected ${key}` }] }), { status: 500 });
    const out = typeof answer === "function" ? answer(body, u) : answer;
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
  };
  return { calls, f };
}

const users = { name: "users", id: "_pb_users_auth_" } as unknown as Collection;
const ada: AuthRecord = { collection: users, row: { id: "u1", email: "ada@b.test", name: "Ada" } };
const bob: AuthRecord = { collection: users, row: { id: "u2", email: "bob@b.test" } };
const admin: AuthRecord = { collection: { name: "_superusers" } as unknown as Collection, row: { id: "admin" } };

const KEY = "ls_api_key_abc", STORE = "42", SECRET = "a-signing-secret";
const envWith = (o: Partial<Bindings> = {}): Bindings => ({ DB: {} as D1Database, STORAGE: {} as R2Bucket, [KEY_VAR]: KEY, [STORE_VAR]: STORE, [WEBHOOK_SECRET_VAR]: SECRET, ...o }) as Bindings;

async function appWith(o: { auth?: AuthRecord | null; fetch?: ReturnType<typeof fakeFetch>["f"]; rows?: PaymentRows; now?: () => number; env?: Partial<Bindings> } = {}) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
  app.use("*", async (c, next) => { c.set("auth", o.auth ?? null); await next(); });
  const kernel = createKernel(app);
  const rows = o.rows ? () => o.rows! : undefined;
  const plugin = lemonsqueezyWith({ fetch: o.fetch, rows, now: o.now });
  await load(kernel, [stripeWith({ fetch: o.fetch, rows, now: o.now }), plugin], "0.9.0");
  const env = envWith(o.env);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as Row };
  };
  return { app, kernel, plugin, env, post };
}

/** a Lemon Squeezy webhook: the event name in meta, the JSON:API resource in data, the checkout's custom data alongside */
const event = (name: string, type: string, id: string, attributes: Row, custom: Row = { voidbase_user: "u1" }): string =>
  JSON.stringify({ meta: { event_name: name, custom_data: custom, webhook_id: "wh_1" }, data: { type, id, attributes } });
const signed = async (payload: string, secret = SECRET) => ({ "x-signature": await signPayload(secret, payload), "x-event-name": (JSON.parse(payload) as { meta: { event_name: string } }).meta.event_name });
const jsonapi = (type: string, id: string, attributes: Row): Row => ({ data: { type, id, attributes } });

// ---- the signature ----------------------------------------------------------------------------------

describe("the X-Signature check", () => {
  const payload = '{"meta":{"event_name":"order_created"},"data":{"id":"1"}}';

  test("the hex HMAC SHA-256 of the raw body passes, in either case", async () => {
    const sig = await signPayload(SECRET, payload);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifySignature(payload, sig, SECRET)).toEqual({ ok: true });
    expect((await verifySignature(payload, sig.toUpperCase(), SECRET)).ok).toBe(true);
  });

  test("a wrong signature, a wrong secret, a changed payload and a missing header are refused with the reason", async () => {
    const sig = await signPayload(SECRET, payload);
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(await verifySignature(payload, flipped, SECRET)).toEqual({ ok: false, reason: "the signature does not match the payload" });
    expect((await verifySignature(payload, sig, "other")).ok).toBe(false);
    expect((await verifySignature(payload + " ", sig, SECRET)).ok).toBe(false);
    expect((await verifySignature(payload, "abc", SECRET)).ok).toBe(false); // a different length never matches
    expect(await verifySignature(payload, null, SECRET)).toEqual({ ok: false, reason: "no X-Signature header" });
    expect((await verifySignature(payload, sig, "")).ok).toBe(false);
  });
});

// ---- checkout, portal, cancel -----------------------------------------------------------------------

describe("checkout", () => {
  test("the first checkout looks the customer up by email in the store, creates it, then the checkout with store and variant relationships; the answer is data.attributes.url", async () => {
    const { calls, f } = fakeFetch({
      "GET /v1/customers": { data: [] },
      "POST /v1/customers": jsonapi("customers", "7", { name: "Ada", email: "ada@b.test" }),
      "POST /v1/checkouts": jsonapi("checkouts", "5e8b", { url: "https://my-store.lemonsqueezy.com/checkout/custom/5e8b?signature=x" }),
    });
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "123", quantity: 3 }], success: "https://app.test/ok" });
    expect(r).toEqual({ status: 200, json: { url: "https://my-store.lemonsqueezy.com/checkout/custom/5e8b?signature=x" } });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.lemonsqueezy.com/v1/customers?filter[store_id]=42&filter[email]=ada%40b.test",
      "POST https://api.lemonsqueezy.com/v1/customers",
      "POST https://api.lemonsqueezy.com/v1/checkouts",
    ]);
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(c.headers.accept).toBe("application/vnd.api+json");
    }
    expect(calls[1]!.headers["content-type"]).toBe("application/vnd.api+json");
    expect(calls[1]!.body).toEqual({ data: { type: "customers", attributes: { name: "Ada", email: "ada@b.test" }, relationships: { store: { data: { type: "stores", id: "42" } } } } });
    expect(tables.customers).toEqual([{ id: tables.customers[0]!.id as string, user: "u1", provider: "lemonsqueezy", providerId: "7", email: "ada@b.test" }]);
    const customerRow = String(tables.customers[0]!.id);
    expect(calls[2]!.body).toEqual({
      data: {
        type: "checkouts",
        attributes: {
          product_options: { redirect_url: "https://app.test/ok" },
          checkout_data: { email: "ada@b.test", custom: { voidbase_customer: customerRow, voidbase_user: "u1" }, variant_quantities: [{ variant_id: 123, quantity: 3 }] },
        },
        relationships: { store: { data: { type: "stores", id: "42" } }, variant: { data: { type: "variants", id: "123" } } },
      },
    });
  });

  test("a customer the store already has by email is reused; a row already there means no lookup; quantity 1 sends no variant_quantities", async () => {
    const { calls, f } = fakeFetch({ "GET /v1/customers": { data: [jsonapi("customers", "9", { email: "ada@b.test" }).data] }, "POST /v1/checkouts": jsonapi("checkouts", "x", { url: "https://ls/co" }) });
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    expect((await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "123" }], success: "https://a/ok" })).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(tables.customers[0]!.providerId).toBe("9");
    expect((calls[1]!.body.data as Row).attributes).toEqual({ product_options: { redirect_url: "https://a/ok" }, checkout_data: { email: "ada@b.test", custom: { voidbase_customer: String(tables.customers[0]!.id), voidbase_user: "u1" } } });
    expect((await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "123" }], success: "https://a/ok" })).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  test("the body is checked before Lemon Squeezy is called: one numeric variant, a success URL; a signed-out request is 401", async () => {
    const { calls, f } = fakeFetch();
    const { post } = await appWith({ auth: ada, fetch: f, rows: memoryRows().rows });
    expect((await post("/api/payments/lemonsqueezy/checkout", { items: [], success: "https://a" })).status).toBe(400);
    expect((await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1" }, { price: "2" }], success: "https://a" })).status).toBe(400);
    expect((await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "variant_1" }], success: "https://a" })).status).toBe(400);
    expect((await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1", quantity: 0 }], success: "https://a" })).status).toBe(400);
    expect((await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1" }] })).status).toBe(400);
    expect((await post("/api/payments/lemonsqueezy/checkout", "not json")).status).toBe(400);
    expect(calls).toHaveLength(0);
    const out = await appWith({ auth: null, fetch: f, rows: memoryRows().rows });
    expect((await out.post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1" }], success: "https://a" })).status).toBe(401);
  });

  test("without the store id the route says so; Lemon Squeezy's refusal is a 400 with its detail, an outage a 502", async () => {
    const { rows } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "lemonsqueezy", providerId: "7" }] });
    const noStore = await appWith({ auth: ada, fetch: fakeFetch().f, rows, env: { [STORE_VAR]: "" } as Partial<Bindings> });
    const r0 = await noStore.post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1" }], success: "https://a" });
    expect(r0.status).toBe(503);
    expect(String(r0.json.message)).toContain(STORE_VAR);
    const { f } = fakeFetch({ "POST /v1/checkouts": () => new Response(JSON.stringify({ errors: [{ status: "422", title: "Unprocessable Entity", detail: "The variant field is required." }] }), { status: 422 }) });
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1" }], success: "https://a" });
    expect(r.status).toBe(400);
    expect(String(r.json.message)).toContain("Lemon Squeezy answered 422: The variant field is required.");
    const down = fakeFetch({ "POST /v1/checkouts": () => new Response("bad gateway", { status: 503 }) });
    const again = await appWith({ auth: ada, fetch: down.f, rows });
    expect((await again.post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1" }], success: "https://a" })).status).toBe(502);
  });

  test("amount lines are refused with a 400 before Lemon Squeezy is called, and a reference goes in the custom data every webhook carries back", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/checkouts": jsonapi("checkouts", "x", { url: "https://ls/co" }) });
    const customer = { id: "c1", user: "u1", provider: "lemonsqueezy", providerId: "7", email: "ada@b.test" };
    const { rows } = memoryRows({ customers: [customer] });
    const { kernel, env } = await appWith({ auth: ada, fetch: f, rows });
    const payments = using<Payments>(kernel, "payments@1");
    const charge = { customer: "c1", items: [{ price: "123", quantity: 1 }], amounts: [{ name: "Standard shipping", amount: 500, currency: "usd" }], success: "https://a/ok", reference: "ord_1" };
    // one variant at its price, and no line for an amount: the checkout is refused, never started without it
    expect(() => payments.checkCheckout!(env, charge)).toThrow(/Lemon Squeezy charges one variant at its price and has no line for an amount/);
    await expect(payments.checkout(env, charge)).rejects.toMatchObject({ status: 400 });
    // and by the provider itself, for a caller that went straight to it: neither the amount nor a second item is dropped
    const provider = lemonsqueezyProvider({ fetch: f, rows: () => rows, now: () => 0 });
    await expect(provider.checkout(env, customer, charge)).rejects.toMatchObject({ status: 400 });
    await expect(provider.checkout(env, customer, { ...charge, amounts: [], items: [{ price: "123", quantity: 1 }, { price: "124", quantity: 1 }] })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
    // without one the checkout goes, and names its order in the custom data
    expect(await payments.checkout(env, { ...charge, amounts: [] })).toEqual({ url: "https://ls/co" });
    expect(((calls[0]!.body.data as Row).attributes as Row).checkout_data).toMatchObject({ email: "ada@b.test", custom: { voidbase_customer: "c1", voidbase_user: "u1", voidbase_order: "ord_1" } });
  });

  test("a checkout that pays a reference hides the discount code field, since a code would pay less than the order's total; one without a reference leaves the field as Lemon Squeezy has it", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/checkouts": jsonapi("checkouts", "x", { url: "https://ls/co" }) });
    const customer = { id: "c1", user: "u1", provider: "lemonsqueezy", providerId: "7", email: "ada@b.test" };
    const { rows } = memoryRows({ customers: [customer] });
    const { kernel, env, post } = await appWith({ auth: ada, fetch: f, rows });
    const payments = using<Payments>(kernel, "payments@1");
    expect(await payments.checkout(env, { customer: "c1", items: [{ price: "123", quantity: 1 }], success: "https://a/ok", reference: "ord_1", currency: "usd" })).toEqual({ url: "https://ls/co" });
    // `checkout_options.discount`: "If false, hide the discount code field" (Create a Checkout); the checkout's currency
    // is not sent, since a variant is priced in the store's
    expect((calls[0]!.body.data as Row).attributes).toEqual({
      product_options: { redirect_url: "https://a/ok" },
      checkout_options: { discount: false },
      checkout_data: { email: "ada@b.test", custom: { voidbase_customer: "c1", voidbase_user: "u1", voidbase_order: "ord_1" } },
    });
    // without a reference, through payments@1 or the route, there is no order to pay in full and no option is sent
    expect(await payments.checkout(env, { customer: "c1", items: [{ price: "123", quantity: 1 }], success: "https://a/ok" })).toEqual({ url: "https://ls/co" });
    expect((await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "123" }], success: "https://a/ok" })).status).toBe(200);
    expect(calls).toHaveLength(3);
    for (const c of calls.slice(1)) expect((c.body.data as Row).attributes).not.toHaveProperty("checkout_options");
  });
});

describe("the customer portal", () => {
  test("the customer's signed portal URL from GET /v1/customers/{id}; none yet is a 400 that says so", async () => {
    const portal = "https://my-store.lemonsqueezy.com/billing?expires=1&signature=x";
    const { calls, f } = fakeFetch({ "GET /v1/customers/7": jsonapi("customers", "7", { email: "ada@b.test", urls: { customer_portal: portal } }), "GET /v1/customers/8": jsonapi("customers", "8", { urls: { customer_portal: null } }) });
    const { rows } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "lemonsqueezy", providerId: "7" }, { id: "c2", user: "u2", provider: "lemonsqueezy", providerId: "8" }] });
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/lemonsqueezy/portal", { return: "https://app.test/account" });
    expect(r).toEqual({ status: 200, json: { url: portal } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.lemonsqueezy.com/v1/customers/7");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect((await post("/api/payments/lemonsqueezy/portal", {})).status).toBe(400);
    const asBob = await appWith({ auth: bob, fetch: f, rows });
    const none = await asBob.post("/api/payments/lemonsqueezy/portal", { return: "https://app.test/account" });
    expect(none.status).toBe(400);
    expect(String(none.json.message)).toContain("no customer portal for this customer yet");
  });
});

describe("cancel", () => {
  const seed = () => memoryRows({
    customers: [{ id: "c1", user: "u1", provider: "lemonsqueezy", providerId: "7" }],
    subscriptions: [{ id: "s1", customer: "c1", providerId: "11", status: "active", cancelAtPeriodEnd: false }],
  });
  afterEach(() => provideAuthLookup(() => undefined));

  test("the owner cancels at the period's end by default: DELETE, and the row runs until ends_at with cancelAtPeriodEnd set", async () => {
    const { calls, f } = fakeFetch({ "DELETE /v1/subscriptions/11": jsonapi("subscriptions", "11", { status: "cancelled", cancelled: true, renews_at: "2026-10-12T00:00:00.000000Z", ends_at: "2026-10-12T00:00:00.000000Z" }) });
    const { rows, tables } = seed();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/lemonsqueezy/cancel", { subscription: "s1" });
    expect(r).toEqual({ status: 200, json: { subscription: "s1", status: "active", cancelAtPeriodEnd: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.lemonsqueezy.com/v1/subscriptions/11");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(tables.subscriptions[0]).toMatchObject({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-10-12T00:00:00.000Z" });
  });

  test("now: true is a 400 that says Lemon Squeezy does not offer it; resume: true is a PATCH with cancelled: false", async () => {
    const { calls, f } = fakeFetch({ "PATCH /v1/subscriptions/11": jsonapi("subscriptions", "11", { status: "active", cancelled: false, renews_at: "2026-11-12T00:00:00.000000Z", ends_at: null }) });
    const { rows, tables } = seed();
    tables.subscriptions[0]!.cancelAtPeriodEnd = true;
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/lemonsqueezy/cancel", { subscription: "s1", now: true });
    expect(r.status).toBe(400);
    expect(String(r.json.message)).toContain("cancels at the period's end only");
    expect(calls).toHaveLength(0);
    const back = await post("/api/payments/lemonsqueezy/cancel", { subscription: "s1", resume: true });
    expect(back.json).toEqual({ subscription: "s1", status: "active", cancelAtPeriodEnd: false });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ data: { type: "subscriptions", id: "11", attributes: { cancelled: false } } });
    expect(tables.subscriptions[0]!.currentPeriodEnd).toBe("2026-11-12T00:00:00.000Z");
  });

  test("somebody else's subscription is 403 and Lemon Squeezy is never called; a superuser may; an unknown id is 404", async () => {
    const { calls, f } = fakeFetch({ "DELETE /v1/subscriptions/11": jsonapi("subscriptions", "11", { status: "cancelled", cancelled: true }) });
    const { rows } = seed();
    const asBob = await appWith({ auth: bob, fetch: f, rows });
    expect((await asBob.post("/api/payments/lemonsqueezy/cancel", { subscription: "s1" })).status).toBe(403);
    expect(calls).toHaveLength(0);
    provideAuthLookup(() => ({ isSuperuser: (r) => r?.row.id === "admin" }) as unknown as Auth);
    const asAdmin = await appWith({ auth: admin, fetch: f, rows });
    expect((await asAdmin.post("/api/payments/lemonsqueezy/cancel", { subscription: "s1" })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await asAdmin.post("/api/payments/lemonsqueezy/cancel", { subscription: "nope" })).status).toBe(404);
    expect((await asAdmin.post("/api/payments/lemonsqueezy/cancel", {})).status).toBe(400);
  });
});

// ---- the webhook ------------------------------------------------------------------------------------

describe("the webhook route", () => {
  test("a bad or missing signature is 400 and nothing is written; an unknown event is 200 and ignored", async () => {
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ rows });
    const payload = event("order_created", "orders", "1", { customer_id: 7, user_email: "ada@b.test", currency: "EUR", total: 500, status: "paid" });
    expect((await post(WEBHOOK_PATH, payload, { "x-signature": "a".repeat(64) })).status).toBe(400);
    expect((await post(WEBHOOK_PATH, payload)).status).toBe(400);
    expect((await post(WEBHOOK_PATH, payload, await signed(payload, "another-secret"))).status).toBe(400);
    expect(tables.payments).toHaveLength(0);
    const other = event("license_key_created", "license-keys", "1", { key: "x" });
    expect(await post(WEBHOOK_PATH, other, await signed(other))).toEqual({ status: 200, json: { received: true, handled: false } });
    expect(tables.customers).toHaveLength(0);
  });

  test("without the webhook secret the route says so with 503 rather than accepting anything", async () => {
    const { rows } = memoryRows();
    const { post } = await appWith({ rows, env: { [WEBHOOK_SECRET_VAR]: "" } as Partial<Bindings> });
    const payload = event("order_created", "orders", "1", {});
    const r = await post(WEBHOOK_PATH, payload, await signed(payload));
    expect(r.status).toBe(503);
    expect(String(r.json.message)).toContain(WEBHOOK_SECRET_VAR);
  });

  test("a verified event reaches the rows, and the Payments interface (the family's) routes it to lemonsqueezy by path", async () => {
    const { rows, tables } = memoryRows();
    const { post, kernel } = await appWith({ rows });
    const payload = event("subscription_created", "subscriptions", "11", { customer_id: 7, order_id: 1, variant_id: 123, user_email: "ada@b.test", status: "active", cancelled: false, renews_at: "2026-10-12T00:00:00.000000Z", ends_at: null });
    expect((await post(WEBHOOK_PATH, payload, await signed(payload))).json).toEqual({ received: true, handled: true, kind: "subscription_created" });
    expect(tables.subscriptions).toHaveLength(1);
    const payments = using<Payments>(kernel, "payments@1");
    const again = await payments.webhook(envWith(), new Request(`http://x${WEBHOOK_PATH}`, { method: "POST", body: payload, headers: await signed(payload) }));
    expect(again?.kind).toBe("subscription_created");
    expect(again?.subscription).toBe(String(tables.subscriptions[0]!.id));
    expect(tables.subscriptions).toHaveLength(1);
    await expect(payments.webhook(envWith(), new Request(`http://x${WEBHOOK_PATH}`, { method: "POST", body: payload }))).rejects.toThrow(/Lemon Squeezy webhook refused/);
  });
});

describe("what each event does to the rows", () => {
  const order = { store_id: 42, customer_id: 7, identifier: "104e18a2", order_number: 1, user_name: "Ada", user_email: "ada@b.test", currency: "USD", subtotal: 1999, total: 1999, status: "paid", refunded: false, first_order_item: { variant_id: 123, product_id: 5 } };

  test("order_created: the customer (email from the order, user from the checkout's custom data) and the payment keyed order_<id>; order_refunded marks it refunded", async () => {
    const { rows, tables } = memoryRows();
    const r = await applyEvent(rows, JSON.parse(event("order_created", "orders", "1", order)) as Row);
    expect(tables.customers).toEqual([{ id: tables.customers[0]!.id as string, provider: "lemonsqueezy", providerId: "7", email: "ada@b.test", user: "u1" }]);
    // the checkout's custom data comes back on the envelope and not on the object, so the row keeps it beside the object
    expect(tables.payments).toEqual([{ id: tables.payments[0]!.id as string, providerId: "order_1", customer: tables.customers[0]!.id as string, amount: 1999, currency: "USD", status: "succeeded", raw: { type: "orders", id: "1", attributes: order, meta: { custom_data: { voidbase_user: "u1" } } } }]);
    expect(r).toEqual({ kind: "order_created", customer: String(tables.customers[0]!.id), payment: String(tables.payments[0]!.id), raw: expect.any(Object) });
    await applyEvent(rows, JSON.parse(event("order_refunded", "orders", "1", { ...order, status: "refunded", refunded: true })) as Row);
    expect(tables.payments).toHaveLength(1);
    expect(tables.payments[0]!.status).toBe("refunded");
    await applyEvent(rows, JSON.parse(event("order_created", "orders", "2", { ...order, status: "pending" }, {})) as Row);
    expect(tables.payments[1]).toMatchObject({ providerId: "order_2", status: "pending" });
    expect(tables.payments[1]!.raw).toEqual({ type: "orders", id: "2", attributes: { ...order, status: "pending" } });
    expect(tables.customers).toHaveLength(1);
  });

  test("subscription_created, updated, cancelled, resumed, paused, unpaused, expired: one row, the statuses mapped, the order linked", async () => {
    const { rows, tables } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "lemonsqueezy", providerId: "7" }], payments: [{ id: "p1", providerId: "order_1", customer: "c1", status: "succeeded" }] });
    const sub = { customer_id: 7, order_id: 1, product_id: 5, variant_id: 123, user_email: "ada@b.test", status: "on_trial", cancelled: false, trial_ends_at: "2026-09-25T00:00:00.000000Z", renews_at: "2026-10-12T00:00:00.000000Z", ends_at: null, first_subscription_item: { id: 1, price_id: 9, quantity: 1 } };
    const r = await applyEvent(rows, JSON.parse(event("subscription_created", "subscriptions", "11", sub)) as Row);
    expect(tables.subscriptions).toEqual([{ id: tables.subscriptions[0]!.id as string, providerId: "11", customer: "c1", status: "trialing", price: "123", currentPeriodEnd: "2026-10-12T00:00:00.000Z", cancelAtPeriodEnd: false }]);
    expect(tables.payments[0]!.subscription).toBe(String(tables.subscriptions[0]!.id)); // the order that started it
    expect(r).toEqual({ kind: "subscription_created", customer: "c1", subscription: String(tables.subscriptions[0]!.id), payment: "p1", raw: expect.any(Object) });
    await applyEvent(rows, JSON.parse(event("subscription_updated", "subscriptions", "11", { ...sub, status: "active" })) as Row);
    expect(tables.subscriptions[0]!.status).toBe("active");
    // cancelled runs until ends_at: still active, with cancelAtPeriodEnd and the end date
    await applyEvent(rows, JSON.parse(event("subscription_cancelled", "subscriptions", "11", { ...sub, status: "cancelled", cancelled: true, ends_at: "2026-10-12T00:00:00.000000Z" })) as Row);
    expect(tables.subscriptions[0]).toMatchObject({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-10-12T00:00:00.000Z" });
    await applyEvent(rows, JSON.parse(event("subscription_resumed", "subscriptions", "11", { ...sub, status: "active", cancelled: false, renews_at: "2026-11-12T00:00:00.000000Z" })) as Row);
    expect(tables.subscriptions[0]).toMatchObject({ status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: "2026-11-12T00:00:00.000Z" });
    await applyEvent(rows, JSON.parse(event("subscription_paused", "subscriptions", "11", { ...sub, status: "paused" })) as Row);
    expect(tables.subscriptions[0]!.status).toBe("paused");
    await applyEvent(rows, JSON.parse(event("subscription_unpaused", "subscriptions", "11", { ...sub, status: "past_due" })) as Row);
    expect(tables.subscriptions[0]!.status).toBe("past_due");
    await applyEvent(rows, JSON.parse(event("subscription_expired", "subscriptions", "11", { ...sub, status: "expired", cancelled: true, ends_at: "2026-10-12T00:00:00.000000Z" })) as Row);
    expect(tables.subscriptions[0]).toMatchObject({ status: "canceled", cancelAtPeriodEnd: false });
    expect(tables.subscriptions).toHaveLength(1);
    expect(tables.customers).toHaveLength(1);
  });

  test("a subscription for a customer nobody has seen yet creates the customer row from the subscription", async () => {
    const { rows, tables } = memoryRows();
    await applyEvent(rows, JSON.parse(event("subscription_created", "subscriptions", "12", { customer_id: 8, user_email: "bob@b.test", status: "active", variant_id: 5 }, { voidbase_user: "u2" })) as Row);
    expect(tables.customers).toEqual([{ id: tables.customers[0]!.id as string, provider: "lemonsqueezy", providerId: "8", email: "bob@b.test", user: "u2" }]);
    expect(tables.subscriptions[0]).toMatchObject({ customer: tables.customers[0]!.id, price: "5", currentPeriodEnd: "", status: "active" });
  });

  test("subscription_payment_success, failed, recovered: an invoice payment keyed invoice_<id> linked to its subscription; the initial one is the order and is skipped", async () => {
    const { rows, tables } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "lemonsqueezy", providerId: "7" }], subscriptions: [{ id: "s1", customer: "c1", providerId: "11", status: "active" }] });
    const invoice = { store_id: 42, subscription_id: 11, customer_id: 7, user_email: "ada@b.test", billing_reason: "renewal", status: "paid", currency: "USD", subtotal: 1999, total: 1999, refunded: false };
    const skipped = await applyEvent(rows, JSON.parse(event("subscription_payment_success", "subscription-invoices", "1", { ...invoice, billing_reason: "initial" })) as Row);
    expect(skipped).toEqual({ kind: "subscription_payment_success", raw: expect.any(Object) });
    expect(tables.payments).toHaveLength(0);
    const r = await applyEvent(rows, JSON.parse(event("subscription_payment_success", "subscription-invoices", "1", invoice)) as Row);
    expect(tables.payments).toEqual([{ id: tables.payments[0]!.id as string, providerId: "invoice_1", customer: "c1", amount: 1999, currency: "USD", status: "succeeded", subscription: "s1", raw: expect.any(Object) }]);
    expect(r).toEqual({ kind: "subscription_payment_success", customer: "c1", subscription: "s1", payment: String(tables.payments[0]!.id), raw: expect.any(Object) });
    await applyEvent(rows, JSON.parse(event("subscription_payment_failed", "subscription-invoices", "2", { ...invoice, status: "pending" })) as Row);
    expect(tables.payments[1]).toMatchObject({ providerId: "invoice_2", status: "failed", subscription: "s1" });
    await applyEvent(rows, JSON.parse(event("subscription_payment_recovered", "subscription-invoices", "2", invoice)) as Row);
    expect(tables.payments).toHaveLength(2);
    expect(tables.payments[1]!.status).toBe("succeeded");
    await applyEvent(rows, JSON.parse(event("subscription_payment_refunded", "subscription-invoices", "2", { ...invoice, status: "refunded", refunded: true })) as Row);
    expect(tables.payments[1]!.status).toBe("refunded");
    // an order and an invoice can share a number: the prefixes keep them apart
    await applyEvent(rows, JSON.parse(event("order_created", "orders", "1", order)) as Row);
    expect(tables.payments.map((p) => p.providerId)).toEqual(["invoice_1", "invoice_2", "order_1"]);
  });

  test("a replayed event changes nothing: the same rows, the same count", async () => {
    const { rows, tables } = memoryRows();
    const events = [
      event("order_created", "orders", "1", order),
      event("subscription_created", "subscriptions", "11", { customer_id: 7, order_id: 1, variant_id: 123, user_email: "ada@b.test", status: "active", cancelled: false, renews_at: "2026-10-12T00:00:00.000000Z" }),
      event("subscription_payment_success", "subscription-invoices", "1", { subscription_id: 11, customer_id: 7, user_email: "ada@b.test", billing_reason: "initial", status: "paid", currency: "USD", total: 1999 }),
      event("subscription_payment_success", "subscription-invoices", "2", { subscription_id: 11, customer_id: 7, user_email: "ada@b.test", billing_reason: "renewal", status: "paid", currency: "USD", total: 1999 }),
    ];
    for (const e of events) await applyEvent(rows, JSON.parse(e) as Row);
    const snapshot = JSON.stringify(tables);
    for (const e of [...events, ...events]) await applyEvent(rows, JSON.parse(e) as Row);
    expect(JSON.stringify(tables)).toBe(snapshot);
    expect(tables.customers).toHaveLength(1);
    expect(tables.subscriptions).toHaveLength(1);
    expect(tables.payments).toHaveLength(2);
    expect(tables.payments.every((p) => p.subscription === tables.subscriptions[0]!.id)).toBe(true);
  });
});

// ---- the plugin's state ---------------------------------------------------------------------------

describe("the plugin without and with a key", () => {
  test("it loads beside stripe, requires payments@1 rather than providing it, and owns no collections of its own", async () => {
    const kernel = createKernel(new Hono() as never);
    const loaded = await load(kernel, [stripeWith(), lemonsqueezy], "0.9.0");
    expect(loaded.providers["payments@1"]).toBe("stripe");
    expect(loaded.tiers.lemonsqueezy).toBe("official");
    expect(lemonsqueezy.manifest.requires).toEqual(["payments@1"]);
    expect(lemonsqueezy.manifest.collections).toBeUndefined();
    expect(kernel.bootstraps.map((b) => b.plugin)).toEqual(["stripe", "lemonsqueezy"]);
  });

  test("without the key: no route, every call refuses naming the knob, and the collections are not created", async () => {
    const env = envWith({ [KEY_VAR]: "" } as Partial<Bindings>);
    expect(lemonsqueezy.payments.route(env)).toBeNull();
    await expect(lemonsqueezy.payments.checkout(env, { customer: "c1", items: [{ price: "1", quantity: 1 }], success: "https://a" })).rejects.toThrow(new RegExp(KEY_VAR));
    const { calls, f } = fakeFetch();
    const { post, kernel } = await appWith({ auth: ada, fetch: f, rows: memoryRows().rows, env: { [KEY_VAR]: "" } as Partial<Bindings> });
    const r = await post("/api/payments/lemonsqueezy/checkout", { items: [{ price: "1" }], success: "https://a" });
    expect(r.status).toBe(503);
    expect(String(r.json.message)).toContain(KEY_VAR);
    expect(calls).toHaveLength(0);
    const untouched = new Proxy({}, { get() { throw new Error("the database was touched"); } }) as unknown as D1Database;
    await kernel.bootstraps[1]!.run({ DB: untouched } as Bindings); // no key: nothing is created, the database is not read
  });

  test("with a key: the route names the webhook to register; test mode is the store's switch, so the key is live", () => {
    expect(lemonsqueezy.payments.route(envWith())).toEqual({ via: "lemonsqueezy", webhook: "/api/payments/lemonsqueezy/webhook", livemode: true });
  });
});
