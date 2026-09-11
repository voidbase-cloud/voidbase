// The polar plugin: the Standard Webhooks signature (both keys a whsec_ can mean), checkout, portal and cancel
// against a fake fetch, each webhook event's effect on the rows through in-memory rows, idempotent replay, the
// sandbox knob, and the no-key state. It joins stripe's family for payments@1, so the family test is
// payments-shared.test.ts; here polar is loaded alongside a keyless stripe.
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import type { Auth, Payments } from "../../src/server/interfaces";
import { createKernel, load, using } from "../../src/server/kernel";
import type { PaymentCollection, PaymentRows } from "../../src/server/plugins/payments-shared";
import {
  applyEvent, KEY_VAR, polar, polarWith, SANDBOX_VAR, signPayload, verifySignature, webhookKeys, WEBHOOK_PATH, WEBHOOK_SECRET_VAR,
} from "../../src/server/plugins/polar";
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
    if (!answer) return new Response(JSON.stringify({ detail: `unexpected ${key}` }), { status: 500 });
    const out = typeof answer === "function" ? answer(body, u) : answer;
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, f };
}

const users = { name: "users", id: "_pb_users_auth_" } as unknown as Collection;
const ada: AuthRecord = { collection: users, row: { id: "u1", email: "ada@b.test" } };
const bob: AuthRecord = { collection: users, row: { id: "u2", email: "bob@b.test" } };
const admin: AuthRecord = { collection: { name: "_superusers" } as unknown as Collection, row: { id: "admin" } };

const TOKEN = "polar_oat_abc";
// a Standard Webhooks secret: base64 after the prefix
const WHSEC = "whsec_" + btoa("a-signing-secret-of-32-bytes-len");
const envWith = (o: Partial<Bindings> = {}): Bindings => ({ DB: {} as D1Database, STORAGE: {} as R2Bucket, [KEY_VAR]: TOKEN, [WEBHOOK_SECRET_VAR]: WHSEC, ...o }) as Bindings;

async function appWith(o: { auth?: AuthRecord | null; fetch?: ReturnType<typeof fakeFetch>["f"]; rows?: PaymentRows; now?: () => number; env?: Partial<Bindings> } = {}) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
  app.use("*", async (c, next) => { c.set("auth", o.auth ?? null); await next(); });
  const kernel = createKernel(app);
  const rows = o.rows ? () => o.rows! : undefined;
  const plugin = polarWith({ fetch: o.fetch, rows, now: o.now });
  await load(kernel, [stripeWith({ fetch: o.fetch, rows, now: o.now }), plugin], "0.9.0");
  const env = envWith(o.env);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as Row };
  };
  return { app, kernel, plugin, env, post };
}

const T = 1_757_500_000; // a fixed "now", in unix seconds
const event = (type: string, data: Row): string => JSON.stringify({ type, timestamp: new Date(T * 1000).toISOString(), data });
const signed = async (payload: string, t = T, secret = WHSEC, id = "msg_1") => ({ "webhook-id": id, "webhook-timestamp": String(t), "webhook-signature": `v1,${await signPayload(secret, id, t, payload)}` });

// ---- the signature ----------------------------------------------------------------------------------

