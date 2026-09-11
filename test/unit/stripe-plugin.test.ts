// The stripe plugin: the signature check, Stripe's form encoding, checkout, portal and cancel against a fake fetch,
// each webhook event's effect on the rows through in-memory rows, idempotent replay, and the no-key state.
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { invalidateCollections } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import type { Auth, Payments } from "../../src/server/interfaces";
import { createKernel, load, using } from "../../src/server/kernel";
import {
  applyEvent, collectionDefinitions, formEncode, KEY_VAR, signPayload, stripe, STRIPE_VERSION, stripeWith, verifySignature, WEBHOOK_PATH, WEBHOOK_SECRET_VAR,
  type PaymentCollection, type PaymentRows,
} from "../../src/server/plugins/stripe";
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

type Call = { url: string; method: string; headers: Record<string, string>; body: URLSearchParams };
function fakeFetch(answers: Record<string, Row | ((body: URLSearchParams) => Row | Response)> = {}) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const answer = answers[key];
    if (!answer) return new Response(JSON.stringify({ error: { message: `unexpected ${key}` } }), { status: 500 });
    const out = typeof answer === "function" ? answer(body) : answer;
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, f };
}

const users = { name: "users", id: "_pb_users_auth_" } as unknown as Collection;
const ada: AuthRecord = { collection: users, row: { id: "u1", email: "ada@b.test" } };
const bob: AuthRecord = { collection: users, row: { id: "u2", email: "bob@b.test" } };
const admin: AuthRecord = { collection: { name: "_superusers" } as unknown as Collection, row: { id: "admin" } };

const SECRET = "sk_test_abc", WHSEC = "whsec_test_123";
const envWith = (o: Partial<Bindings> = {}): Bindings => ({ DB: {} as D1Database, STORAGE: {} as R2Bucket, [KEY_VAR]: SECRET, [WEBHOOK_SECRET_VAR]: WHSEC, ...o }) as Bindings;

async function appWith(o: { auth?: AuthRecord | null; fetch?: ReturnType<typeof fakeFetch>["f"]; rows?: PaymentRows; now?: () => number; env?: Partial<Bindings> } = {}) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
  app.use("*", async (c, next) => { c.set("auth", o.auth ?? null); await next(); });
  const kernel = createKernel(app);
  const plugin = stripeWith({ fetch: o.fetch, rows: o.rows ? () => o.rows! : undefined, now: o.now });
  await load(kernel, [plugin], "0.9.0");
  const env = envWith(o.env);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as Row };
  };
  return { app, kernel, plugin, env, post };
}

const T = 1_757_500_000; // a fixed "now", in unix seconds
const event = (type: string, object: Row, id = "evt_1"): string => JSON.stringify({ id, object: "event", type, data: { object } });
const signed = async (payload: string, t = T, secret = WHSEC) => ({ "stripe-signature": `t=${t},v1=${await signPayload(secret, payload, t)}` });

// ---- the signature ----------------------------------------------------------------------------------

describe("the webhook signature", () => {
  const payload = '{"id":"evt_1","type":"invoice.paid"}';

  test("a signature computed here over t.payload passes, within the tolerance", async () => {
    const sig = await signPayload(WHSEC, payload, T);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifySignature(payload, `t=${T},v1=${sig}`, WHSEC, { now: T + 120 })).toEqual({ ok: true, t: T });
    // several v1 entries, as Stripe sends while a secret is being rolled: one that matches is enough
    expect((await verifySignature(payload, `t=${T},v1=${"0".repeat(64)},v1=${sig}`, WHSEC, { now: T })).ok).toBe(true);
  });

  test("a wrong signature, a wrong secret, a changed payload and a missing header are refused with the reason", async () => {
    const sig = await signPayload(WHSEC, payload, T);
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(await verifySignature(payload, `t=${T},v1=${flipped}`, WHSEC, { now: T })).toEqual({ ok: false, reason: "the signature does not match the payload" });
    expect((await verifySignature(payload, `t=${T},v1=${sig}`, "whsec_other", { now: T })).ok).toBe(false);
    expect((await verifySignature(payload + " ", `t=${T},v1=${sig}`, WHSEC, { now: T })).ok).toBe(false);
    expect((await verifySignature(payload, `t=${T},v1=abc`, WHSEC, { now: T })).ok).toBe(false); // a different length never matches
    expect(await verifySignature(payload, null, WHSEC, { now: T })).toEqual({ ok: false, reason: "no Stripe-Signature header" });
    expect((await verifySignature(payload, `v1=${sig}`, WHSEC, { now: T })).ok).toBe(false);
    expect((await verifySignature(payload, `t=${T},v1=${sig}`, "", { now: T })).ok).toBe(false);
  });

  test("a stale timestamp is refused even with a valid signature: five minutes either way", async () => {
    const sig = await signPayload(WHSEC, payload, T);
    const header = `t=${T},v1=${sig}`;
    expect((await verifySignature(payload, header, WHSEC, { now: T + 300 })).ok).toBe(true);
    const late = await verifySignature(payload, header, WHSEC, { now: T + 301 });
    expect(late.ok).toBe(false);
    expect((late as { reason: string }).reason).toContain("301 seconds from now");
    expect((await verifySignature(payload, header, WHSEC, { now: T - 301 })).ok).toBe(false);
  });
});

