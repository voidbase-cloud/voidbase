// What every payment provider shares, so that a provider file is only what differs: its knobs, its API calls, its
// webhook signature and its event names mapped onto the same rows.
//
// The roadmap's promise is that changing provider is changing which plugin is installed, and "the shared shape is
// what makes the next provider cheap to add". This is the shared shape: the three collections and their rules,
// the rows written through the records service, the customer row behind a signed-in user, the four routes under
// `/api/payments/<provider>/`, the upsert-by-`providerId` discipline that makes a replayed webhook a no-op, and the
// `payments@1` implementation `/api/plugins` and other plugins reach, and the seam a plugin built on top of
// payments watches so that it can learn about a payment through a webhook route it does not own
// (`onPaymentWritten`, added 2026-09-11 with the commerce plugin). A provider hands in a `PaymentProvider` and
// gets a plugin back (`paymentsPlugin`).
//
// One provider is active at a time, and here is how the three shipped ones coexist. The loader refuses two plugins
// providing one interface, and it checks at load, when the keys are not known: they are secrets that arrive with
// the request (on Workers, `env` at module scope is not there yet). So the three cannot each claim `payments@1`,
// and none of them can claim it only when its key is set. Instead they are one provider from the loader's point
// of view: the first payment plugin in the shipped order (`stripe`) claims `payments@1` and owns the three
// collections (the loader refuses two owners as well), and the others require it and join its family when they
// are applied. The `Payments` served is a dispatcher over the family: per request it looks at which keys these
// bindings carry and answers for the first configured provider in shipped order. No keys means `route(env)` is
// null and `/api/plugins` says `payments: { via: "none" }`; one key means that provider; two keys means the first
// one wins and `/api/plugins` says which and why (`also`, `reason`), while the routes of the other refuse with
// 409 so nothing is half-taken through a provider that is not the active one.
import { env as voidEnv } from "#platform/env";
import { logger } from "#platform/log";
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
import type { Context, Hono } from "hono";

/** how far a webhook's timestamp may be from now, in seconds: five minutes, what Stripe and Standard Webhooks recommend */
export const TOLERANCE_SECONDS = 300;

/** a knob as these bindings carry it: the request env first, the runtime env second, like the mail plugin's domain */
export const knob = (env: Bindings, name: string): string => String((env as unknown as Record<string, unknown>)[name] ?? (voidEnv as Record<string, unknown>)[name] ?? "").trim();

// ---- small readers every provider needs -----------------------------------------------------------------

export const str = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? str((v as Row).id) : String(v));
export const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
/** unix seconds to ISO, or empty */
export const unixToDate = (v: unknown): string => (typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : "");
/** an ISO date as the provider sent it, normalised, or empty when there is none or it does not parse */
export const isoDate = (v: unknown): string => {
  if (typeof v !== "string" || !v) return "";
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
};

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// ---- signatures ---------------------------------------------------------------------------------------------

export const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const base64 = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** HMAC SHA-256 of a message under a key given as bytes or as a UTF-8 string */
export async function hmacSha256(key: string | Uint8Array, message: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(message));
}

/** every byte compared, whatever the first difference: the timing does not say where two signatures diverge */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export type Verdict = { ok: true; t?: number } | { ok: false; reason: string };

// ---- the rows -----------------------------------------------------------------------------------------------

export const PAYMENT_COLLECTIONS = ["customers", "subscriptions", "payments"] as const;
export type PaymentCollection = (typeof PAYMENT_COLLECTIONS)[number];

/** where a provider's rows live: D1 through the records service, or whatever a test hands in */
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
export function d1Rows(env: Bindings, realtime?: RealtimeClient, who: { name: string; keyVar: string } = { name: "payments", keyVar: "a payment provider's key" }): PaymentRows {
  let pending: Promise<RecordContext> | undefined;
  const ctx = () => (pending ??= (async (): Promise<RecordContext> => ({
    db: env.DB, storage: env.STORAGE, auth: null, superuser: true,
    request: { auth: null, method: "POST", query: {}, headers: {}, body: {}, context: "default" },
    collections: await loadCollections(env.DB),
    realtime: realtime ?? idleRealtime,
  }))());
  const collection = async (name: PaymentCollection) => {
    const c = (await ctx()).collections.get(name);
    if (!c) throw new ApiError(503, `the ${who.name} plugin's collection "${name}" does not exist yet; it is created on the first request that carries ${who.keyVar}`);
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
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The three collections, as POST /api/collections would take them; `users` is the relation's target when it exists.
 * They are the same for every provider: `provider` on a customers row says which one it belongs to, and the ids
 * in `providerId` are that provider's.
 */
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

// ---- what a webhook says, applied to the rows ---------------------------------------------------------------

export interface WebhookResult { kind: string; customer?: string; subscription?: string; payment?: string; raw: Row }

/** the result of one event, with the empty parts left out so a test can compare it whole */
export const webhookResult = (kind: string, raw: Row, r: Omit<WebhookResult, "kind" | "raw">): WebhookResult =>
  ({ kind, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v)), raw });

