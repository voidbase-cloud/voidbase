// Taking money through Stripe, as the plugin that provides `payments@1`.
//
// The roadmap's worked example: one plugin per provider, all of them providing the same interface, each owning its
// webhook route, verifying signatures, and writing customers, subscriptions and payments into collections the app
// queries like any other. This is the first one. It talks to Stripe's REST API with `fetch` alone (form-encoded
// bodies, a bearer key, one pinned API version) rather than the Stripe SDK, because the Worker bundle should not
// carry a client library for four endpoints.
//
// The key and the webhook secret are secrets and arrive with the request (pb_secrets/vb_secrets: `secret(...)` in
// env.ts), read from the request env first and the runtime env second, like the mail plugin's domain. So the
// provider answers per env: `route(env)` says where payments go with these bindings, or null when there is no key,
// and every other call refuses with the knob's name. Without the key the plugin is loaded and idle, and its three
// collections are not created either, so an instance that never takes money never sees them in the panel.
//
// The rows are written through the records service with a superuser context, so they look exactly like rows the
// panel wrote (ids, autodates, validation, hooks). Every write is an upsert by `providerId`, which is what makes a
// replayed webhook a no-op rather than a duplicate. Stripe's own retries and the "at least once" promise of every
// webhook are the reason.
import { env as voidEnv } from "#platform/env";
import { isSuperuser, requireAuth } from "../auth-slot";
import { loadCollections, findCollection } from "../collections/model";
import { collectionId } from "../collections/service";
import { ident, one } from "../db";
import { ApiError, badRequest, forbidden, notFound } from "../errors";
import type { Payments, PaymentsRoute, RealtimeClient } from "../interfaces";
import { onBootstrap, serve, type Kernel } from "../kernel";
import { createRecord, updateRecord, type RecordContext } from "../records/service";
import { rowToValues } from "../records/values";
import type { AppEnv, AuthRecord, Bindings, Row } from "../types";
import { ensureCollections } from "./collections";
import type { Plugin } from "./manifest";
import type { Context } from "hono";

export const STRIPE_API = "https://api.stripe.com";
/** the API version every call pins, so a change on Stripe's side arrives when this line changes and not before */
export const STRIPE_VERSION = "2025-08-27.basil";
export const KEY_VAR = "STRIPE_SECRET_KEY";
export const WEBHOOK_SECRET_VAR = "STRIPE_WEBHOOK_SECRET";
export const API = "/api/payments/stripe";
export const WEBHOOK_PATH = `${API}/webhook`;
/** how far a webhook's timestamp may be from now, in seconds: Stripe's own recommendation */
export const TOLERANCE_SECONDS = 300;
export const PROVIDER = "stripe";

const knob = (env: Bindings, name: string): string => String((env as unknown as Record<string, unknown>)[name] ?? (voidEnv as Record<string, unknown>)[name] ?? "").trim();
/** the secret key these bindings carry, or empty */
export const secretKey = (env: Bindings): string => knob(env, KEY_VAR);
/** the webhook signing secret these bindings carry, or empty */
export const webhookSecret = (env: Bindings): string => knob(env, WEBHOOK_SECRET_VAR);
/** whether a key is a live one: `sk_live_`, `rk_live_`; anything else is test mode */
export const isLive = (key: string): boolean => /^[a-z]+_live_/.test(key);

// ---- the wire -------------------------------------------------------------------------------------