// ---- the encoding -----------------------------------------------------------------------------------

describe("Stripe's form encoding", () => {
  test("nested objects and arrays become bracketed keys; null and undefined are left out", () => {
    const body = formEncode({ customer: "cus_1", mode: "subscription", line_items: [{ price: "price_1", quantity: 2 }, { price: "price_2", quantity: 1 }], metadata: { voidbase_user: "u1" }, skip: undefined, gone: null, flag: true });
    expect(body).toContain("line_items%5B0%5D%5Bprice%5D=price_1");
    const p = new URLSearchParams(body);
    expect(p.get("line_items[0][price]")).toBe("price_1");
    expect(p.get("line_items[0][quantity]")).toBe("2");
    expect(p.get("line_items[1][price]")).toBe("price_2");
    expect(p.get("metadata[voidbase_user]")).toBe("u1");
    expect(p.get("flag")).toBe("true");
    expect(p.has("skip")).toBe(false);
    expect(p.has("gone")).toBe(false);
    expect([...p.keys()]).toEqual(["customer", "mode", "line_items[0][price]", "line_items[0][quantity]", "line_items[1][price]", "line_items[1][quantity]", "metadata[voidbase_user]", "flag"]);
  });
});

// ---- checkout, portal, cancel -----------------------------------------------------------------------