describe("the Standard Webhooks signature", () => {
  const payload = '{"type":"order.paid","data":{"id":"o_1"}}';
  const headers = (sig: string, t = T, id = "msg_1") => ({ id, timestamp: String(t), signature: sig });

  test("a whsec_ secret means two keys: its base64 bytes (Standard Webhooks) and its own UTF-8 (Polar HMAC)", () => {
    const keys = webhookKeys(WHSEC);
    expect(keys).toHaveLength(2);
    expect(new TextDecoder().decode(keys[0] as Uint8Array)).toBe("a-signing-secret-of-32-bytes-len");
    expect(keys[1]).toBe(WHSEC);
    expect(webhookKeys("not base64!")).toEqual(["not base64!"]);
  });

  test("a signature over id.timestamp.payload passes under either key, within the tolerance", async () => {
    const standard = await signPayload(WHSEC, "msg_1", T, payload);
    expect(standard).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await verifySignature(payload, headers(`v1,${standard}`), WHSEC, { now: T + 120 })).toEqual({ ok: true, t: T });
    const legacy = await signPayload(WHSEC, "msg_1", T, payload, "legacy");
    expect(legacy).not.toBe(standard);
    expect((await verifySignature(payload, headers(`v1,${legacy}`), WHSEC, { now: T })).ok).toBe(true);
    // several signatures separated by spaces, as the spec allows while a secret is rolled: one match is enough
    expect((await verifySignature(payload, headers(`v1,${btoa("nope")} v1,${standard}`), WHSEC, { now: T })).ok).toBe(true);
  });

  test("a wrong signature, a wrong secret, a changed payload, another id and missing headers are refused with the reason", async () => {
    const sig = await signPayload(WHSEC, "msg_1", T, payload);
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(await verifySignature(payload, headers(`v1,${flipped}`), WHSEC, { now: T })).toEqual({ ok: false, reason: "the signature does not match the payload" });
    expect((await verifySignature(payload, headers(`v1,${sig}`), "whsec_" + btoa("another secret"), { now: T })).ok).toBe(false);
    expect((await verifySignature(payload + " ", headers(`v1,${sig}`), WHSEC, { now: T })).ok).toBe(false);
    expect((await verifySignature(payload, headers(`v1,${sig}`, T, "msg_2"), WHSEC, { now: T })).ok).toBe(false);
    expect((await verifySignature(payload, headers(`v2,${sig}`), WHSEC, { now: T })).ok).toBe(false);
    expect(await verifySignature(payload, { id: null, timestamp: String(T), signature: `v1,${sig}` }, WHSEC, { now: T })).toEqual({ ok: false, reason: "webhook-id, webhook-timestamp and webhook-signature are all needed" });
    expect((await verifySignature(payload, headers(`v1,${sig}`), "", { now: T })).ok).toBe(false);
    expect((await verifySignature(payload, { id: "msg_1", timestamp: "soon", signature: `v1,${sig}` }, WHSEC, { now: T })).ok).toBe(false);
  });

  test("a stale timestamp is refused even with a valid signature: five minutes either way", async () => {
    const sig = await signPayload(WHSEC, "msg_1", T, payload);
    expect((await verifySignature(payload, headers(`v1,${sig}`), WHSEC, { now: T + 300 })).ok).toBe(true);
    const late = await verifySignature(payload, headers(`v1,${sig}`), WHSEC, { now: T + 301 });
    expect(late.ok).toBe(false);
    expect((late as { reason: string }).reason).toContain("301 seconds from now");
    expect((await verifySignature(payload, headers(`v1,${sig}`), WHSEC, { now: T - 301 })).ok).toBe(false);
  });
});

// ---- checkout, portal, cancel -----------------------------------------------------------------------

