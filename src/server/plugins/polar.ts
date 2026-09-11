// Taking money through Polar, as the second provider of `payments@1`.
//
// The shared shape (collections, rows, routes, the family that makes the shipped providers one provider) is in
// payments-shared.ts. This file is what Polar brings: its knobs, its REST calls with `fetch` alone (JSON bodies,
// a bearer token, the production or the sandbox host), its Standard Webhooks signature check, and its event names
// read into the shared rows. Pinned to Polar's 2026-04 OpenAPI document (polar.sh/docs/openapi/2026-04.openapi.json,
// read 2026-09-11): `POST /v1/checkouts/` with `products`, `POST /v1/customers/`, `POST /v1/customer-sessions/`,
// `PATCH` and `DELETE /v1/subscriptions/{id}`, and the `{ type, timestamp, data }` webhook envelope.
//
// A customer is created at Polar (or found by email) on the first checkout, with `external_id` set to the user's
// id, so the rows and Polar agree on who a customer is before any money moves; the checkout then names that
// customer. Polar keys its webhook envelope on `type` and puts the whole object in `data`; a subscription's status
// vocabulary is Stripe's, so it is written as it comes.
import { ApiError } from "../errors";
import type { Payments } from "../interfaces";
import type { AuthRecord, Bindings, Row } from "../types";
import type { Plugin } from "./manifest";
import {
  apiPrefix, base64, constantTimeEqual, depsWith, ensureCustomer, fromBase64, hmacSha256, isoDate, knob, obj, paymentsPlugin, str, upsert, webhookPathOf, webhookResult,
  TOLERANCE_SECONDS, type CancelMode, type Fetch, type PaymentDeps, type PaymentProvider, type PaymentRows, type Verdict, type WebhookResult,
} from "./payments-shared";

export const POLAR_API = "https://api.polar.sh";
export const POLAR_SANDBOX_API = "https://sandbox-api.polar.sh";
export const KEY_VAR = "POLAR_ACCESS_TOKEN";
export const WEBHOOK_SECRET_VAR = "POLAR_WEBHOOK_SECRET";
/** `1` points every call at the sandbox, where nothing is real money */
export const SANDBOX_VAR = "POLAR_SANDBOX";
export const PROVIDER = "polar";
export const API = apiPrefix(PROVIDER);
export const WEBHOOK_PATH = webhookPathOf(PROVIDER);

export const accessToken = (env: Bindings): string => knob(env, KEY_VAR);
export const webhookSecret = (env: Bindings): string => knob(env, WEBHOOK_SECRET_VAR);
export const isSandbox = (env: Bindings): boolean => /^(1|true|yes)$/i.test(knob(env, SANDBOX_VAR));
export const apiBase = (env: Bindings): string => (isSandbox(env) ? POLAR_SANDBOX_API : POLAR_API);

// ---- the wire -------------------------------------------------------------------------------------