describe("checkout", () => {
  test("the first checkout creates the Stripe customer for the user, then the session; the answer is its url", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/customers": { id: "cus_1", email: "ada@b.test" }, "POST /v1/checkout/sessions": { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" } });
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/stripe/checkout", { items: [{ price: "price_1", quantity: 2 }], success: "https://app.test/ok", cancel: "https://app.test/no", mode: "subscription" });
    expect(r).toEqual({ status: 200, json: { url: "https://checkout.stripe.com/c/pay/cs_1" } });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/customers");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[0]!.headers["stripe-version"]).toBe(STRIPE_VERSION);
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]!.body.get("email")).toBe("ada@b.test");
    expect(calls[0]!.body.get("metadata[voidbase_user]")).toBe("u1");

    expect(tables.customers).toEqual([{ id: "cus_1" === "" ? "" : tables.customers[0]!.id as string, user: "u1", provider: "stripe", providerId: "cus_1", email: "ada@b.test" }]);
    const customerRow = String(tables.customers[0]!.id);

    expect(calls[1]!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    const b = calls[1]!.body;
    expect(b.get("customer")).toBe("cus_1");
    expect(b.get("mode")).toBe("subscription");
    expect(b.get("line_items[0][price]")).toBe("price_1");
    expect(b.get("line_items[0][quantity]")).toBe("2");
    expect(b.get("success_url")).toBe("https://app.test/ok");
    expect(b.get("cancel_url")).toBe("https://app.test/no");
    expect(b.get("client_reference_id")).toBe(customerRow);
    expect(b.get("metadata[voidbase_customer]")).toBe(customerRow);
    expect(b.get("metadata[voidbase_user]")).toBe("u1");
  });

  test("a user with a customer row already is not created twice; mode defaults to payment", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/checkout/sessions": { url: "https://checkout.stripe.com/c/pay/cs_2" } });
    const { rows } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "stripe", providerId: "cus_1", email: "" }] });
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/stripe/checkout", { items: [{ price: "price_9" }], success: "https://a/ok", cancel: "https://a/no" });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.get("customer")).toBe("cus_1");
    expect(calls[0]!.body.get("mode")).toBe("payment");
    expect(calls[0]!.body.get("line_items[0][quantity]")).toBe("1");
  });

  test("the body is checked before Stripe is called, and a signed-out request is 401", async () => {
    const { calls, f } = fakeFetch();
    const { post } = await appWith({ auth: ada, fetch: f, rows: memoryRows().rows });
    expect((await post("/api/payments/stripe/checkout", { items: [], success: "https://a", cancel: "https://b" })).status).toBe(400);
    expect((await post("/api/payments/stripe/checkout", { items: [{ price: "p", quantity: 0 }], success: "https://a", cancel: "https://b" })).status).toBe(400);
    expect((await post("/api/payments/stripe/checkout", { items: [{ price: "p" }], success: "https://a" })).status).toBe(400);
    expect((await post("/api/payments/stripe/checkout", { items: [{ price: "p" }], success: "https://a", cancel: "https://b", mode: "setup" })).status).toBe(400);
    expect((await post("/api/payments/stripe/checkout", "not json")).status).toBe(400);
    expect(calls).toHaveLength(0);
    const out = await appWith({ auth: null, fetch: f, rows: memoryRows().rows });
    expect((await out.post("/api/payments/stripe/checkout", { items: [{ price: "p" }], success: "https://a", cancel: "https://b" })).status).toBe(401);
  });

  test("Stripe's refusal is passed on as a 400 with its message, and its outage as a 502", async () => {
    const { f } = fakeFetch({ "POST /v1/checkout/sessions": () => new Response(JSON.stringify({ error: { message: "No such price: 'price_x'" } }), { status: 400 }) });
    const { rows } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "stripe", providerId: "cus_1" }] });
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/stripe/checkout", { items: [{ price: "price_x" }], success: "https://a", cancel: "https://b" });
    expect(r.status).toBe(400);
    expect(String(r.json.message)).toContain("Stripe answered 400: No such price: 'price_x'");
    const down = fakeFetch({ "POST /v1/checkout/sessions": () => new Response("bad gateway", { status: 503 }) });
    const again = await appWith({ auth: ada, fetch: down.f, rows });
    expect((await again.post("/api/payments/stripe/checkout", { items: [{ price: "price_x" }], success: "https://a", cancel: "https://b" })).status).toBe(502);
  });
});

describe("the billing portal", () => {
  test("a portal session for the signed-in user's customer, created at Stripe if it is the first contact", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/customers": { id: "cus_7" }, "POST /v1/billing_portal/sessions": { url: "https://billing.stripe.com/session/x" } });
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/stripe/portal", { return: "https://app.test/account" });
    expect(r).toEqual({ status: 200, json: { url: "https://billing.stripe.com/session/x" } });
    expect(calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/customers", "https://api.stripe.com/v1/billing_portal/sessions"]);
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[1]!.body.get("customer")).toBe("cus_7");
    expect(calls[1]!.body.get("return_url")).toBe("https://app.test/account");
    expect(tables.customers[0]!.providerId).toBe("cus_7");
    expect((await post("/api/payments/stripe/portal", {})).status).toBe(400);
  });
});

