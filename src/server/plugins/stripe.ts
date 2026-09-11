// Taking money through Stripe, as the first plugin that provides `payments@1`.
//
// The roadmap's worked example: one plugin per provider, all of them providing the same interface, each owning its
// webhook route, verifying signatures, and writing customers, subscriptions and payments into collections the app
// queries like any other. What every provider shares (the collections, the rows, the routes, the family that
// makes the shipped providers one provider of `payments@1`) lives in payments-shared.ts; this file is what Stripe
// brings: its knobs, its REST calls with `fetch` alone (form-encoded bodies, a bearer key, one pinned API version)
// rather than the Stripe SDK, its `Stripe-Signature` check, and its event names read into the shared rows.
//
// The key and the webhook secret are secrets and arrive with the request (pb_secrets/vb_secrets: `secret(...)` in
// env.ts), read from the request env first and the runtime env second, like the mail plugin's domain. So the
// provider answers per env: `route(env)` says where payments go with these bindings, or null when there is no key,
// and every other call refuses with the knob's name. Without the key the plugin is loaded and idle, and its three
// collections are not created either, so an instance that never takes money never sees them in the panel.
//
// Every write is an upsert by `providerId`, which is what makes a replayed webhook a no-op rather than a duplicate.
// Stripe's own retries and the "at least once" promise of every webhook are the reason.
import { ApiError, badRequest } from "../errors";
import type { Payments } from "../interfaces";
import type { AuthRecord, Bindings, Row } from "../types";
import type { Plugin } from "./manifest";
import {
  apiPrefix, constantTimeEqual, depsWith, ensureCustomer, hex, hmacSha256, knob, obj, paymentsPlugin, str, unixToDate, upsert, webhookPathOf, webhookResult,
  TOLERANCE_SECONDS, type CancelMode, type CheckoutInput, type Fetch, type PaymentDeps, type PaymentProvider, type PaymentRows, type Verdict, type WebhookResult,
} from "./payments-shared";

// what the shared module holds and this file's callers used to import from here
export {
  collectionDefinitions, customerForUser, d1Rows, PAYMENT_STATUSES, SUBSCRIPTION_STATUSES, TOLERANCE_SECONDS,
  type Fetch, type PaymentCollection, type PaymentRows, type WebhookResult,
} from "./payments-shared";

export const STRIPE_API = "https://api.stripe.com";
/** the API version every call pins, so a change on Stripe's side arrives when this line changes and not before */
export const STRIPE_VERSION = "2025-08-27.basil";
export const KEY_VAR = "STRIPE_SECRET_KEY";
export const WEBHOOK_SECRET_VAR = "STRIPE_WEBHOOK_SECRET";
export const PROVIDER = "stripe";
export const API = apiPrefix(PROVIDER);
export const WEBHOOK_PATH = webhookPathOf(PROVIDER);

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

/** HMAC SHA-256 of `${t}.${payload}` under the signing secret, in hex: what Stripe puts in `v1=` */
export async function signPayload(secret: string, payload: string, t: number): Promise<string> {
  return hex(await hmacSha256(secret, `${t}.${payload}`));
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

// ---- what the webhook says, applied to the rows -----------------------------------------------------

// Stripe's 2025 versions moved a few fields: a subscription's period now lives on its items, an invoice's
// subscription under `parent`, and its payment intent under `payments`. Both shapes are read.
const subscriptionPeriodEnd = (sub: Row): string => unixToDate(sub.current_period_end ?? obj((obj(sub.items).data as unknown[] | undefined)?.[0]).current_period_end);
const subscriptionPrice = (sub: Row): string => str(obj(obj((obj(sub.items).data as unknown[] | undefined)?.[0]).price).id);
const invoiceSubscription = (inv: Row): string => str(inv.subscription || obj(obj(inv.parent).subscription_details).subscription);
const invoicePaymentIntent = (inv: Row): string => str(inv.payment_intent || obj(obj((obj(inv.payments).data as unknown[] | undefined)?.[0]).payment).payment_intent);

/** write one verified event into the rows; null for an event this plugin does not read */
export async function applyEvent(rows: PaymentRows, event: Row): Promise<WebhookResult | null> {
  const type = str(event.type);
  const o = obj(obj(event.data).object);
  const out = (r: Omit<WebhookResult, "kind" | "raw">) => webhookResult(type, o, r);

  if (type === "checkout.session.completed") {
    const meta = obj(o.metadata);
    const customer = await ensureCustomer(rows, PROVIDER, str(o.customer), { email: str(obj(o.customer_details).email || o.customer_email), user: str(meta.voidbase_user) });
    let payment: Row | undefined;
    if (o.mode === "payment" && o.payment_intent) {
      payment = await upsert(rows, "payments", str(o.payment_intent), { customer: str(customer?.id), amount: Number(o.amount_total ?? 0), currency: str(o.currency), status: o.payment_status === "paid" ? "succeeded" : "pending", raw: o });
    }
    return out({ customer: str(customer?.id), payment: str(payment?.id) });
  }

  if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const customer = await ensureCustomer(rows, PROVIDER, str(o.customer));
    const status = type.endsWith("deleted") ? "canceled" : str(o.status);
    const sub = await upsert(rows, "subscriptions", str(o.id), { customer: str(customer?.id), status, price: subscriptionPrice(o), currentPeriodEnd: subscriptionPeriodEnd(o), cancelAtPeriodEnd: !!o.cancel_at_period_end });
    return out({ customer: str(customer?.id), subscription: str(sub.id) });
  }

  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    const customer = await ensureCustomer(rows, PROVIDER, str(o.customer), { email: str(o.customer_email) });
    const subId = invoiceSubscription(o);
    const sub = subId ? await rows.find("subscriptions", { providerId: subId }) : null;
    const paid = type === "invoice.paid";
    const payment = await upsert(rows, "payments", invoicePaymentIntent(o) || str(o.id), {
      customer: str(customer?.id), amount: Number((paid ? o.amount_paid : o.amount_due) ?? 0), currency: str(o.currency), status: paid ? "succeeded" : "failed", ...(sub ? { subscription: str(sub.id) } : {}), raw: o,
    });
    return out({ customer: str(customer?.id), subscription: str(sub?.id), payment: str(payment.id) });
  }

  if (type === "payment_intent.succeeded" || type === "payment_intent.payment_failed") {
    const customer = await ensureCustomer(rows, PROVIDER, str(o.customer));
    const payment = await upsert(rows, "payments", str(o.id), { customer: str(customer?.id), amount: Number(o.amount ?? 0), currency: str(o.currency), status: type.endsWith("succeeded") ? "succeeded" : "failed", raw: o });
    return out({ customer: str(customer?.id), payment: str(payment.id) });
  }

  return null;
}