/** the customer row behind a provider's customer id, created when the webhook is the first to mention it */
export async function ensureCustomer(rows: PaymentRows, provider: string, providerId: string, extra: { email?: string; user?: string } = {}): Promise<Row | null> {
  if (!providerId) return null;
  const found = await rows.find("customers", { provider, providerId });
  if (found) {
    const patch: Row = {};
    if (extra.email && !found.email) patch.email = extra.email;
    if (extra.user && !found.user) patch.user = extra.user;
    return Object.keys(patch).length ? rows.update("customers", str(found.id), patch) : found;
  }
  return rows.create("customers", { provider, providerId, email: extra.email ?? "", ...(extra.user ? { user: extra.user } : {}) });
}

/** one row per provider id: the second time an event mentions it, the row is updated and not doubled */
export async function upsert(rows: PaymentRows, collection: "subscriptions" | "payments", providerId: string, values: Row): Promise<Row> {
  const found = await rows.find(collection, { providerId });
  return found ? rows.update(collection, str(found.id), values) : rows.create(collection, { providerId, ...values });
}

// ---- the provider -------------------------------------------------------------------------------------------

export type CheckoutItems = { price: string; quantity: number }[];
export type CheckoutInput = { items: CheckoutItems; success: string; cancel?: string; mode?: "payment" | "subscription" };
/** how a subscription is stopped: at the period's end, now, or not after all */
export type CancelMode = "period_end" | "now" | "resume";

/** what a provider file brings: its knobs, its API calls, its signature check, its events read into the rows */
export interface PaymentProvider {
  /** the plugin's name and the last segment of its routes: `stripe`, `polar`, `lemonsqueezy` */
  name: string;
  /** how the provider is called in messages: `Stripe`, `Polar`, `Lemon Squeezy` */
  label: string;
  /** the knob that turns the provider on, named in every refusal */
  keyVar: string;
  /** the knob the webhook is verified against */
  webhookSecretVar: string;
  /** the key these bindings carry, or empty: no key means the provider is loaded and idle */
  key(env: Bindings): string;
  webhookSecret(env: Bindings): string;
  /** whether the key takes real money, for /api/plugins */
  livemode(env: Bindings): boolean;
  /** create (or find) the customer at the provider for a signed-in user: its id there, and the email it was made with */
  createCustomer(env: Bindings, auth: AuthRecord): Promise<{ providerId: string; email: string }>;
  /** refuse a checkout body this provider cannot take (400), before any customer is created for it */
  checkCheckout?(o: CheckoutInput): void;
  /** start a checkout for a customers row; where to send the customer */
  checkout(env: Bindings, customer: Row, o: CheckoutInput): Promise<{ url: string }>;
  /** where a customers row's owner manages their billing */
  portal(env: Bindings, customer: Row, o: { return: string }): Promise<{ url: string }>;
  /** stop (or resume) a subscriptions row at the provider; the patch the row follows with */
  cancel(env: Bindings, subscription: Row, mode: CancelMode): Promise<Row>;
  /** check a webhook as it arrived: the raw body and the headers, against the secret, at `now` (unix seconds) */
  verify(payload: string, headers: Headers, secret: string, now: number): Promise<Verdict>;
  /** write one verified event into the rows; null for an event the provider does not read */
  applyEvent(rows: PaymentRows, event: Row): Promise<WebhookResult | null>;
}

export interface PaymentDeps {
  /** how the provider is reached; a test hands in a fake */
  fetch: Fetch;
  /** where the rows live; a test hands in memory */
  rows: (env: Bindings, realtime?: RealtimeClient) => PaymentRows;
  /** the clock the webhook tolerance is measured against, in unix seconds */
  now: () => number;
}

/** the shipped dependencies: fetch, D1 through the records service, the real clock */
export function defaultDeps(who: { name: string; keyVar: string }): PaymentDeps {
  return { fetch: (input, init) => fetch(input, init), rows: (env, realtime) => d1Rows(env, realtime, who), now: () => Math.floor(Date.now() / 1000) };
}