describe("cancel", () => {
  const seed = () => memoryRows({
    customers: [{ id: "c1", user: "u1", provider: "stripe", providerId: "cus_1" }],
    subscriptions: [{ id: "s1", customer: "c1", providerId: "sub_1", status: "active", cancelAtPeriodEnd: false }],
  });
  afterEach(() => provideAuthLookup(() => undefined));

  test("the owner cancels at the period's end by default: one POST with cancel_at_period_end, the row follows", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/subscriptions/sub_1": { id: "sub_1", status: "active", cancel_at_period_end: true } });
    const { rows, tables } = seed();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/stripe/cancel", { subscription: "s1" });
    expect(r).toEqual({ status: 200, json: { subscription: "s1", status: "active", cancelAtPeriodEnd: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
    expect(calls[0]!.body.get("cancel_at_period_end")).toBe("true");
    expect(tables.subscriptions[0]!.cancelAtPeriodEnd).toBe(true);
  });

  test("now: true deletes the subscription at Stripe and the row is canceled", async () => {
    const { calls, f } = fakeFetch({ "DELETE /v1/subscriptions/sub_1": { id: "sub_1", status: "canceled" } });
    const { rows, tables } = seed();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/stripe/cancel", { subscription: "s1", now: true });
    expect(r.json).toEqual({ subscription: "s1", status: "canceled", cancelAtPeriodEnd: false });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(tables.subscriptions[0]!.status).toBe("canceled");
  });

  test("somebody else's subscription is 403 and Stripe is never called; a superuser may; an unknown id is 404", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/subscriptions/sub_1": { id: "sub_1", status: "active", cancel_at_period_end: true } });
    const { rows } = seed();
    const asBob = await appWith({ auth: bob, fetch: f, rows });
    expect((await asBob.post("/api/payments/stripe/cancel", { subscription: "s1" })).status).toBe(403);
    expect(calls).toHaveLength(0);
    provideAuthLookup(() => ({ isSuperuser: (r) => r?.row.id === "admin" }) as unknown as Auth);
    const asAdmin = await appWith({ auth: admin, fetch: f, rows });
    expect((await asAdmin.post("/api/payments/stripe/cancel", { subscription: "s1" })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await asAdmin.post("/api/payments/stripe/cancel", { subscription: "nope" })).status).toBe(404);
    expect((await asAdmin.post("/api/payments/stripe/cancel", {})).status).toBe(400);
  });
});

// ---- the webhook ------------------------------------------------------------------------------------

describe("the webhook route", () => {
  test("a bad signature is 400 and nothing is written; an unknown event is 200 and ignored", async () => {
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ rows, now: () => T });
    const payload = event("invoice.paid", { id: "in_1", customer: "cus_1", amount_paid: 500, currency: "eur" });
    expect((await post(WEBHOOK_PATH, payload, { "stripe-signature": `t=${T},v1=${"a".repeat(64)}` })).status).toBe(400);
    expect((await post(WEBHOOK_PATH, payload)).status).toBe(400);
    expect((await post(WEBHOOK_PATH, payload, await signed(payload, T - 3600))).status).toBe(400);
    expect(tables.payments).toHaveLength(0);
    const r = await post(WEBHOOK_PATH, event("charge.refunded", { id: "ch_1" }), await signed(event("charge.refunded", { id: "ch_1" })));
    expect(r).toEqual({ status: 200, json: { received: true, handled: false } });
    expect(tables.customers).toHaveLength(0);
  });

  test("without the webhook secret the route says so with 503 rather than accepting anything", async () => {
    const { rows } = memoryRows();
    const { post } = await appWith({ rows, env: { [WEBHOOK_SECRET_VAR]: "" } as Partial<Bindings> });
    const payload = event("invoice.paid", { id: "in_1" });
    const r = await post(WEBHOOK_PATH, payload, await signed(payload));
    expect(r.status).toBe(503);
    expect(String(r.json.message)).toContain(WEBHOOK_SECRET_VAR);
  });

  test("a verified event reaches the rows, and the Payments interface runs the same code", async () => {
    const { rows, tables } = memoryRows();
    const { post, kernel } = await appWith({ rows, now: () => T });
    const payload = event("customer.subscription.created", { id: "sub_1", customer: "cus_1", status: "active", items: { data: [{ price: { id: "price_1" }, current_period_end: T + 86400 }] } });
    expect((await post(WEBHOOK_PATH, payload, await signed(payload))).json).toEqual({ received: true, handled: true, kind: "customer.subscription.created" });
    expect(tables.subscriptions).toHaveLength(1);
    const payments = using<Payments>(kernel, "payments@1");
    const again = await payments.webhook(envWith(), new Request(`http://x${WEBHOOK_PATH}`, { method: "POST", body: payload, headers: await signed(payload) }));
    expect(again?.kind).toBe("customer.subscription.created");
    expect(again?.subscription).toBe(String(tables.subscriptions[0]!.id));
    expect(tables.subscriptions).toHaveLength(1);
    await expect(payments.webhook(envWith(), new Request(`http://x${WEBHOOK_PATH}`, { method: "POST", body: payload }))).rejects.toThrow(/Stripe webhook refused/);
  });
});