// ---- the provider -----------------------------------------------------------------------------------

export type StripeDeps = PaymentDeps;

/** Stripe over its dependencies: the knobs, the calls, the signature, the events */
export function stripeProvider(deps: PaymentDeps): PaymentProvider {
  const mustKey = (env: Bindings): string => {
    const key = secretKey(env);
    if (!key) throw new ApiError(503, `Stripe is not configured on this instance: set ${KEY_VAR} (a secret) and, for the webhook, ${WEBHOOK_SECRET_VAR}`);
    return key;
  };
  return {
    name: PROVIDER, label: "Stripe", keyVar: KEY_VAR, webhookSecretVar: WEBHOOK_SECRET_VAR,
    key: secretKey, webhookSecret, livemode: (env) => isLive(secretKey(env)),

    async createCustomer(env, auth: AuthRecord) {
      const email = str(auth.row.email);
      const created = await call(deps.fetch, mustKey(env), "POST", "/v1/customers", { ...(email ? { email } : {}), metadata: { voidbase_user: str(auth.row.id), voidbase_collection: auth.collection.name } });
      return { providerId: str(created.id), email };
    },

    checkCheckout(o: CheckoutInput) {
      if (!o.cancel) throw badRequest("success and cancel must be the URLs to return to");
    },

    async checkout(env, row, o) {
      const session = await call(deps.fetch, mustKey(env), "POST", "/v1/checkout/sessions", {
        customer: str(row.providerId),
        mode: o.mode ?? "payment",
        line_items: o.items.map((i) => ({ price: i.price, quantity: i.quantity })),
        success_url: o.success,
        cancel_url: o.cancel,
        client_reference_id: str(row.id),
        metadata: { voidbase_customer: str(row.id), ...(row.user ? { voidbase_user: str(row.user) } : {}) },
      });
      return { url: str(session.url) };
    },

    async portal(env, row, o) {
      const session = await call(deps.fetch, mustKey(env), "POST", "/v1/billing_portal/sessions", { customer: str(row.providerId), return_url: o.return });
      return { url: str(session.url) };
    },

    async cancel(env, sub, mode: CancelMode) {
      const key = mustKey(env);
      const path = `/v1/subscriptions/${encodeURIComponent(str(sub.providerId))}`;
      if (mode === "now") {
        const answer = await call(deps.fetch, key, "DELETE", path);
        return { status: str(answer.status) || "canceled", cancelAtPeriodEnd: false };
      }
      const answer = await call(deps.fetch, key, "POST", path, { cancel_at_period_end: mode === "period_end" });
      return { cancelAtPeriodEnd: mode === "period_end" ? answer.cancel_at_period_end !== false : answer.cancel_at_period_end === true, ...(answer.status ? { status: str(answer.status) } : {}) };
    },

    verify: (payload, headers, secret, now): Promise<Verdict> => verifySignature(payload, headers.get("stripe-signature"), secret, { now }),
    applyEvent,
  };
}

/** the plugin over its dependencies: the shipped one uses fetch, D1 and the clock; tests replace all three */
export function stripeWith(overrides: Partial<StripeDeps> = {}): Plugin & { payments: Payments } {
  const deps = depsWith({ name: PROVIDER, keyVar: KEY_VAR }, overrides);
  // stripe is the family's anchor: it claims payments@1 and owns the collections for polar and lemonsqueezy too
  return paymentsPlugin(stripeProvider(deps), deps, { anchor: true });
}

/** the shipped plugin: Stripe over fetch, the rows in D1, the real clock */
export const stripe: Plugin & { payments: Payments } = stripeWith();