/** Stripe's form encoding of nested params: `{ line_items: [{ price }] }` becomes `line_items[0][price]` */
export function formEncode(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const add = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${key}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) add(`${key}[${k}]`, x);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.toString();
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function call(fetchFn: Fetch, key: string, method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>): Promise<Row> {
  const body = params ? formEncode(params) : undefined;
  const res = await fetchFn(`${STRIPE_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "stripe-version": STRIPE_VERSION, ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    ...(body !== undefined ? { body } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) {
    const message = String((json.error as Row | undefined)?.message ?? res.statusText ?? "");
    throw new ApiError(res.status >= 500 ? 502 : 400, `Stripe answered ${res.status}${message ? `: ${message}` : ""}`);
  }
  return json;
}

// ---- the signature ----------------------------------------------------------------------------------

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC SHA-256 of `${t}.${payload}` under the signing secret, in hex: what Stripe puts in `v1=` */
export async function signPayload(secret: string, payload: string, t: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
}

/** every byte compared, whatever the first difference: the timing does not say where two signatures diverge */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * Check a `Stripe-Signature` header (`t=<unix seconds>,v1=<hex>[,v1=<hex>]`) against the payload as it arrived:
 * the signature is over `t.payload`, so the body is verified as bytes and parsed only afterwards. A timestamp more
 * than `tolerance` seconds from `now` is refused whatever the signature says, which is what closes replay.
 */
export async function verifySignature(payload: string, header: string | null, secret: string, o: { now?: number; tolerance?: number } = {}): Promise<{ ok: true; t: number } | { ok: false; reason: string }> {
  if (!secret) return { ok: false, reason: `no ${WEBHOOK_SECRET_VAR} to verify against` };
  if (!header) return { ok: false, reason: "no Stripe-Signature header" };
  let t = 0;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") sigs.push(v);
  }
  if (!Number.isFinite(t) || t <= 0) return { ok: false, reason: "no timestamp in Stripe-Signature" };
  if (!sigs.length) return { ok: false, reason: "no v1 signature in Stripe-Signature" };
  const expected = await signPayload(secret, payload, t);
  if (!sigs.some((s) => constantTimeEqual(s, expected))) return { ok: false, reason: "the signature does not match the payload" };
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const tolerance = o.tolerance ?? TOLERANCE_SECONDS;
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: `the timestamp is ${Math.abs(now - t)} seconds from now, more than the ${tolerance} allowed` };
  return { ok: true, t };
}

// ---- the rows -------------------------------------------------------------------------------------

export type PaymentCollection = "customers" | "subscriptions" | "payments";

/** where the plugin's rows live: D1 through the records service, or whatever a test hands in */
export interface PaymentRows {
  find(collection: PaymentCollection, where: Record<string, string>): Promise<Row | null>;
  create(collection: PaymentCollection, values: Row): Promise<Row>;
  update(collection: PaymentCollection, id: string, values: Row): Promise<Row>;
}

/** a realtime client for writes that happen outside a request: nothing is watching, nothing is recorded */
const idleRealtime: RealtimeClient = {
  active: () => false,
  publish: async () => undefined,
  presence: async () => null,
  publishToClient: async () => false,
  controlClient: async () => undefined,
  openSocket: async () => { throw new Error("voidbase: no realtime hub here"); },
};

/** the rows in D1, written through the records service as a superuser so they look like the panel wrote them */
export function d1Rows(env: Bindings, realtime?: RealtimeClient): PaymentRows {
  let pending: Promise<RecordContext> | undefined;
  const ctx = () => (pending ??= (async (): Promise<RecordContext> => ({
    db: env.DB, storage: env.STORAGE, auth: null, superuser: true,
    request: { auth: null, method: "POST", query: {}, headers: {}, body: {}, context: "default" },
    collections: await loadCollections(env.DB),
    realtime: realtime ?? idleRealtime,
  }))());
  const collection = async (name: PaymentCollection) => {
    const c = (await ctx()).collections.get(name);
    if (!c) throw new ApiError(503, `the stripe plugin's collection "${name}" does not exist yet; it is created on the first request that carries ${KEY_VAR}`);
    return c;
  };
  return {
    async find(name, where) {
      const c = await collection(name);
      const keys = Object.keys(where);
      const row = await one(env.DB, `SELECT * FROM ${ident(name)} WHERE ${keys.map((k) => `${ident(k)} = ?`).join(" AND ")} LIMIT 1`, keys.map((k) => where[k]));
      return row ? rowToValues(c, row) : null;
    },
    async create(name, values) { return (await createRecord(await ctx(), await collection(name), values, {})) as Row; },
    async update(name, id, values) { return (await updateRecord(await ctx(), await collection(name), id, values, {})) as Row; },
  };
}

export const SUBSCRIPTION_STATUSES = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"] as const;
export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "refunded", "canceled"] as const;

