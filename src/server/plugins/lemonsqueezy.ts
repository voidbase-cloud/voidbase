// Taking money through Lemon Squeezy, as the third provider of `payments@1`.
//
// The shared shape (collections, rows, routes, the family that makes the shipped providers one provider) is in
// payments-shared.ts. This file is what Lemon Squeezy brings: its knobs, its JSON:API calls with `fetch` alone
// (`application/vnd.api+json`, a bearer key, a store id in every relationship), its `X-Signature` check, and its
// event names read into the shared rows. Pinned to docs.lemonsqueezy.com as read on 2026-09-11: `POST /v1/checkouts`
// with `store` and `variant` relationships, `POST /v1/customers`, `GET /v1/customers/{id}` for the portal URL,
// `DELETE /v1/subscriptions/{id}` to cancel and `PATCH` with `cancelled: false` to resume, and the
// `{ meta: { event_name, custom_data }, data }` webhook envelope.
//
// What differs from the other two: a subscription is `cancelled` and still runs until `ends_at` (written as status
// active with cancelAtPeriodEnd set), then `expired` (written as canceled); ids are integers and one number can be
// an order and an invoice at once, so payments rows carry `order_<id>` and `invoice_<id>`; and the first payment of
// a subscription arrives twice, as the order and as the `initial` invoice, and is written once, from the order.
import { ApiError, badRequest } from "../errors";
import type { Payments } from "../interfaces";
import type { AuthRecord, Bindings, Row } from "../types";
import type { Plugin } from "./manifest";
import {
  apiPrefix, constantTimeEqual, depsWith, ensureCustomer, hex, hmacSha256, isoDate, knob, obj, paymentsPlugin, str, upsert, webhookPathOf, webhookResult,
  type CancelMode, type CheckoutInput, type Fetch, type PaymentDeps, type PaymentProvider, type PaymentRows, type Verdict, type WebhookResult,
} from "./payments-shared";

export const LEMONSQUEEZY_API = "https://api.lemonsqueezy.com";
export const KEY_VAR = "LEMONSQUEEZY_API_KEY";
export const STORE_VAR = "LEMONSQUEEZY_STORE_ID";
export const WEBHOOK_SECRET_VAR = "LEMONSQUEEZY_WEBHOOK_SECRET";
export const PROVIDER = "lemonsqueezy";
export const API = apiPrefix(PROVIDER);
export const WEBHOOK_PATH = webhookPathOf(PROVIDER);
const JSONAPI = "application/vnd.api+json";

export const apiKey = (env: Bindings): string => knob(env, KEY_VAR);
export const storeId = (env: Bindings): string => knob(env, STORE_VAR);
export const webhookSecret = (env: Bindings): string => knob(env, WEBHOOK_SECRET_VAR);

// ---- the wire -------------------------------------------------------------------------------------