async function call(fetchFn: Fetch, base: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<Row> {
  const res = await fetchFn(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) {
    const detail = json.detail ?? json.error ?? json.message;
    const message = detail === undefined ? String(res.statusText ?? "") : typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new ApiError(res.status >= 500 ? 502 : 400, `Polar answered ${res.status}${message ? `: ${message}` : ""}`);
  }
  return json;
}

// ---- the signature: Standard Webhooks --------------------------------------------------------------

/**
 * The key a `whsec_...` secret stands for, both ways Polar has meant it. Secrets generated on or after 8 September
 * 2026 follow Standard Webhooks: the part after `whsec_` is base64 and the key is its bytes. Older secrets use what
 * Polar calls Polar HMAC: the key is the UTF-8 bytes of the whole `whsec_...` string. A signature that matches
 * either is accepted, the way Polar's own SDKs try both.
 */
export function webhookKeys(secret: string): (string | Uint8Array)[] {
  const keys: (string | Uint8Array)[] = [secret];
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try { keys.unshift(fromBase64(encoded)); } catch { /* not base64: only the legacy key applies */ }
  return keys;
}

/** the base64 HMAC SHA-256 of `${id}.${timestamp}.${payload}`: what goes after `v1,` in `webhook-signature` */
export async function signPayload(secret: string, id: string, timestamp: number, payload: string, scheme: "standard" | "legacy" = "standard"): Promise<string> {
  const keys = webhookKeys(secret);
  const key = scheme === "legacy" ? secret : keys[0]!;
  return base64(await hmacSha256(key, `${id}.${timestamp}.${payload}`));
}

/**
 * Check the three Standard Webhooks headers against the payload as it arrived: `webhook-id`, `webhook-timestamp`
 * (unix seconds) and `webhook-signature` (`v1,<base64>` entries separated by spaces). A timestamp more than
 * `tolerance` seconds from `now` is refused whatever the signature says.
 */
export async function verifySignature(payload: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, secret: string, o: { now?: number; tolerance?: number } = {}): Promise<{ ok: true; t: number } | { ok: false; reason: string }> {
  if (!secret) return { ok: false, reason: `no ${WEBHOOK_SECRET_VAR} to verify against` };
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, reason: "webhook-id, webhook-timestamp and webhook-signature are all needed" };
  const t = Number(headers.timestamp);
  if (!Number.isFinite(t) || t <= 0) return { ok: false, reason: "webhook-timestamp is not unix seconds" };
  const sigs = headers.signature.split(/\s+/).filter((s) => s.startsWith("v1,")).map((s) => s.slice(3));
  if (!sigs.length) return { ok: false, reason: "no v1 signature in webhook-signature" };
  const message = `${headers.id}.${t}.${payload}`;
  let matched = false;
  for (const key of webhookKeys(secret)) {
    const expected = base64(await hmacSha256(key, message));
    if (sigs.some((s) => constantTimeEqual(s, expected))) matched = true;
  }
  if (!matched) return { ok: false, reason: "the signature does not match the payload" };
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const tolerance = o.tolerance ?? TOLERANCE_SECONDS;
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: `the timestamp is ${Math.abs(now - t)} seconds from now, more than the ${tolerance} allowed` };
  return { ok: true, t };
}

// ---- what the webhook says, applied to the rows -----------------------------------------------------

const firstPrice = (sub: Row): string => str(obj((sub.prices as unknown[] | undefined)?.[0]).id);
const customerOf = (o: Row) => ({ id: str(o.customer_id || obj(o.customer).id), email: str(obj(o.customer).email), user: str(obj(o.customer).external_id) });

/** a Polar order's status as a payments row's: `paid` says succeeded; a refund says refunded; anything else is pending */
const orderStatus = (o: Row): string => (o.status === "refunded" || o.status === "partially_refunded" ? "refunded" : o.paid === true || o.status === "paid" ? "succeeded" : o.status === "void" ? "canceled" : "pending");

/** write one verified event into the rows; null for an event this plugin does not read */
export async function applyEvent(rows: PaymentRows, event: Row): Promise<WebhookResult | null> {
  const type = str(event.type);
  const o = obj(event.data);
  const out = (r: Omit<WebhookResult, "kind" | "raw">) => webhookResult(type, o, r);

  if (type === "checkout.updated") {
    // the checkout is read once it succeeded: the customer it made or named, tied to the user it was started for
    if (o.status !== "succeeded") return null;
    const meta = obj(o.metadata);
    const customer = await ensureCustomer(rows, PROVIDER, str(o.customer_id), { email: str(o.customer_email), user: str(o.external_customer_id || meta.voidbase_user) });
    return out({ customer: str(customer?.id) });
  }

  if (type === "order.created" || type === "order.paid" || type === "order.refunded") {
    const c = customerOf(o);
    const customer = await ensureCustomer(rows, PROVIDER, c.id, { email: c.email, user: c.user });
    const subId = str(o.subscription_id);
    const sub = subId ? await rows.find("subscriptions", { providerId: subId }) : null;
    const payment = await upsert(rows, "payments", str(o.id), {
      customer: str(customer?.id), amount: Number(o.total_amount ?? o.net_amount ?? 0), currency: str(o.currency), status: orderStatus(o), ...(sub ? { subscription: str(sub.id) } : {}), raw: o,
    });
    return out({ customer: str(customer?.id), subscription: str(sub?.id), payment: str(payment.id) });
  }

  if (type.startsWith("subscription.")) {
    // every subscription.* event carries the whole subscription, so they are all read the same way; `revoked`
    // comes with status canceled already, and `canceled` with cancel_at_period_end set and the status still active
    const c = customerOf(o);
    const customer = await ensureCustomer(rows, PROVIDER, c.id, { email: c.email, user: c.user });
    const status = type === "subscription.revoked" ? "canceled" : str(o.status);
    const sub = await upsert(rows, "subscriptions", str(o.id), { customer: str(customer?.id), status, price: firstPrice(o), currentPeriodEnd: isoDate(o.current_period_end), cancelAtPeriodEnd: !!o.cancel_at_period_end });
    return out({ customer: str(customer?.id), subscription: str(sub.id) });
  }

  return null;
}