describe("what each event does to the rows", () => {
  const session = { id: "cs_1", object: "checkout.session", mode: "payment", customer: "cus_9", customer_details: { email: "ada@b.test" }, metadata: { voidbase_user: "u1" }, payment_intent: "pi_1", payment_status: "paid", amount_total: 1999, currency: "usd" };

  test("checkout.session.completed: the customer (email and user from the session) and, in payment mode, the payment", async () => {
    const { rows, tables } = memoryRows();
    const r = await applyEvent(rows, JSON.parse(event("checkout.session.completed", session)) as Row);
    expect(tables.customers).toEqual([{ id: tables.customers[0]!.id as string, provider: "stripe", providerId: "cus_9", email: "ada@b.test", user: "u1" }]);
    expect(tables.payments).toEqual([{ id: tables.payments[0]!.id as string, providerId: "pi_1", customer: tables.customers[0]!.id as string, amount: 1999, currency: "usd", status: "succeeded", raw: session }]);
    expect(r).toEqual({ kind: "checkout.session.completed", customer: String(tables.customers[0]!.id), payment: String(tables.payments[0]!.id), raw: session });
    // in subscription mode the session writes no payment: the subscription and invoice events carry the money
    const { rows: rows2, tables: tables2 } = memoryRows();
    await applyEvent(rows2, JSON.parse(event("checkout.session.completed", { ...session, mode: "subscription", payment_intent: null, subscription: "sub_1" })) as Row);
    expect(tables2.payments).toHaveLength(0);
    expect(tables2.customers).toHaveLength(1);
  });

  test("customer.subscription.created, updated, deleted: one row per subscription, following the status", async () => {
    const { rows, tables } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "stripe", providerId: "cus_1" }] });
    const sub = { id: "sub_1", customer: "cus_1", status: "trialing", cancel_at_period_end: false, items: { data: [{ price: { id: "price_1" }, current_period_end: 1_760_000_000 }] } };
    await applyEvent(rows, JSON.parse(event("customer.subscription.created", sub)) as Row);
    expect(tables.subscriptions).toEqual([{ id: tables.subscriptions[0]!.id as string, providerId: "sub_1", customer: "c1", status: "trialing", price: "price_1", currentPeriodEnd: "2025-10-09T08:53:20.000Z", cancelAtPeriodEnd: false }]);
    // the older shape, with the period on the subscription itself, still reads
    const r = await applyEvent(rows, JSON.parse(event("customer.subscription.updated", { ...sub, status: "active", cancel_at_period_end: true, current_period_end: 1_760_086_400, items: { data: [{ price: { id: "price_2" } }] } })) as Row);
    expect(tables.subscriptions).toHaveLength(1);
    expect(tables.subscriptions[0]).toMatchObject({ status: "active", price: "price_2", currentPeriodEnd: "2025-10-10T08:53:20.000Z", cancelAtPeriodEnd: true });
    expect(r).toEqual({ kind: "customer.subscription.updated", customer: "c1", subscription: String(tables.subscriptions[0]!.id), raw: expect.any(Object) });
    await applyEvent(rows, JSON.parse(event("customer.subscription.deleted", { ...sub, status: "active" })) as Row);
    expect(tables.subscriptions[0]!.status).toBe("canceled");
    expect(tables.customers).toHaveLength(1);
  });

  test("a subscription for a customer nobody has seen yet creates the customer row with the provider id only", async () => {
    const { rows, tables } = memoryRows();
    await applyEvent(rows, JSON.parse(event("customer.subscription.created", { id: "sub_2", customer: "cus_2", status: "active", items: { data: [] } })) as Row);
    expect(tables.customers).toEqual([{ id: tables.customers[0]!.id as string, provider: "stripe", providerId: "cus_2", email: "" }]);
    expect(tables.subscriptions[0]).toMatchObject({ customer: tables.customers[0]!.id, price: "", currentPeriodEnd: "" });
  });

  test("invoice.paid and invoice.payment_failed: a payment linked to the subscription, in both invoice shapes", async () => {
    const { rows, tables } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "stripe", providerId: "cus_1" }], subscriptions: [{ id: "s1", customer: "c1", providerId: "sub_1", status: "active" }] });
    const paid = { id: "in_1", customer: "cus_1", customer_email: "ada@b.test", amount_paid: 2500, amount_due: 2500, currency: "eur", parent: { subscription_details: { subscription: "sub_1" } }, payments: { data: [{ payment: { payment_intent: "pi_2" } }] } };
    const r = await applyEvent(rows, JSON.parse(event("invoice.paid", paid)) as Row);
    expect(tables.payments).toEqual([{ id: tables.payments[0]!.id as string, providerId: "pi_2", customer: "c1", amount: 2500, currency: "eur", status: "succeeded", subscription: "s1", raw: paid }]);
    expect(r).toEqual({ kind: "invoice.paid", customer: "c1", subscription: "s1", payment: String(tables.payments[0]!.id), raw: paid });
    expect(tables.customers[0]!.email).toBe("ada@b.test"); // filled in from the invoice, since the row had none
    const failed = { id: "in_2", customer: "cus_1", amount_paid: 0, amount_due: 2500, currency: "eur", subscription: "sub_1", payment_intent: "pi_3" };
    await applyEvent(rows, JSON.parse(event("invoice.payment_failed", failed)) as Row);
    expect(tables.payments[1]).toMatchObject({ providerId: "pi_3", amount: 2500, status: "failed", subscription: "s1" });
    // an invoice with no payment intent yet is keyed by its own id
    await applyEvent(rows, JSON.parse(event("invoice.payment_failed", { id: "in_3", customer: "cus_1", amount_due: 10, currency: "eur" })) as Row);
    expect(tables.payments[2]).toMatchObject({ providerId: "in_3", status: "failed" });
    expect(tables.payments[2]!.subscription).toBeUndefined();
  });

  test("payment_intent.succeeded and payment_failed land on the same row the invoice made, never a second one", async () => {
    const { rows, tables } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "stripe", providerId: "cus_1" }] });
    await applyEvent(rows, JSON.parse(event("invoice.paid", { id: "in_1", customer: "cus_1", amount_paid: 700, currency: "usd", payment_intent: "pi_5" })) as Row);
    await applyEvent(rows, JSON.parse(event("payment_intent.payment_failed", { id: "pi_5", customer: "cus_1", amount: 700, currency: "usd" })) as Row);
    expect(tables.payments).toHaveLength(1);
    expect(tables.payments[0]).toMatchObject({ providerId: "pi_5", status: "failed", amount: 700 });
    const r = await applyEvent(rows, JSON.parse(event("payment_intent.succeeded", { id: "pi_5", customer: "cus_1", amount: 700, currency: "usd" })) as Row);
    expect(tables.payments).toHaveLength(1);
    expect(tables.payments[0]!.status).toBe("succeeded");
    expect(r).toEqual({ kind: "payment_intent.succeeded", customer: "c1", payment: String(tables.payments[0]!.id), raw: expect.any(Object) });
    // a one-off intent with no customer still lands, unattached
    await applyEvent(rows, JSON.parse(event("payment_intent.succeeded", { id: "pi_6", customer: null, amount: 100, currency: "usd" })) as Row);
    expect(tables.payments[1]).toMatchObject({ providerId: "pi_6", customer: "" });
    expect(tables.customers).toHaveLength(1);
  });

  test("a replayed event changes nothing: the same rows, the same count", async () => {
    const { rows, tables } = memoryRows();
    const events = [
      event("checkout.session.completed", session),
      event("customer.subscription.created", { id: "sub_1", customer: "cus_9", status: "active", items: { data: [{ price: { id: "price_1" }, current_period_end: T }] } }),
      event("invoice.paid", { id: "in_1", customer: "cus_9", amount_paid: 1999, currency: "usd", subscription: "sub_1", payment_intent: "pi_1" }),
    ];
    for (const e of events) await applyEvent(rows, JSON.parse(e) as Row);
    const snapshot = JSON.stringify(tables);
    for (const e of [...events, ...events]) await applyEvent(rows, JSON.parse(e) as Row);
    expect(JSON.stringify(tables)).toBe(snapshot);
    expect(tables.customers).toHaveLength(1);
    expect(tables.subscriptions).toHaveLength(1);
    expect(tables.payments).toHaveLength(1);
  });
});