/** the three collections, as POST /api/collections would take them; `users` is the relation's target when it exists */
export async function collectionDefinitions(db: D1Database): Promise<Record<string, unknown>[]> {
  const users = (await findCollection(db, "users"))?.id ?? collectionId("auth", "users");
  const customers = collectionId("base", "customers"), subscriptions = collectionId("base", "subscriptions");
  const own = "customer.user = @request.auth.id";
  const autodates = [{ name: "created", type: "autodate", onCreate: true, onUpdate: false }, { name: "updated", type: "autodate", onCreate: true, onUpdate: true }];
  return [
    {
      name: "customers", type: "base", listRule: "user = @request.auth.id", viewRule: "user = @request.auth.id", createRule: null, updateRule: null, deleteRule: null,
      fields: [
        { name: "user", type: "relation", collectionId: users, maxSelect: 1, cascadeDelete: false },
        { name: "provider", type: "text", required: true },
        { name: "providerId", type: "text", required: true },
        { name: "email", type: "text" },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_customers_provider_id` ON `customers` (`provider`, `providerId`)"],
    },
    {
      name: "subscriptions", type: "base", listRule: own, viewRule: own, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        { name: "customer", type: "relation", collectionId: customers, maxSelect: 1, required: true, cascadeDelete: true },
        { name: "providerId", type: "text", required: true },
        { name: "status", type: "select", maxSelect: 1, values: [...SUBSCRIPTION_STATUSES] },
        { name: "price", type: "text" },
        { name: "currentPeriodEnd", type: "date" },
        { name: "cancelAtPeriodEnd", type: "bool" },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_subscriptions_provider_id` ON `subscriptions` (`providerId`)"],
    },
    {
      name: "payments", type: "base", listRule: own, viewRule: own, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        { name: "customer", type: "relation", collectionId: customers, maxSelect: 1, cascadeDelete: true },
        { name: "providerId", type: "text", required: true },
        { name: "amount", type: "number" },
        { name: "currency", type: "text" },
        { name: "status", type: "select", maxSelect: 1, values: [...PAYMENT_STATUSES] },
        { name: "subscription", type: "relation", collectionId: subscriptions, maxSelect: 1, cascadeDelete: false },
        { name: "raw", type: "json" },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_payments_provider_id` ON `payments` (`providerId`)"],
    },
  ];
}

// ---- what the webhook says, applied to the rows -----------------------------------------------------

const str = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? str((v as Row).id) : String(v));
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const unixToDate = (v: unknown): string => (typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : "");

/** the customer row behind a Stripe customer id, created when the webhook is the first to mention it */
async function ensureCustomer(rows: PaymentRows, providerId: string, extra: { email?: string; user?: string } = {}): Promise<Row | null> {
  if (!providerId) return null;
  const found = await rows.find("customers", { provider: PROVIDER, providerId });
  if (found) {
    const patch: Row = {};
    if (extra.email && !found.email) patch.email = extra.email;
    if (extra.user && !found.user) patch.user = extra.user;
    return Object.keys(patch).length ? rows.update("customers", str(found.id), patch) : found;
  }
  return rows.create("customers", { provider: PROVIDER, providerId, email: extra.email ?? "", ...(extra.user ? { user: extra.user } : {}) });
}

async function upsert(rows: PaymentRows, collection: "subscriptions" | "payments", providerId: string, values: Row): Promise<Row> {
  const found = await rows.find(collection, { providerId });
  return found ? rows.update(collection, str(found.id), values) : rows.create(collection, { providerId, ...values });
}

// Stripe's 2025 versions moved a few fields: a subscription's period now lives on its items, an invoice's
// subscription under `parent`, and its payment intent under `payments`. Both shapes are read.
const subscriptionPeriodEnd = (sub: Row): string => unixToDate(sub.current_period_end ?? obj((obj(sub.items).data as unknown[] | undefined)?.[0]).current_period_end);
const subscriptionPrice = (sub: Row): string => str(obj(obj((obj(sub.items).data as unknown[] | undefined)?.[0]).price).id);
const invoiceSubscription = (inv: Row): string => str(inv.subscription || obj(obj(inv.parent).subscription_details).subscription);
const invoicePaymentIntent = (inv: Row): string => str(inv.payment_intent || obj(obj((obj(inv.payments).data as unknown[] | undefined)?.[0]).payment).payment_intent);

export interface WebhookResult { kind: string; customer?: string; subscription?: string; payment?: string; raw: Row }

/** write one verified event into the rows; null for an event this plugin does not read */
export async function applyEvent(rows: PaymentRows, event: Row): Promise<WebhookResult | null> {
  const type = str(event.type);
  const o = obj(obj(event.data).object);
  const out = (r: Omit<WebhookResult, "kind" | "raw">): WebhookResult => ({ kind: type, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v)), raw: o });

  if (type === "checkout.session.completed") {
    const meta = obj(o.metadata);
    const customer = await ensureCustomer(rows, str(o.customer), { email: str(obj(o.customer_details).email || o.customer_email), user: str(meta.voidbase_user) });
    let payment: Row | undefined;
    if (o.mode === "payment" && o.payment_intent) {
      payment = await upsert(rows, "payments", str(o.payment_intent), { customer: str(customer?.id), amount: Number(o.amount_total ?? 0), currency: str(o.currency), status: o.payment_status === "paid" ? "succeeded" : "pending", raw: o });
    }
    return out({ customer: str(customer?.id), payment: str(payment?.id) });
  }

  if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const customer = await ensureCustomer(rows, str(o.customer));
    const status = type.endsWith("deleted") ? "canceled" : str(o.status);
    const sub = await upsert(rows, "subscriptions", str(o.id), { customer: str(customer?.id), status, price: subscriptionPrice(o), currentPeriodEnd: subscriptionPeriodEnd(o), cancelAtPeriodEnd: !!o.cancel_at_period_end });
    return out({ customer: str(customer?.id), subscription: str(sub.id) });
  }

  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    const customer = await ensureCustomer(rows, str(o.customer), { email: str(o.customer_email) });
    const subId = invoiceSubscription(o);
    const sub = subId ? await rows.find("subscriptions", { providerId: subId }) : null;
    const paid = type === "invoice.paid";
    const payment = await upsert(rows, "payments", invoicePaymentIntent(o) || str(o.id), {
      customer: str(customer?.id), amount: Number((paid ? o.amount_paid : o.amount_due) ?? 0), currency: str(o.currency), status: paid ? "succeeded" : "failed", ...(sub ? { subscription: str(sub.id) } : {}), raw: o,
    });
    return out({ customer: str(customer?.id), subscription: str(sub?.id), payment: str(payment.id) });
  }

  if (type === "payment_intent.succeeded" || type === "payment_intent.payment_failed") {
    const customer = await ensureCustomer(rows, str(o.customer));
    const payment = await upsert(rows, "payments", str(o.id), { customer: str(customer?.id), amount: Number(o.amount ?? 0), currency: str(o.currency), status: type.endsWith("succeeded") ? "succeeded" : "failed", raw: o });
    return out({ customer: str(customer?.id), payment: str(payment.id) });
  }

  return null;
}

// ---- the plugin -----------------------------------------------------------------------------------

export interface StripeDeps {
  /** how Stripe is reached; a test hands in a fake */
  fetch: Fetch;
  /** where the rows live; a test hands in memory */
  rows: (env: Bindings, realtime?: RealtimeClient) => PaymentRows;
  /** the clock the webhook tolerance is measured against, in unix seconds */
  now: () => number;
}

const defaults: StripeDeps = { fetch: (input, init) => fetch(input, init), rows: d1Rows, now: () => Math.floor(Date.now() / 1000) };

const mustKey = (env: Bindings): string => {
  const key = secretKey(env);
  if (!key) throw new ApiError(503, `Stripe is not configured on this instance: set ${KEY_VAR} (a secret) and, for the webhook, ${WEBHOOK_SECRET_VAR}`);
  return key;
};

type Items = { price: string; quantity: number }[];
type CheckoutInput = { customer: string; items: Items; success: string; cancel: string; mode?: "payment" | "subscription" };

/** the Stripe customer behind a customers row, which has to exist and be this provider's */
async function stripeCustomerOf(rows: PaymentRows, id: string): Promise<{ row: Row; providerId: string }> {
  const row = await rows.find("customers", { id });
  if (!row || row.provider !== PROVIDER) throw notFound(`no Stripe customer "${id}"`);
  return { row, providerId: str(row.providerId) };
}

/** the customers row for a signed-in user, created at Stripe and here on the first checkout */
export async function customerForUser(deps: StripeDeps, key: string, rows: PaymentRows, auth: AuthRecord): Promise<Row> {
  const user = str(auth.row.id);
  const found = await rows.find("customers", { provider: PROVIDER, user });
  if (found) return found;
  const email = str(auth.row.email);
  const created = await call(deps.fetch, key, "POST", "/v1/customers", { ...(email ? { email } : {}), metadata: { voidbase_user: user, voidbase_collection: auth.collection.name } });
  return rows.create("customers", { user, provider: PROVIDER, providerId: str(created.id), email });
}

/** the provider over its dependencies: the shipped one uses fetch, D1 and the clock; tests replace all three */
export function stripeWith(overrides: Partial<StripeDeps> = {}): Plugin & { payments: Payments } {
  const deps: StripeDeps = { ...defaults, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as StripeDeps;

  async function checkout(env: Bindings, rows: PaymentRows, o: CheckoutInput): Promise<{ url: string }> {
    const key = mustKey(env);
    const { row, providerId } = await stripeCustomerOf(rows, o.customer);
    const session = await call(deps.fetch, key, "POST", "/v1/checkout/sessions", {
      customer: providerId,
      mode: o.mode ?? "payment",
      line_items: o.items.map((i) => ({ price: i.price, quantity: i.quantity })),
      success_url: o.success,
      cancel_url: o.cancel,
      client_reference_id: str(row.id),
      metadata: { voidbase_customer: str(row.id), ...(row.user ? { voidbase_user: str(row.user) } : {}) },
    });
    return { url: str(session.url) };
  }

  async function portal(env: Bindings, rows: PaymentRows, o: { customer: string; return: string }): Promise<{ url: string }> {
    const key = mustKey(env);
    const { providerId } = await stripeCustomerOf(rows, o.customer);
    const session = await call(deps.fetch, key, "POST", "/v1/billing_portal/sessions", { customer: providerId, return_url: o.return });
    return { url: str(session.url) };
  }

  async function cancel(env: Bindings, rows: PaymentRows, sub: Row, now: boolean): Promise<Row> {
    const key = mustKey(env);
    const providerId = str(sub.providerId);
    if (now) {
      const answer = await call(deps.fetch, key, "DELETE", `/v1/subscriptions/${encodeURIComponent(providerId)}`);
      return rows.update("subscriptions", str(sub.id), { status: str(answer.status) || "canceled", cancelAtPeriodEnd: false });
    }
    const answer = await call(deps.fetch, key, "POST", `/v1/subscriptions/${encodeURIComponent(providerId)}`, { cancel_at_period_end: true });
    return rows.update("subscriptions", str(sub.id), { cancelAtPeriodEnd: answer.cancel_at_period_end !== false, ...(answer.status ? { status: str(answer.status) } : {}) });
  }

  async function webhook(env: Bindings, rows: PaymentRows, request: Request): Promise<WebhookResult | null> {
    const secret = webhookSecret(env);
    if (!secret) throw new ApiError(503, `Stripe webhooks are not configured on this instance: set ${WEBHOOK_SECRET_VAR} (a secret) to the signing secret of the endpoint registered as ${WEBHOOK_PATH}`);
    const payload = await request.text();
    const verdict = await verifySignature(payload, request.headers.get("stripe-signature"), secret, { now: deps.now() });
    if (!verdict.ok) throw badRequest(`Stripe webhook refused: ${verdict.reason}`);
    let event: Row;
    try { event = obj(JSON.parse(payload)); } catch { throw badRequest("Stripe webhook refused: the payload is not JSON"); }
    return applyEvent(rows, event);
  }

  const payments: Payments = {
    route(env) {
      const key = secretKey(env);
      return key ? { via: PROVIDER, webhook: WEBHOOK_PATH, livemode: isLive(key) } : null;
    },
    checkout: (env, o) => checkout(env, deps.rows(env), o),
    portal: (env, o) => portal(env, deps.rows(env), o),
    webhook: (env, request) => webhook(env, deps.rows(env), request),
    async cancel(env, subscription, o = {}) {
      const rows = deps.rows(env);
      const sub = await rows.find("subscriptions", { id: subscription });
      if (!sub) throw notFound(`no subscription "${subscription}"`);
      await cancel(env, rows, sub, !!o.now);
    },
  };

  const readBody = async (c: Context<AppEnv>): Promise<Row> => {
    try { return obj(await c.req.json()); } catch { throw badRequest("the body must be a JSON object"); }
  };
  const rowsFor = (c: Context<AppEnv>) => deps.rows(c.env, c.get("realtime"));

  const plugin: Plugin & { payments: Payments } = {
    manifest: {
      name: "stripe",
      version: "0.1.0",
      tier: "official",
      voidbase: "*",
      provides: ["payments@1"],
      collections: ["customers", "subscriptions", "payments"],
    },
    payments,
    apply(ctx: Kernel) {
      serve<Payments>(ctx, "payments@1", payments);
      // the collections exist only where the key does: an instance that never takes money never sees them
      onBootstrap(ctx, async (env) => { if (secretKey(env)) await ensureCollections(plugin, env.DB, await collectionDefinitions(env.DB)); });
      const app = ctx.app;

      app.post(`${API}/checkout`, async (c) => {
        const auth = requireAuth(c);
        const key = mustKey(c.env);
        const body = await readBody(c);
        const items = Array.isArray(body.items) ? (body.items as unknown[]).map(obj) : [];
        if (!items.length || items.some((i) => !str(i.price) || !(Number.isInteger(Number(i.quantity ?? 1)) && Number(i.quantity ?? 1) > 0))) throw badRequest("items must be a non-empty list of { price, quantity }");
        const success = str(body.success), cancelUrl = str(body.cancel);
        if (!success || !cancelUrl) throw badRequest("success and cancel must be the URLs to return to");
        const mode = body.mode === undefined ? "payment" : body.mode;
        if (mode !== "payment" && mode !== "subscription") throw badRequest('mode must be "payment" or "subscription"');
        const rows = rowsFor(c);
        const customer = await customerForUser(deps, key, rows, auth);
        return c.json(await checkout(c.env, rows, { customer: str(customer.id), items: items.map((i) => ({ price: str(i.price), quantity: Number(i.quantity ?? 1) })), success, cancel: cancelUrl, mode }));
      });

      app.post(`${API}/portal`, async (c) => {
        const auth = requireAuth(c);
        const key = mustKey(c.env);
        const body = await readBody(c);
        const back = str(body.return);
        if (!back) throw badRequest("return must be the URL to come back to");
        const rows = rowsFor(c);
        const customer = await customerForUser(deps, key, rows, auth);
        return c.json(await portal(c.env, rows, { customer: str(customer.id), return: back }));
      });

      app.post(`${API}/cancel`, async (c) => {
        const auth = requireAuth(c);
        mustKey(c.env);
        const body = await readBody(c);
        const id = str(body.subscription);
        if (!id) throw badRequest("subscription must be the id of a subscriptions row");
        const rows = rowsFor(c);
        const sub = await rows.find("subscriptions", { id });
        if (!sub) throw notFound(`no subscription "${id}"`);
        if (!isSuperuser(auth)) {
          const customer = await rows.find("customers", { id: str(sub.customer) });
          if (!customer || str(customer.user) !== str(auth.row.id)) throw forbidden("this subscription belongs to somebody else");
        }
        const updated = await cancel(c.env, rows, sub, body.now === true);
        return c.json({ subscription: str(updated.id), status: str(updated.status), cancelAtPeriodEnd: !!updated.cancelAtPeriodEnd });
      });

      app.post(WEBHOOK_PATH, async (c) => {
        const result = await webhook(c.env, rowsFor(c), c.req.raw);
        return c.json({ received: true, handled: !!result, ...(result ? { kind: result.kind } : {}) });
      });
    },
  };
  return plugin;
}

/** the shipped plugin: Stripe over fetch, the rows in D1, the real clock */
export const stripe: Plugin & { payments: Payments } = stripeWith();