describe("checkout", () => {
  test("the first checkout looks the customer up by email, creates it with the user as external_id, then the checkout; the answer is its url", async () => {
    const { calls, f } = fakeFetch({
      "GET /v1/customers/": { items: [] },
      "POST /v1/customers/": { id: "cus_p1", email: "ada@b.test", external_id: "u1" },
      "POST /v1/checkouts/": { id: "co_1", url: "https://polar.sh/checkout/co_1", status: "open" },
    });
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/polar/checkout", { items: [{ price: "prod_1", quantity: 1 }, { price: "prod_2" }], success: "https://app.test/ok" });
    expect(r).toEqual({ status: 200, json: { url: "https://polar.sh/checkout/co_1" } });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.polar.sh/v1/customers/?email=ada%40b.test&limit=1",
      "POST https://api.polar.sh/v1/customers/",
      "POST https://api.polar.sh/v1/checkouts/",
    ]);
    for (const c of calls) expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]!.headers["content-type"]).toBe("application/json");
    expect(calls[1]!.body).toEqual({ email: "ada@b.test", external_id: "u1", metadata: { voidbase_user: "u1", voidbase_collection: "users" } });
    expect(tables.customers).toEqual([{ id: tables.customers[0]!.id as string, user: "u1", provider: "polar", providerId: "cus_p1", email: "ada@b.test" }]);
    const customerRow = String(tables.customers[0]!.id);
    expect(calls[2]!.body).toEqual({ products: ["prod_1", "prod_2"], customer_id: "cus_p1", customer_email: "ada@b.test", success_url: "https://app.test/ok", metadata: { voidbase_customer: customerRow, voidbase_user: "u1" } });
  });

  test("a customer Polar already knows by email is reused, not created; a customers row already there means no lookup at all", async () => {
    const { calls, f } = fakeFetch({ "GET /v1/customers/": { items: [{ id: "cus_old", email: "ada@b.test" }] }, "POST /v1/checkouts/": { url: "https://polar.sh/checkout/co_2" } });
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    expect((await post("/api/payments/polar/checkout", { items: [{ price: "prod_1" }], success: "https://a/ok" })).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(tables.customers[0]!.providerId).toBe("cus_old");
    expect((await post("/api/payments/polar/checkout", { items: [{ price: "prod_1" }], success: "https://a/ok" })).status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body.customer_id).toBe("cus_old");
  });

  test("the sandbox knob points every call at sandbox-api.polar.sh and the route says it is not live", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/checkouts/": { url: "https://sandbox.polar.sh/checkout/co_3" } });
    const { rows } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "polar", providerId: "cus_p1", email: "" }] });
    const { post, plugin, env } = await appWith({ auth: ada, fetch: f, rows, env: { [SANDBOX_VAR]: "1" } as Partial<Bindings> });
    expect((await post("/api/payments/polar/checkout", { items: [{ price: "prod_1" }], success: "https://a/ok" })).status).toBe(200);
    expect(calls[0]!.url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
    expect(plugin.payments.route(env)).toEqual({ via: "polar", webhook: "/api/payments/polar/webhook", livemode: false });
    expect(polar.payments.route(envWith())).toEqual({ via: "polar", webhook: "/api/payments/polar/webhook", livemode: true });
  });

  test("the body is checked before Polar is called, and a signed-out request is 401", async () => {
    const { calls, f } = fakeFetch();
    const { post } = await appWith({ auth: ada, fetch: f, rows: memoryRows().rows });
    expect((await post("/api/payments/polar/checkout", { items: [], success: "https://a" })).status).toBe(400);
    expect((await post("/api/payments/polar/checkout", { items: [{ price: "p", quantity: 0 }], success: "https://a" })).status).toBe(400);
    expect((await post("/api/payments/polar/checkout", { items: [{ price: "p" }] })).status).toBe(400);
    expect((await post("/api/payments/polar/checkout", { items: [{ price: "p" }], success: "https://a", mode: "setup" })).status).toBe(400);
    expect((await post("/api/payments/polar/checkout", "not json")).status).toBe(400);
    expect(calls).toHaveLength(0);
    const out = await appWith({ auth: null, fetch: f, rows: memoryRows().rows });
    expect((await out.post("/api/payments/polar/checkout", { items: [{ price: "p" }], success: "https://a" })).status).toBe(401);
  });

  test("Polar's refusal is passed on as a 400 with its detail, and its outage as a 502", async () => {
    const { f } = fakeFetch({ "POST /v1/checkouts/": () => new Response(JSON.stringify({ detail: [{ loc: ["body", "products"], msg: "Product not found" }] }), { status: 422 }) });
    const { rows } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "polar", providerId: "cus_p1" }] });
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/polar/checkout", { items: [{ price: "prod_x" }], success: "https://a" });
    expect(r.status).toBe(400);
    expect(String(r.json.message)).toContain("Polar answered 422");
    expect(String(r.json.message)).toContain("Product not found");
    const down = fakeFetch({ "POST /v1/checkouts/": () => new Response("bad gateway", { status: 503 }) });
    const again = await appWith({ auth: ada, fetch: down.f, rows });
    expect((await again.post("/api/payments/polar/checkout", { items: [{ price: "prod_x" }], success: "https://a" })).status).toBe(502);
  });
});