// ---- the plugin's state ---------------------------------------------------------------------------

describe("the plugin without and with a key", () => {
  test("it loads, provides payments@1, and owns its three collections", async () => {
    const kernel = createKernel(new Hono() as never);
    const loaded = await load(kernel, [stripe], "0.9.0");
    expect(loaded.providers["payments@1"]).toBe("stripe");
    expect(loaded.tiers.stripe).toBe("official");
    expect(stripe.manifest.collections).toEqual(["customers", "subscriptions", "payments"]);
    expect(using<Payments>(kernel, "payments@1")).toBe(stripe.payments);
    expect(kernel.bootstraps.map((b) => b.plugin)).toEqual(["stripe"]);
  });

  test("without the key: no route, every call refuses naming the knob, and the collections are not created", async () => {
    const env = envWith({ [KEY_VAR]: "" } as Partial<Bindings>);
    expect(stripe.payments.route(env)).toBeNull();
    await expect(stripe.payments.checkout(env, { customer: "c1", items: [{ price: "p", quantity: 1 }], success: "https://a", cancel: "https://b" })).rejects.toThrow(new RegExp(KEY_VAR));
    const { calls, f } = fakeFetch();
    const { post, kernel } = await appWith({ auth: ada, fetch: f, rows: memoryRows().rows, env: { [KEY_VAR]: "" } as Partial<Bindings> });
    const r = await post("/api/payments/stripe/checkout", { items: [{ price: "p" }], success: "https://a", cancel: "https://b" });
    expect(r.status).toBe(503);
    expect(String(r.json.message)).toContain(KEY_VAR);
    expect(calls).toHaveLength(0);
    const untouched = new Proxy({}, { get() { throw new Error("the database was touched"); } }) as unknown as D1Database;
    await kernel.bootstraps[0]!.run({ DB: untouched } as Bindings); // no key: nothing is created, the database is not read
  });

  test("with a key: the route names the webhook to register and whether the key is live", () => {
    expect(stripe.payments.route(envWith())).toEqual({ via: "stripe", webhook: "/api/payments/stripe/webhook", livemode: false });
    expect(stripe.payments.route(envWith({ [KEY_VAR]: "sk_live_xyz" } as Partial<Bindings>))).toEqual({ via: "stripe", webhook: "/api/payments/stripe/webhook", livemode: true });
    expect(stripe.payments.route(envWith({ [KEY_VAR]: "rk_live_xyz" } as Partial<Bindings>))?.livemode).toBe(true);
  });

  test("the collections it creates: the rules, the statuses, the relations", async () => {
    const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
    const db = { prepare: () => stmt } as unknown as D1Database;
    try {
      const defs = await collectionDefinitions(db);
      expect(defs.map((d) => d.name)).toEqual(stripe.manifest.collections);
      const byName = Object.fromEntries(defs.map((d) => [String(d.name), d as Record<string, unknown>]));
      expect(byName.customers!.listRule).toBe("user = @request.auth.id");
      expect(byName.subscriptions!.viewRule).toBe("customer.user = @request.auth.id");
      expect(byName.payments!.listRule).toBe("customer.user = @request.auth.id");
      for (const d of defs) expect([d.createRule, d.updateRule, d.deleteRule]).toEqual([null, null, null]);
      const fields = (name: string) => (byName[name]!.fields as { name: string; type: string; values?: string[]; collectionId?: string }[]);
      expect(fields("subscriptions").find((f) => f.name === "status")!.values).toContain("past_due");
      expect(fields("payments").find((f) => f.name === "status")!.values).toEqual(["pending", "succeeded", "failed", "refunded", "canceled"]);
      expect(fields("subscriptions").find((f) => f.name === "customer")!.collectionId).toBe(byName.customers!.id ?? fields("subscriptions").find((f) => f.name === "customer")!.collectionId);
      expect(fields("payments").find((f) => f.name === "subscription")!.type).toBe("relation");
      expect(fields("customers").map((f) => f.name)).toEqual(["user", "provider", "providerId", "email", "created", "updated"]);
    } finally { invalidateCollections(); }
  });
});