// ---- the provider -----------------------------------------------------------------------------------

export type PolarDeps = PaymentDeps;

/** Polar over its dependencies: the knobs, the calls, the signature, the events */
export function polarProvider(deps: PaymentDeps): PaymentProvider {
  const mustToken = (env: Bindings): string => {
    const token = accessToken(env);
    if (!token) throw new ApiError(503, `Polar is not configured on this instance: set ${KEY_VAR} (a secret) and, for the webhook, ${WEBHOOK_SECRET_VAR}`);
    return token;
  };
  const api = (env: Bindings) => {
    const token = mustToken(env), base = apiBase(env);
    return (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>) => call(deps.fetch, base, token, method, path, body);
  };
  return {
    name: PROVIDER, label: "Polar", keyVar: KEY_VAR, webhookSecretVar: WEBHOOK_SECRET_VAR,
    key: accessToken, webhookSecret, livemode: (env) => !isSandbox(env),

    async createCustomer(env, auth: AuthRecord) {
      const polar = api(env);
      const email = str(auth.row.email), user = str(auth.row.id);
      // an email is unique in a Polar organization: one that bought before is found, not created again
      if (email) {
        const found = await polar("GET", `/v1/customers/?email=${encodeURIComponent(email)}&limit=1`);
        const existing = obj((found.items as unknown[] | undefined)?.[0]);
        if (existing.id) return { providerId: str(existing.id), email };
      }
      const created = await polar("POST", "/v1/customers/", { email, external_id: user, metadata: { voidbase_user: user, voidbase_collection: auth.collection.name } });
      return { providerId: str(created.id), email };
    },

    async checkout(env, row, o) {
      // `items[].price` is a Polar product id; quantities are not a checkout's business at Polar, the customer
      // picks among the products listed
      const checkout = await api(env)("POST", "/v1/checkouts/", {
        products: o.items.map((i) => i.price),
        customer_id: str(row.providerId),
        ...(row.email ? { customer_email: str(row.email) } : {}),
        success_url: o.success,
        metadata: { voidbase_customer: str(row.id), ...(row.user ? { voidbase_user: str(row.user) } : {}) },
      });
      return { url: str(checkout.url) };
    },

    async portal(env, row, o) {
      const session = await api(env)("POST", "/v1/customer-sessions/", { customer_id: str(row.providerId), return_url: o.return });
      return { url: str(session.customer_portal_url) };
    },

    async cancel(env, sub, mode: CancelMode) {
      const polar = api(env);
      const path = `/v1/subscriptions/${encodeURIComponent(str(sub.providerId))}`;
      if (mode === "now") {
        const answer = await polar("DELETE", path);
        return { status: str(answer.status) || "canceled", cancelAtPeriodEnd: false };
      }
      const answer = await polar("PATCH", path, { cancel_at_period_end: mode === "period_end" });
      return { cancelAtPeriodEnd: mode === "period_end" ? answer.cancel_at_period_end !== false : answer.cancel_at_period_end === true, ...(answer.status ? { status: str(answer.status) } : {}) };
    },

    verify: (payload, headers, secret, now): Promise<Verdict> =>
      verifySignature(payload, { id: headers.get("webhook-id"), timestamp: headers.get("webhook-timestamp"), signature: headers.get("webhook-signature") }, secret, { now }),
    applyEvent,
  };
}

/** the plugin over its dependencies: the shipped one uses fetch, D1 and the clock; tests replace all three */
export function polarWith(overrides: Partial<PolarDeps> = {}): Plugin & { payments: Payments } {
  const deps = depsWith({ name: PROVIDER, keyVar: KEY_VAR }, overrides);
  return paymentsPlugin(polarProvider(deps), deps, { anchor: false });
}

/** the shipped plugin: Polar over fetch, the rows in D1, the real clock; it joins stripe's family for payments@1 */
export const polar: Plugin & { payments: Payments } = polarWith();