describe("the customer portal", () => {
  test("a customer session for the signed-in user's customer: POST /v1/customer-sessions/ answers customer_portal_url", async () => {
    const { calls, f } = fakeFetch({ "POST /v1/customer-sessions/": { token: "t", customer_portal_url: "https://polar.sh/portal/x" } });
    const { rows } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "polar", providerId: "cus_p7" }] });
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/polar/portal", { return: "https://app.test/account" });
    expect(r).toEqual({ status: 200, json: { url: "https://polar.sh/portal/x" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.polar.sh/v1/customer-sessions/");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({ customer_id: "cus_p7", return_url: "https://app.test/account" });
    expect((await post("/api/payments/polar/portal", {})).status).toBe(400);
  });
});

describe("cancel", () => {
  const seed = () => memoryRows({
    customers: [{ id: "c1", user: "u1", provider: "polar", providerId: "cus_p1" }],
    subscriptions: [{ id: "s1", customer: "c1", providerId: "sub_p1", status: "active", cancelAtPeriodEnd: false }],
  });
  afterEach(() => provideAuthLookup(() => undefined));

  test("the owner cancels at the period's end by default: one PATCH with cancel_at_period_end, the row follows", async () => {
    const { calls, f } = fakeFetch({ "PATCH /v1/subscriptions/sub_p1": { id: "sub_p1", status: "active", cancel_at_period_end: true } });
    const { rows, tables } = seed();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/polar/cancel", { subscription: "s1" });
    expect(r).toEqual({ status: 200, json: { subscription: "s1", status: "active", cancelAtPeriodEnd: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.polar.sh/v1/subscriptions/sub_p1");
    expect(calls[0]!.body).toEqual({ cancel_at_period_end: true });
    expect(tables.subscriptions[0]!.cancelAtPeriodEnd).toBe(true);
  });

  test("now: true revokes the subscription with DELETE and the row is canceled; resume: true takes a cancellation back", async () => {
    const { calls, f } = fakeFetch({ "DELETE /v1/subscriptions/sub_p1": { id: "sub_p1", status: "canceled" }, "PATCH /v1/subscriptions/sub_p1": { id: "sub_p1", status: "active", cancel_at_period_end: false } });
    const { rows, tables } = seed();
    const { post } = await appWith({ auth: ada, fetch: f, rows });
    const r = await post("/api/payments/polar/cancel", { subscription: "s1", now: true });
    expect(r.json).toEqual({ subscription: "s1", status: "canceled", cancelAtPeriodEnd: false });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(tables.subscriptions[0]!.status).toBe("canceled");
    tables.subscriptions[0]!.cancelAtPeriodEnd = true;
    const back = await post("/api/payments/polar/cancel", { subscription: "s1", resume: true });
    expect(back.json).toEqual({ subscription: "s1", status: "active", cancelAtPeriodEnd: false });
    expect(calls[1]!.body).toEqual({ cancel_at_period_end: false });
  });

  test("somebody else's subscription is 403 and Polar is never called; a superuser may; an unknown id is 404", async () => {
    const { calls, f } = fakeFetch({ "PATCH /v1/subscriptions/sub_p1": { id: "sub_p1", status: "active", cancel_at_period_end: true } });
    const { rows } = seed();
    const asBob = await appWith({ auth: bob, fetch: f, rows });
    expect((await asBob.post("/api/payments/polar/cancel", { subscription: "s1" })).status).toBe(403);
    expect(calls).toHaveLength(0);
    provideAuthLookup(() => ({ isSuperuser: (r) => r?.row.id === "admin" }) as unknown as Auth);
    const asAdmin = await appWith({ auth: admin, fetch: f, rows });
    expect((await asAdmin.post("/api/payments/polar/cancel", { subscription: "s1" })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await asAdmin.post("/api/payments/polar/cancel", { subscription: "nope" })).status).toBe(404);
    expect((await asAdmin.post("/api/payments/polar/cancel", {})).status).toBe(400);
  });
});

// ---- the webhook ------------------------------------------------------------------------------------

describe("the webhook route", () => {
  test("a bad, missing or stale signature is 400 and nothing is written; an unknown event is 200 and ignored", async () => {
    const { rows, tables } = memoryRows();
    const { post } = await appWith({ rows, now: () => T });
    const payload = event("order.paid", { id: "o_1", customer_id: "cus_p1", total_amount: 500, currency: "eur", paid: true });
    expect((await post(WEBHOOK_PATH, payload, { "webhook-id": "m", "webhook-timestamp": String(T), "webhook-signature": `v1,${btoa("a".repeat(32))}` })).status).toBe(400);
    expect((await post(WEBHOOK_PATH, payload)).status).toBe(400);
    expect((await post(WEBHOOK_PATH, payload, await signed(payload, T - 3600))).status).toBe(400);
    expect(tables.payments).toHaveLength(0);
    const other = event("benefit_grant.created", { id: "bg_1" });
    expect(await post(WEBHOOK_PATH, other, await signed(other))).toEqual({ status: 200, json: { received: true, handled: false } });
    expect(tables.customers).toHaveLength(0);
  });

  test("without the webhook secret the route says so with 503 rather than accepting anything", async () => {
    const { rows } = memoryRows();
    const { post } = await appWith({ rows, env: { [WEBHOOK_SECRET_VAR]: "" } as Partial<Bindings> });
    const payload = event("order.paid", { id: "o_1" });
    const r = await post(WEBHOOK_PATH, payload, await signed(payload));
    expect(r.status).toBe(503);
    expect(String(r.json.message)).toContain(WEBHOOK_SECRET_VAR);
  });

  test("a verified event reaches the rows, and the Payments interface (stripe's, the family's) routes it to polar by path", async () => {
    const { rows, tables } = memoryRows();
    const { post, kernel } = await appWith({ rows, now: () => T });
    const payload = event("subscription.created", { id: "sub_p1", status: "active", customer_id: "cus_p1", customer: { id: "cus_p1", email: "ada@b.test", external_id: "u1" }, prices: [{ id: "price_p1" }], current_period_end: "2026-10-11T00:00:00Z", cancel_at_period_end: false });
    expect((await post(WEBHOOK_PATH, payload, await signed(payload))).json).toEqual({ received: true, handled: true, kind: "subscription.created" });
    expect(tables.subscriptions).toHaveLength(1);
    const payments = using<Payments>(kernel, "payments@1");
    const again = await payments.webhook(envWith(), new Request(`http://x${WEBHOOK_PATH}`, { method: "POST", body: payload, headers: await signed(payload) }));
    expect(again?.kind).toBe("subscription.created");
    expect(again?.subscription).toBe(String(tables.subscriptions[0]!.id));
    expect(tables.subscriptions).toHaveLength(1);
    await expect(payments.webhook(envWith(), new Request(`http://x${WEBHOOK_PATH}`, { method: "POST", body: payload }))).rejects.toThrow(/Polar webhook refused/);
  });
});

describe("what each event does to the rows", () => {
  const checkout = { id: "co_1", status: "succeeded", customer_id: "cus_p9", customer_email: "ada@b.test", external_customer_id: "u1", metadata: { voidbase_customer: "c_x", voidbase_user: "u1" }, subscription_id: null, product_id: "prod_1", total_amount: 1999, currency: "usd" };

  test("checkout.updated: once succeeded, the customer with email and user from the checkout; other statuses are ignored", async () => {
    const { rows, tables } = memoryRows();
    expect(await applyEvent(rows, JSON.parse(event("checkout.updated", { ...checkout, status: "confirmed" })) as Row)).toBeNull();
    expect(tables.customers).toHaveLength(0);
    const r = await applyEvent(rows, JSON.parse(event("checkout.updated", checkout)) as Row);
    expect(tables.customers).toEqual([{ id: tables.customers[0]!.id as string, provider: "polar", providerId: "cus_p9", email: "ada@b.test", user: "u1" }]);
    expect(tables.payments).toHaveLength(0); // the order events carry the money
    expect(r).toEqual({ kind: "checkout.updated", customer: String(tables.customers[0]!.id), raw: checkout });
  });

  test("order.created then order.paid: one payments row, pending then succeeded, linked to its subscription; order.refunded marks it refunded", async () => {
    const { rows, tables } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "polar", providerId: "cus_p1" }], subscriptions: [{ id: "s1", customer: "c1", providerId: "sub_p1", status: "active" }] });
    const order = { id: "o_1", status: "pending", paid: false, total_amount: 2500, net_amount: 2400, currency: "eur", billing_reason: "subscription_create", customer_id: "cus_p1", customer: { id: "cus_p1", email: "ada@b.test", external_id: "u1" }, subscription_id: "sub_p1", product_id: "prod_1" };
    const r = await applyEvent(rows, JSON.parse(event("order.created", order)) as Row);
    expect(tables.payments).toEqual([{ id: tables.payments[0]!.id as string, providerId: "o_1", customer: "c1", amount: 2500, currency: "eur", status: "pending", subscription: "s1", raw: order }]);
    expect(r).toEqual({ kind: "order.created", customer: "c1", subscription: "s1", payment: String(tables.payments[0]!.id), raw: order });
    expect(tables.customers[0]!.email).toBe("ada@b.test"); // filled in from the order, since the row had none
    await applyEvent(rows, JSON.parse(event("order.paid", { ...order, status: "paid", paid: true })) as Row);
    expect(tables.payments).toHaveLength(1);
    expect(tables.payments[0]!.status).toBe("succeeded");
    await applyEvent(rows, JSON.parse(event("order.refunded", { ...order, status: "refunded", paid: true })) as Row);
    expect(tables.payments[0]!.status).toBe("refunded");
    // an order for a customer nobody has seen, with no subscription, still lands
    await applyEvent(rows, JSON.parse(event("order.paid", { id: "o_2", status: "paid", paid: true, total_amount: 100, currency: "usd", customer_id: "cus_p2", customer: { id: "cus_p2", email: "bob@b.test" } })) as Row);
    expect(tables.payments[1]).toMatchObject({ providerId: "o_2", status: "succeeded", customer: tables.customers[1]!.id });
    expect(tables.payments[1]!.subscription).toBeUndefined();
    expect(tables.customers[1]).toMatchObject({ providerId: "cus_p2", email: "bob@b.test" });
  });

  test("subscription.created, updated, active, canceled, revoked: one row per subscription, following the status", async () => {
    const { rows, tables } = memoryRows({ customers: [{ id: "c1", user: "u1", provider: "polar", providerId: "cus_p1" }] });
    const sub = { id: "sub_p1", status: "trialing", customer_id: "cus_p1", customer: { id: "cus_p1", email: "ada@b.test", external_id: "u1" }, product_id: "prod_1", prices: [{ id: "price_p1", amount_type: "fixed" }], current_period_end: "2025-10-09T08:53:20Z", cancel_at_period_end: false, amount: 1000, currency: "usd" };
    await applyEvent(rows, JSON.parse(event("subscription.created", sub)) as Row);
    expect(tables.subscriptions).toEqual([{ id: tables.subscriptions[0]!.id as string, providerId: "sub_p1", customer: "c1", status: "trialing", price: "price_p1", currentPeriodEnd: "2025-10-09T08:53:20.000Z", cancelAtPeriodEnd: false }]);
    await applyEvent(rows, JSON.parse(event("subscription.active", { ...sub, status: "active" })) as Row);
    expect(tables.subscriptions[0]!.status).toBe("active");
    const r = await applyEvent(rows, JSON.parse(event("subscription.canceled", { ...sub, status: "active", cancel_at_period_end: true, current_period_end: "2025-10-10T08:53:20Z", prices: [{ id: "price_p2" }] })) as Row);
    expect(tables.subscriptions).toHaveLength(1);
    expect(tables.subscriptions[0]).toMatchObject({ status: "active", price: "price_p2", currentPeriodEnd: "2025-10-10T08:53:20.000Z", cancelAtPeriodEnd: true });
    expect(r).toEqual({ kind: "subscription.canceled", customer: "c1", subscription: String(tables.subscriptions[0]!.id), raw: expect.any(Object) });
    await applyEvent(rows, JSON.parse(event("subscription.updated", { ...sub, status: "past_due" })) as Row);
    expect(tables.subscriptions[0]!.status).toBe("past_due");
    await applyEvent(rows, JSON.parse(event("subscription.revoked", { ...sub, status: "canceled" })) as Row);
    expect(tables.subscriptions[0]!.status).toBe("canceled");
    expect(tables.customers).toHaveLength(1);
  });

  test("a subscription for a customer nobody has seen yet creates the customer row from the embedded customer", async () => {
    const { rows, tables } = memoryRows();
    await applyEvent(rows, JSON.parse(event("subscription.created", { id: "sub_p2", status: "active", customer_id: "cus_p2", customer: { id: "cus_p2", email: "bob@b.test", external_id: "u2" }, prices: [] })) as Row);
    expect(tables.customers).toEqual([{ id: tables.customers[0]!.id as string, provider: "polar", providerId: "cus_p2", email: "bob@b.test", user: "u2" }]);
    expect(tables.subscriptions[0]).toMatchObject({ customer: tables.customers[0]!.id, price: "", currentPeriodEnd: "" });
  });

  test("a replayed event changes nothing: the same rows, the same count", async () => {
    const { rows, tables } = memoryRows();
    const events = [
      event("checkout.updated", checkout),
      event("subscription.created", { id: "sub_p1", status: "active", customer_id: "cus_p9", customer: { id: "cus_p9", email: "ada@b.test", external_id: "u1" }, prices: [{ id: "price_p1" }], current_period_end: "2026-10-11T00:00:00Z" }),
      event("order.paid", { id: "o_1", status: "paid", paid: true, total_amount: 1999, currency: "usd", customer_id: "cus_p9", subscription_id: "sub_p1" }),
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
  test("it loads beside stripe, requires payments@1 rather than providing it, and owns no collections of its own", async () => {
    const kernel = createKernel(new Hono() as never);
    const anchor = stripeWith();
    const loaded = await load(kernel, [anchor, polar], "0.9.0");
    expect(loaded.providers["payments@1"]).toBe("stripe");
    expect(loaded.tiers.polar).toBe("official");
    expect(polar.manifest.requires).toEqual(["payments@1"]);
    expect(polar.manifest.collections).toBeUndefined();
    expect(kernel.bootstraps.map((b) => b.plugin)).toEqual(["stripe", "polar"]);
  });

  test("alone it does not load: the loader says payments@1 is missing", async () => {
    await expect(load(createKernel(new Hono() as never), [polarWith()], "0.9.0")).rejects.toThrow(/polar requires "payments@1"/);
  });

  test("without the token: no route, every call refuses naming the knob, and the collections are not created", async () => {
    const env = envWith({ [KEY_VAR]: "" } as Partial<Bindings>);
    expect(polar.payments.route(env)).toBeNull();
    await expect(polar.payments.checkout(env, { customer: "c1", items: [{ price: "p", quantity: 1 }], success: "https://a" })).rejects.toThrow(new RegExp(KEY_VAR));
    const { calls, f } = fakeFetch();
    const { post, kernel } = await appWith({ auth: ada, fetch: f, rows: memoryRows().rows, env: { [KEY_VAR]: "" } as Partial<Bindings> });
    const r = await post("/api/payments/polar/checkout", { items: [{ price: "p" }], success: "https://a" });
    expect(r.status).toBe(503);
    expect(String(r.json.message)).toContain(KEY_VAR);
    expect(calls).toHaveLength(0);
    const untouched = new Proxy({}, { get() { throw new Error("the database was touched"); } }) as unknown as D1Database;
    await kernel.bootstraps[1]!.run({ DB: untouched } as Bindings); // no token: nothing is created, the database is not read
  });

  test("with a token: the route names the webhook to register and whether it is live", () => {
    expect(polar.payments.route(envWith())).toEqual({ via: "polar", webhook: "/api/payments/polar/webhook", livemode: true });
    expect(polar.payments.route(envWith({ [SANDBOX_VAR]: "true" } as Partial<Bindings>))?.livemode).toBe(false);
  });
});