/** the dependencies with a test's overrides on top, undefined ones ignored */
export function depsWith(who: { name: string; keyVar: string }, overrides: Partial<PaymentDeps> = {}): PaymentDeps {
  return { ...defaultDeps(who), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as PaymentDeps;
}

export const apiPrefix = (provider: string): string => `/api/payments/${provider}`;
export const webhookPathOf = (provider: string): string => `${apiPrefix(provider)}/webhook`;

/** the customers row for a signed-in user, created at the provider and here on the first contact */
export async function customerForUser(rows: PaymentRows, provider: PaymentProvider, env: Bindings, auth: AuthRecord): Promise<Row> {
  const user = str(auth.row.id);
  const found = await rows.find("customers", { provider: provider.name, user });
  if (found) return found;
  const created = await provider.createCustomer(env, auth);
  return rows.create("customers", { user, provider: provider.name, providerId: created.providerId, email: created.email });
}

// ---- the family: the shipped providers as one provider of payments@1 ------------------------------------

interface Member { provider: PaymentProvider; plugin: Plugin }
interface Family { members: Member[] }

/** the payment plugins applied to one app, in load order; the app is the identity every plugin's ctx shares */
const families = new WeakMap<Hono<AppEnv>, Family>();
const familyOf = (app: Hono<AppEnv>): Family => {
  let f = families.get(app);
  if (!f) families.set(app, (f = { members: [] }));
  return f;
};

/** the providers whose key these bindings carry, in shipped order: the first one is the active one */
const configured = (family: Family, env: Bindings): PaymentProvider[] => family.members.map((m) => m.provider).filter((p) => p.key(env));

const SHIPPED_ORDER = "the shipped order (stripe, polar, lemonsqueezy)";

/** the provider a call goes to with these bindings, or the refusal naming every knob that would turn one on */
function activeProvider(family: Family, env: Bindings): PaymentProvider {
  const all = configured(family, env);
  if (all.length) return all[0]!;
  const knobs = family.members.map((m) => m.provider);
  const list = knobs.map((p) => p.keyVar).join(knobs.length === 2 ? " or " : ", ");
  const webhooks = knobs.map((p) => p.webhookSecretVar).join(", ");
  throw new ApiError(503, `${knobs.length === 1 ? `${knobs[0]!.label} is not configured` : "No payment provider is configured"} on this instance: set ${list} (a secret) and, for the webhook, ${webhooks}`);
}

/** why the second configured provider is not the one answering, for /api/plugins and the 409 */
const whyNot = (winner: PaymentProvider, others: PaymentProvider[]): string =>
  `${others.map((p) => p.keyVar).join(" and ")} ${others.length > 1 ? "are" : "is"} set too; ${winner.name} answers because it comes first in ${SHIPPED_ORDER}. Unset the keys of the providers that are not meant`;

/** a provider's own route may only take money when it is the active one */
function mustBeActive(family: Family, provider: PaymentProvider, env: Bindings): string {
  const key = provider.key(env);
  if (!key) throw new ApiError(503, `${provider.label} is not configured on this instance: set ${provider.keyVar} (a secret) and, for the webhook, ${provider.webhookSecretVar}`);
  const first = configured(family, env)[0];
  if (first && first !== provider) throw new ApiError(409, `${provider.label} is configured but not active: ${first.keyVar} is set too and ${first.name} comes first in ${SHIPPED_ORDER}. Unset one of the two keys`);
  return key;
}

/** the customers row behind an id, which has to exist and be this provider's */
async function customerOf(rows: PaymentRows, provider: PaymentProvider, id: string): Promise<Row> {
  const row = await rows.find("customers", { id });
  if (!row || row.provider !== provider.name) throw notFound(`no ${provider.label} customer "${id}"`);
  return row;
}

// ---- the seam: who else hears about a payment ---------------------------------------------------------------

/**
 * What a verified webhook wrote, for whoever else cares about it.
 *
 * A payment provider owns its webhook route, and that is the point of the design: nothing else may claim the
 * path, and no other plugin can verify that provider's signature. But a plugin built on top of payments (the
 * commerce plugin is the first) has to learn that an order was paid, and it cannot learn it from a route it does
 * not own or from a collection it cannot hook. So this is the smallest seam that answers it and nothing more: a
 * list of callbacks the shared webhook path calls once the provider has read the event and written its rows, with
 * the env the request arrived with (the keys and bindings are in it), the realtime client of that request, the
 * result the provider reported, and the `payments` row it wrote when it wrote one.
 *
 * A watcher's error is the webhook's error, on purpose: the provider then retries, every write on this path is an
 * upsert by the provider's id, and a watcher is expected to be idempotent for the same reason. Nothing here reads
 * anything a watcher could not read for itself; it is only told when to look.
 *
 * Watchers belong to one app, the same identity the family is keyed by, and not to the module: two instances in
 * one process (a test suite, an executable serving two) must not hear each other's payments.
 */
export interface PaymentWritten {
  /** the provider the event came from: `stripe`, `polar`, `lemonsqueezy` */
  provider: string;
  env: Bindings;
  realtime?: RealtimeClient;
  result: WebhookResult;
  /** the `payments` row this event upserted, or null for an event that wrote none */
  payment: Row | null;
}
export type PaymentWatcher = (e: PaymentWritten) => Promise<void> | void;

const watchers = new WeakMap<Hono<AppEnv>, PaymentWatcher[]>();

/** watch every payments row the providers on this app write; the returned function stops watching */
export function onPaymentWritten(app: Hono<AppEnv>, watch: PaymentWatcher): () => void {
  let list = watchers.get(app);
  if (!list) watchers.set(app, (list = []));
  list.push(watch);
  return () => {
    const i = list.indexOf(watch);
    if (i >= 0) list.splice(i, 1);
  };
}

async function webhookThrough(provider: PaymentProvider, deps: PaymentDeps, env: Bindings, rows: PaymentRows, request: Request, o: { realtime?: RealtimeClient; app?: Hono<AppEnv> } = {}): Promise<WebhookResult | null> {
  const secret = provider.webhookSecret(env);
  if (!secret) throw new ApiError(503, `${provider.label} webhooks are not configured on this instance: set ${provider.webhookSecretVar} (a secret) to the signing secret of the endpoint registered as ${webhookPathOf(provider.name)}`);
  const payload = await request.text();
  const verdict = await provider.verify(payload, request.headers, secret, deps.now());
  if (!verdict.ok) throw badRequest(`${provider.label} webhook refused: ${verdict.reason}`);
  let event: Row;
  try { event = obj(JSON.parse(payload)); } catch { throw badRequest(`${provider.label} webhook refused: the payload is not JSON`); }
  const result = await provider.applyEvent(rows, event);
  const watching = (o.app && watchers.get(o.app)) || [];
  if (result && watching.length) {
    const payment = result.payment ? await rows.find("payments", { id: result.payment }) : null;
    for (const watch of [...watching]) await watch({ provider: provider.name, env, realtime: o.realtime, result, payment });
  }
  return result;
}

async function cancelThrough(provider: PaymentProvider, env: Bindings, rows: PaymentRows, sub: Row, mode: CancelMode): Promise<Row> {
  const patch = await provider.cancel(env, sub, mode);
  return Object.keys(patch).length ? rows.update("subscriptions", str(sub.id), patch) : sub;
}

const cancelModeOf = (o: { now?: boolean; resume?: boolean } = {}): CancelMode => (o.resume ? "resume" : o.now ? "now" : "period_end");

/**
 * A provider as a plugin. `anchor` is the one that claims `payments@1` and owns the collections for the family
 * (see the top of this file); the others require it. Both mount their own routes and create the collections on
 * the first request that carries their key.
 */
export function paymentsPlugin(provider: PaymentProvider, deps: PaymentDeps, o: { anchor: boolean; version?: string }): Plugin & { payments: Payments } {
  const API = apiPrefix(provider.name), WEBHOOK = webhookPathOf(provider.name);
  const plugin = {} as Plugin & { payments: Payments };
  // standalone until applied: then the family of the app it was applied to, shared with the other providers
  let family: Family = { members: [{ provider, plugin }] };
  // the app this plugin was applied to, which is what the payment watchers are keyed by
  let mounted: Hono<AppEnv> | undefined;

  const payments: Payments = {
    route(env): PaymentsRoute | null {
      const all = configured(family, env);
      if (!all.length) return null;
      const [p, ...rest] = all as [PaymentProvider, ...PaymentProvider[]];
      return { via: p.name, webhook: webhookPathOf(p.name), livemode: p.livemode(env), ...(rest.length ? { also: rest.map((r) => r.name), reason: whyNot(p, rest) } : {}) };
    },
    async customer(env, auth) {
      const p = activeProvider(family, env);
      return str((await customerForUser(deps.rows(env), p, env, auth)).id);
    },
    async checkout(env, o) {
      const p = activeProvider(family, env);
      const rows = deps.rows(env);
      return p.checkout(env, await customerOf(rows, p, o.customer), o);
    },
    async portal(env, o) {
      const p = activeProvider(family, env);
      const rows = deps.rows(env);
      return p.portal(env, await customerOf(rows, p, o.customer), o);
    },
    webhook(env, request) {
      // a provider's own webhook path names it; anything else goes to the active provider
      const path = new URL(request.url).pathname;
      const byPath = family.members.find((m) => webhookPathOf(m.provider.name) === path)?.provider;
      const p = byPath ?? activeProvider(family, env);
      return webhookThrough(p, deps, env, deps.rows(env), request, { ...(mounted ? { app: mounted } : {}) });
    },
    async cancel(env, subscription, o = {}) {
      const p = activeProvider(family, env);
      const rows = deps.rows(env);
      const sub = await rows.find("subscriptions", { id: subscription });
      if (!sub) throw notFound(`no subscription "${subscription}"`);
      await cancelThrough(p, env, rows, sub, cancelModeOf(o));
    },
  };

  const readBody = async (c: Context<AppEnv>): Promise<Row> => {
    try { return obj(await c.req.json()); } catch { throw badRequest("the body must be a JSON object"); }
  };
  const rowsFor = (c: Context<AppEnv>) => deps.rows(c.env, c.get("realtime"));

  Object.assign(plugin, {
    manifest: {
      name: provider.name,
      version: o.version ?? "0.1.0",
      tier: "official" as const,
      voidbase: "*",
      ...(o.anchor ? { provides: ["payments@1" as const], collections: [...PAYMENT_COLLECTIONS] } : { requires: ["payments@1" as const] }),
    },
    payments,
    apply(ctx: Kernel) {
      mounted = ctx.app;
      const shared = familyOf(ctx.app);
      shared.members.push({ provider, plugin });
      family = shared;
      if (o.anchor) serve<Payments>(ctx, "payments@1", payments);
      // the collections exist only where a key does: an instance that never takes money never sees them. Whoever
      // in the family owns them creates them, because the loader lets a collection have one owner.
      onBootstrap(ctx, async (env) => {
        if (!provider.key(env)) return;
        const owner = family.members.find((m) => m.plugin.manifest.collections?.length)?.plugin;
        if (!owner) { logger.warn(`voidbase: ${provider.name} has ${provider.keyVar} but no plugin in its family owns the payments collections; nothing is created`); return; }
        await ensureCollections(owner, env.DB, await collectionDefinitions(env.DB));
      });
      const app = ctx.app;

      app.post(`${API}/checkout`, async (c) => {
        const auth = requireAuth(c);
        mustBeActive(family, provider, c.env);
        const body = await readBody(c);
        const items = Array.isArray(body.items) ? (body.items as unknown[]).map(obj) : [];
        if (!items.length || items.some((i) => !str(i.price) || !(Number.isInteger(Number(i.quantity ?? 1)) && Number(i.quantity ?? 1) > 0))) throw badRequest("items must be a non-empty list of { price, quantity }");
        const success = str(body.success), cancelUrl = str(body.cancel);
        if (!success) throw badRequest("success must be the URL to return to");
        const mode = body.mode === undefined ? "payment" : body.mode;
        if (mode !== "payment" && mode !== "subscription") throw badRequest('mode must be "payment" or "subscription"');
        const input: CheckoutInput = { items: items.map((i) => ({ price: str(i.price), quantity: Number(i.quantity ?? 1) })), success, ...(cancelUrl ? { cancel: cancelUrl } : {}), mode };
        provider.checkCheckout?.(input);
        const rows = rowsFor(c);
        const customer = await customerForUser(rows, provider, c.env, auth);
        return c.json(await provider.checkout(c.env, customer, input));
      });

      app.post(`${API}/portal`, async (c) => {
        const auth = requireAuth(c);
        mustBeActive(family, provider, c.env);
        const body = await readBody(c);
        const back = str(body.return);
        if (!back) throw badRequest("return must be the URL to come back to");
        const rows = rowsFor(c);
        const customer = await customerForUser(rows, provider, c.env, auth);
        return c.json(await provider.portal(c.env, customer, { return: back }));
      });

      app.post(`${API}/cancel`, async (c) => {
        const auth = requireAuth(c);
        mustBeActive(family, provider, c.env);
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
        const updated = await cancelThrough(provider, c.env, rows, sub, cancelModeOf({ now: body.now === true, resume: body.resume === true }));
        return c.json({ subscription: str(updated.id), status: str(updated.status), cancelAtPeriodEnd: !!updated.cancelAtPeriodEnd });
      });

      app.post(WEBHOOK, async (c) => {
        mustBeActive(family, provider, c.env);
        const result = await webhookThrough(provider, deps, c.env, rowsFor(c), c.req.raw, { realtime: c.get("realtime"), app });
        return c.json({ received: true, handled: !!result, ...(result ? { kind: result.kind } : {}) });
      });
    },
  });
  return plugin;
}