async function call(fetchFn: Fetch, key: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<Row> {
  const res = await fetchFn(`${LEMONSQUEEZY_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, accept: JSONAPI, ...(body !== undefined ? { "content-type": JSONAPI } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) {
    const first = obj((json.errors as unknown[] | undefined)?.[0]);
    const message = String(first.detail ?? first.title ?? json.message ?? res.statusText ?? "");
    throw new ApiError(res.status >= 500 ? 502 : 400, `Lemon Squeezy answered ${res.status}${message ? `: ${message}` : ""}`);
  }
  return json;
}

/** the JSON:API envelope around one resource, with a store relationship where one is asked for */
const resource = (type: string, attributes: Record<string, unknown>, o: { id?: string; store?: string; variant?: string } = {}): Record<string, unknown> => ({
  data: {
    type,
    ...(o.id ? { id: o.id } : {}),
    attributes,
    ...(o.store || o.variant ? {
      relationships: {
        ...(o.store ? { store: { data: { type: "stores", id: o.store } } } : {}),
        ...(o.variant ? { variant: { data: { type: "variants", id: o.variant } } } : {}),
      },
    } : {}),
  },
});

// ---- the signature ----------------------------------------------------------------------------------

/** the hex HMAC SHA-256 of the raw body under the signing secret: what Lemon Squeezy puts in `X-Signature` */
export async function signPayload(secret: string, payload: string): Promise<string> {
  return hex(await hmacSha256(secret, payload));
}

/**
 * Check `X-Signature` against the payload as it arrived. Lemon Squeezy signs the raw body and nothing else, so
 * there is no timestamp to bound: a replay of a signed body verifies, and the upsert by provider id is what makes
 * it a no-op.
 */
export async function verifySignature(payload: string, header: string | null, secret: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!secret) return { ok: false, reason: `no ${WEBHOOK_SECRET_VAR} to verify against` };
  if (!header) return { ok: false, reason: "no X-Signature header" };
  const expected = await signPayload(secret, payload);
  if (!constantTimeEqual(header.trim().toLowerCase(), expected)) return { ok: false, reason: "the signature does not match the payload" };
  return { ok: true };
}

// ---- what the webhook says, applied to the rows -----------------------------------------------------

/** Lemon Squeezy's subscription statuses as the rows' vocabulary; `cancelled` still runs until `ends_at` */
export const SUBSCRIPTION_STATUS: Record<string, string> = { on_trial: "trialing", active: "active", paused: "paused", past_due: "past_due", unpaid: "unpaid", cancelled: "active", expired: "canceled" };
const orderStatus = (a: Row): string => (a.refunded === true || a.status === "refunded" ? "refunded" : a.status === "paid" ? "succeeded" : a.status === "failed" || a.status === "fraudulent" ? "failed" : "pending");
const invoiceStatus = (event: string, a: Row): string => (a.refunded === true || a.status === "refunded" ? "refunded" : event === "subscription_payment_failed" ? "failed" : a.status === "void" ? "canceled" : "succeeded");

/** write one verified event into the rows; null for an event this plugin does not read */
export async function applyEvent(rows: PaymentRows, event: Row): Promise<WebhookResult | null> {
  const meta = obj(event.meta);
  const name = str(meta.event_name);
  const data = obj(event.data);
  const a = obj(data.attributes);
  const id = str(data.id);
  const custom = obj(meta.custom_data);
  const user = str(custom.voidbase_user);
  const out = (r: Omit<WebhookResult, "kind" | "raw">) => webhookResult(name, data, r);

  if (name === "order_created" || name === "order_refunded") {
    const customer = await ensureCustomer(rows, PROVIDER, str(a.customer_id), { email: str(a.user_email), user });
    const payment = await upsert(rows, "payments", `order_${id}`, { customer: str(customer?.id), amount: Number(a.total ?? 0), currency: str(a.currency), status: orderStatus(a), raw: data });
    return out({ customer: str(customer?.id), payment: str(payment.id) });
  }

  if (name.startsWith("subscription_payment_")) {
    // a subscription invoice; the `initial` one is the order that order_created already wrote
    if (a.billing_reason === "initial") return out({});
    const customer = await ensureCustomer(rows, PROVIDER, str(a.customer_id), { email: str(a.user_email), user });
    const subId = str(a.subscription_id);
    const sub = subId ? await rows.find("subscriptions", { providerId: subId }) : null;
    const payment = await upsert(rows, "payments", `invoice_${id}`, {
      customer: str(customer?.id), amount: Number(a.total ?? 0), currency: str(a.currency), status: invoiceStatus(name, a), ...(sub ? { subscription: str(sub.id) } : {}), raw: data,
    });
    return out({ customer: str(customer?.id), subscription: str(sub?.id), payment: str(payment.id) });
  }

  if (name.startsWith("subscription_")) {
    // created, updated, cancelled, resumed, expired, paused, unpaused: every one carries the whole subscription
    const customer = await ensureCustomer(rows, PROVIDER, str(a.customer_id), { email: str(a.user_email), user });
    const status = name === "subscription_expired" ? "canceled" : (SUBSCRIPTION_STATUS[str(a.status)] ?? "incomplete");
    const cancelled = a.cancelled === true || a.status === "cancelled";
    const sub = await upsert(rows, "subscriptions", id, {
      customer: str(customer?.id), status, price: str(a.variant_id), currentPeriodEnd: isoDate(cancelled || status === "canceled" ? a.ends_at || a.renews_at : a.renews_at), cancelAtPeriodEnd: status !== "canceled" && cancelled,
    });
    // the order that started it is this subscription's first payment
    const order = a.order_id ? await rows.find("payments", { providerId: `order_${str(a.order_id)}` }) : null;
    if (order && !order.subscription) await rows.update("payments", str(order.id), { subscription: str(sub.id) });
    return out({ customer: str(customer?.id), subscription: str(sub.id), payment: str(order?.id) });
  }

  return null;
}

// ---- the provider -----------------------------------------------------------------------------------

export type LemonSqueezyDeps = PaymentDeps;

/** Lemon Squeezy over its dependencies: the knobs, the calls, the signature, the events */
export function lemonsqueezyProvider(deps: PaymentDeps): PaymentProvider {
  const mustKey = (env: Bindings): { key: string; store: string } => {
    const key = apiKey(env), store = storeId(env);
    if (!key) throw new ApiError(503, `Lemon Squeezy is not configured on this instance: set ${KEY_VAR} (a secret) and ${STORE_VAR}, and, for the webhook, ${WEBHOOK_SECRET_VAR}`);
    if (!store) throw new ApiError(503, `Lemon Squeezy needs ${STORE_VAR}: the numeric id of the store the checkouts belong to`);
    return { key, store };
  };
  const api = (env: Bindings) => {
    const { key, store } = mustKey(env);
    return { store, call: (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>) => call(deps.fetch, key, method, path, body) };
  };
  const attributesOf = (answer: Row): Row => obj(obj(answer.data).attributes);
  return {
    name: PROVIDER, label: "Lemon Squeezy", keyVar: KEY_VAR, webhookSecretVar: WEBHOOK_SECRET_VAR,
    key: apiKey, webhookSecret,
    // test mode is a switch on the store, not a property of the key: the key is the same in both
    livemode: () => true,

    async createCustomer(env, auth: AuthRecord) {
      const { store, call: ls } = api(env);
      const email = str(auth.row.email), user = str(auth.row.id);
      // an email is unique in a store: one that bought before is found, not created again
      if (email) {
        const found = await ls("GET", `/v1/customers?filter[store_id]=${encodeURIComponent(store)}&filter[email]=${encodeURIComponent(email)}`);
        const existing = obj((found.data as unknown[] | undefined)?.[0]);
        if (existing.id) return { providerId: str(existing.id), email };
      }
      const name = str(auth.row.name) || email.split("@")[0] || user;
      const created = await ls("POST", "/v1/customers", resource("customers", { name, email }, { store }));
      return { providerId: str(obj(created.data).id), email };
    },

    checkCheckout(o: CheckoutInput) {
      if (o.items.length !== 1) throw badRequest("a Lemon Squeezy checkout takes one item: the variant to buy, with its quantity");
      if (!/^\d+$/.test(o.items[0]!.price)) throw badRequest("price must be the numeric id of a Lemon Squeezy variant");
    },

    async checkout(env, row, o) {
      const { store, call: ls } = api(env);
      const item = o.items[0]!;
      const answer = await ls("POST", "/v1/checkouts", resource("checkouts", {
        product_options: { redirect_url: o.success },
        checkout_data: {
          ...(row.email ? { email: str(row.email) } : {}),
          custom: { voidbase_customer: str(row.id), ...(row.user ? { voidbase_user: str(row.user) } : {}) },
          ...(item.quantity > 1 ? { variant_quantities: [{ variant_id: Number(item.price), quantity: item.quantity }] } : {}),
        },
      }, { store, variant: item.price }));
      return { url: str(attributesOf(answer).url) };
    },

    async portal(env, row) {
      // the customer portal is a signed URL on the customer, there once they have ordered; `return` has nowhere to go
      const answer = await api(env).call("GET", `/v1/customers/${encodeURIComponent(str(row.providerId))}`);
      const url = str(obj(attributesOf(answer).urls).customer_portal);
      if (!url) throw badRequest("Lemon Squeezy has no customer portal for this customer yet: it appears after their first order");
      return { url };
    },

    async cancel(env, sub, mode: CancelMode) {
      const { call: ls } = api(env);
      const id = str(sub.providerId);
      const path = `/v1/subscriptions/${encodeURIComponent(id)}`;
      if (mode === "now") throw badRequest("Lemon Squeezy cancels at the period's end only: a cancelled subscription runs until ends_at, and there is no cancelling now");
      const answer = mode === "period_end" ? await ls("DELETE", path) : await ls("PATCH", path, resource("subscriptions", { cancelled: false }, { id }));
      const a = attributesOf(answer);
      const cancelled = a.cancelled === true || a.status === "cancelled";
      return {
        status: a.status === "expired" ? "canceled" : (SUBSCRIPTION_STATUS[str(a.status)] ?? (str(sub.status) || "active")),
        cancelAtPeriodEnd: cancelled,
        ...(a.ends_at || a.renews_at ? { currentPeriodEnd: isoDate(cancelled ? a.ends_at || a.renews_at : a.renews_at) } : {}),
      };
    },

    verify: (payload, headers, secret): Promise<Verdict> => verifySignature(payload, headers.get("x-signature"), secret),
    applyEvent,
  };
}

/** the plugin over its dependencies: the shipped one uses fetch, D1 and the clock; tests replace all three */
export function lemonsqueezyWith(overrides: Partial<LemonSqueezyDeps> = {}): Plugin & { payments: Payments } {
  const deps = depsWith({ name: PROVIDER, keyVar: KEY_VAR }, overrides);
  return paymentsPlugin(lemonsqueezyProvider(deps), deps, { anchor: false });
}

/** the shipped plugin: Lemon Squeezy over fetch, the rows in D1, the real clock; it joins stripe's family for payments@1 */
export const lemonsqueezy: Plugin & { payments: Payments } = lemonsqueezyWith();
