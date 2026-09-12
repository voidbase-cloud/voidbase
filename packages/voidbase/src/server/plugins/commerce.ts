// A shop the other plugins plug into.
//
// The roadmap's entry, and the whole of the design is in its last sentence: "It requires interfaces rather than
// particular plugins, so a payment plugin supplies checkout, a shipping plugin supplies rates, and a plugin of
// your own supplies whatever your business does that nobody else's does, without commerce knowing which." So this
// file holds the parts of a shop that are the same everywhere (products and variants, inventory, carts, orders,
// tax and shipping totals, fulfilment, refunds and an audit trail) and none of the parts that are not. It
// requires `payments@1`, `tax@1` and `shipping@1`, it never imports stripe, tax-flat or shipping-flat, and
// swapping any of the three is installing a different plugin.
//
// What that costs, and what it buys:
//
//   - Checkout is the payment plugin's. Commerce turns a cart into a pending order, reserves the stock, hands the
//     line items to `payments@1` with the tax and the shipping as amounts of their own and the order's id as the
//     reference, and answers the URL it gets back. It does not verify a signature, own a webhook path or know what
//     a Stripe price is.
//   - Learning that an order was paid therefore cannot be a route of ours. The seam is `onPaymentWritten` in
//     payments-shared.ts, added with this plugin because none existed: the shared webhook path calls its watchers
//     once a provider has verified an event and upserted its `payments` row, and this plugin's watcher moves the
//     order the payment names, when that order is the payer's and pending (or, for a success, was cancelled by a
//     failed payment), and on a success only when the payment is that order's total before any tax the provider
//     added of its own and bought what the order is, where the provider says. A payment that names no order moves
//     none. A watcher's error is the webhook's error, so a provider retries: every move is a claim on the order's
//     status that only one request wins, and every step a move leaves is written once however often it is told.
//   - Tax and shipping are quoted through their interfaces at the address step and again at checkout, because a
//     quote an hour old is not a quote. The shipped `tax-flat` and `shipping-flat` make that work out of the box.
//
// Everything is an integer in the currency's minor unit, like the payments plugin's `amount`. Every state change
// writes a `commerce_audit` row, which is append-only and superuser-read: an order that moved and cannot say why
// is the one thing a shop may not have. Writes go through the routes and never through the records API: the
// collections' create, update and delete rules are all null, so a customer reads their own rows and writes none.
//
// `VOIDBASE_COMMERCE` turns it on. Unset, the plugin is loaded and idle: the ten collections are not created and
// every route answers 503 naming the knob, so an instance that does not sell anything never grows a shop.
import { logger } from "#platform/log";
import { env as voidEnv } from "#platform/env";
import { isSuperuser, requireAuth, requireSuperuser } from "../auth-slot";
import { findCollection, loadCollections } from "../collections/model";
import { collectionId } from "../collections/service";
import { all, ident } from "../db";
import { ApiError, badRequest, forbidden, notFound } from "../errors";
import type { CheckoutRequest, Payments, QuoteAddress, QuoteItem, RealtimeClient, Shipping, ShippingRate, Tax } from "../interfaces";
import { onBootstrap, using, type Kernel } from "../kernel";
import { createRecord, deleteRecord, PreconditionFailed, updateRecord, type RecordContext } from "../records/service";
import { rowToValues } from "../records/values";
import { bufferedTransaction } from "../tx-d1";
import type { AppEnv, AuthRecord, Bindings, Row } from "../types";
import { ensureCollections } from "./collections";
import type { Plugin } from "./manifest";
import { chargedBeforeProviderTax, obj, onPaymentWritten, paymentReference, purchasedItems, str, type PaymentWritten, type PurchasedItem } from "./payments-shared";
import type { Context } from "hono";

export const API = "/api/commerce";
export const COMMERCE_VAR = "VOIDBASE_COMMERCE";
export const CURRENCY_VAR = "VOIDBASE_COMMERCE_CURRENCY";
/** the header (or `?token=`) an anonymous cart is carried by */
export const CART_TOKEN_HEADER = "x-cart-token";
/** how long an untouched cart is good for */
export const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const knob = (env: object | undefined, name: string): string =>
  String((env as Record<string, unknown> | undefined)?.[name] ?? (voidEnv as Record<string, unknown>)[name] ?? "").trim();

/** whether this instance sells anything: `VOIDBASE_COMMERCE` set to anything but 0, false or off */
export const commerceOn = (env?: object): boolean => {
  const v = knob(env, COMMERCE_VAR).toLowerCase();
  return !!v && v !== "0" && v !== "false" && v !== "off";
};
/** the currency a new cart is in; lower case, the way every provider writes it */
export const defaultCurrency = (env?: object): string => (knob(env, CURRENCY_VAR) || "usd").toLowerCase();

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
};
const positiveInt = (v: unknown, fallback: number): number => {
  const x = Number(v ?? fallback);
  return Number.isInteger(x) && x > 0 ? x : NaN;
};

// ---- the rows ------------------------------------------------------------------------------------------------

export const COMMERCE_COLLECTIONS = ["products", "variants", "inventory", "carts", "cart_items", "orders", "order_items", "shipments", "refunds", "commerce_audit"] as const;
export type CommerceCollection = (typeof COMMERCE_COLLECTIONS)[number];

/**
 * Where the shop's rows live: D1 through the records service, or whatever a test hands in. `customers` is the
 * odd one out and read-only on purpose: the row belongs to the payments plugin, commerce only ever looks one up
 * to scope a read, and the one place it may be created is through `payments@1` at checkout.
 */
export interface CommerceRows {
  find(collection: CommerceCollection, where: Record<string, string>): Promise<Row | null>;
  list(collection: CommerceCollection, where: Record<string, string>): Promise<Row[]>;
  create(collection: CommerceCollection, values: Row): Promise<Row>;
  update(collection: CommerceCollection, id: string, values: Row): Promise<Row>;
  /**
   * Update a row only while it still has the values `where` names, and say whether this call changed it: a
   * compare-and-set. Added 2026-09-11 for the payment watcher, because Stripe tells of one payment twice at once (the
   * session and its payment intent), and two requests that had both read the same order both moved it: both wrote
   * `order.paid`, and a revived order's stock was reserved twice. At D1 it is the records service's own update, held to
   * `where` (`UpdateOptions`), so the hooks on the collection see the row move and can refuse it.
   */
  updateWhere(collection: CommerceCollection, id: string, where: Record<string, string>, values: Row): Promise<boolean>;
  /**
   * Create a row whose id the caller derived, unless a row of that id is there already, and with it `alongside`, the
   * updates the row records (a line's stock moved): all of it or none of it, and none of it when the row is there, so the
   * same step asked for twice, by a provider's retry or by two deliveries at once, happens once. Answers whether this
   * call wrote it. Added 2026-09-11 for the steps a payment's move of an order leaves, after a retry following a failed
   * write released a cancelled order's stock a second time, or reserved a revived order's twice, or never.
   *
   * Two things to know at D1, where it is one buffered transaction sent as one batch (`d1Rows`). A unit that loses the
   * race writes nothing, but the collections' after-success hooks have already run for the writes it issued by the time
   * the batch is refused and takes them back, so a hook that hears of a step's write may be hearing of one that never
   * landed. And `alongside` takes at most one update per collection: the second would read a table this transaction has
   * already written, which a buffered transaction refuses rather than answer a stale row (src/server/tx-d1.ts).
   */
  createOnce(collection: CommerceCollection, values: Row & { id: string }, alongside?: { collection: CommerceCollection; id: string; values: Row }[]): Promise<boolean>;
  remove(collection: CommerceCollection, id: string): Promise<void>;
  /** the payments plugin's `customers` rows for a signed-in user, read only */
  customers(user: string): Promise<Row[]>;
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

/** a realtime client whose announcements wait in `held`, for writes that land only once their batch commits */
const holding = (real: RealtimeClient, held: Parameters<RealtimeClient["publish"]>[0]): RealtimeClient => ({
  active: () => real.active(),
  publish: async (changes) => { held.push(...changes); },
  presence: (op, member, o) => real.presence(op, member, o),
  publishToClient: (clientId, event, data) => real.publishToClient(clientId, event, data),
  controlClient: (clientId, subscriptions, token) => real.controlClient(clientId, subscriptions, token),
  openSocket: (clientId) => real.openSocket(clientId),
});

/** the rows in D1, written through the records service as a superuser so hooks fire and realtime sees the change */
export function d1Rows(env: Bindings, realtime?: RealtimeClient): CommerceRows {
  let pending: Promise<RecordContext> | undefined;
  const ctx = () => (pending ??= (async (): Promise<RecordContext> => ({
    db: env.DB, storage: env.STORAGE, auth: null, superuser: true,
    request: { auth: null, method: "POST", query: {}, headers: {}, body: {}, context: "default" },
    collections: await loadCollections(env.DB),
    realtime: realtime ?? idleRealtime,
  }))());
  const collection = async (name: CommerceCollection) => {
    const c = (await ctx()).collections.get(name);
    if (!c) throw new ApiError(503, `the commerce plugin's collection "${name}" does not exist yet; it is created on the first request once ${COMMERCE_VAR} is set`);
    return c;
  };
  const where = (w: Record<string, string>) => {
    const keys = Object.keys(w);
    return { sql: keys.map((k) => `${ident(k)} = ?`).join(" AND "), params: keys.map((k) => w[k]) };
  };
  return {
    async find(name, w) {
      const rows = await this.list(name, w);
      return rows[0] ?? null;
    },
    async list(name, w) {
      const c = await collection(name);
      const q = where(w);
      const rows = await all<Row>(env.DB, `SELECT * FROM ${ident(name)}${q.sql ? ` WHERE ${q.sql}` : ""} ORDER BY rowid ASC`, q.params);
      return rows.map((r) => rowToValues(c, r) as Row);
    },
    async create(name, values) { return (await createRecord(await ctx(), await collection(name), values, {})) as Row; },
    async update(name, id, values) { return (await updateRecord(await ctx(), await collection(name), id, values, {})) as Row; },
    async updateWhere(name, id, w, values) {
      // The claim is the records service's own update, held to `w` (UpdateOptions.where): validation and the hooks on the
      // collection run first and see the row go from what it is to what it becomes, a hook that refuses stops it, and an
      // UPDATE that finds the row moved since it was read changes nothing, fires no after-success hook and announces
      // nothing. Until 2026-09-11 a raw UPDATE claimed the row first and the service wrote the same values after it, so a
      // hook saw the claimed status as the original, and one that refused left the row claimed.
      try { await updateRecord(await ctx(), await collection(name), id, values, { where: w }); return true; }
      catch (e) { if (e instanceof PreconditionFailed) return false; throw e; }
    },
    async createOnce(name, values, alongside = []) {
      const id = str(values.id);
      if (await this.find(name, { id })) return false;
      // With updates, they and the row go through the records service like every other write here, into one transaction
      // (src/server/tx-d1.ts) sent as one batch, which D1 runs as a transaction that a failing statement rolls back and the
      // database Durable Object runs inside transactionSync: a row of that id written by another request since the read
      // above fails the batch on its primary key, and takes the updates back with it. The service's hooks run as the
      // writes are issued, before that commit; realtime hears of the writes only once they have landed. Without updates
      // the row is one create, which that primary key refuses just the same.
      const base = await ctx(), held: Parameters<RealtimeClient["publish"]>[0] = [];
      try {
        if (!alongside.length) { await createRecord(base, await collection(name), values, {}); return true; }
        const tx = bufferedTransaction(env.DB);
        const inside: RecordContext = { ...base, db: tx.db, realtime: holding(base.realtime, held), changes: undefined };
        for (const u of alongside) await updateRecord(inside, await collection(u.collection), u.id, u.values, {});
        await createRecord(inside, await collection(name), values, {});
        await tx.commit();
      } catch (e) {
        if (await this.find(name, { id })) return false;
        throw e;
      }
      if (held.length) await base.realtime.publish(held);
      return true;
    },
    async remove(name, id) { await deleteRecord(await ctx(), await collection(name), id); },
    async customers(user) {
      if (!user) return [];
      const c = (await ctx()).collections.get("customers");
      if (!c) return [];
      const rows = await all<Row>(env.DB, "SELECT * FROM `customers` WHERE `user` = ?", [user]);
      return rows.map((r) => rowToValues(c, r) as Row);
    },
  };
}

// ---- the collections -----------------------------------------------------------------------------------------

export const ORDER_STATUSES = ["pending", "paid", "fulfilled", "cancelled", "refunded"] as const;
export const CART_STATUSES = ["open", "ordered", "abandoned"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The ten collections, as `POST /api/collections` would take them.
 *
 * The rules are the design said out loud. Products, variants and inventory are a catalogue, so anyone may read
 * them and a rule of `active = true` is what hides a draft from everyone but a superuser. Everything else is
 * somebody's, so it is scoped to the owner through the payments plugin's `customers.user`, or through the cart's
 * own user. Nothing has a create, update or delete rule at all: every write in this plugin goes through a route
 * that checks the stock, records the audit row and answers with what happened, and a customer editing their own
 * order's total through the records API is exactly what that exists to stop. An anonymous cart is reachable by
 * its token through the routes and not through the records API, because a rule cannot hold a secret.
 */
export async function collectionDefinitions(db: D1Database): Promise<Record<string, unknown>[]> {
  // the payments plugin's two, by the id its own definitions give them, so the relation lands whether its
  // collections exist yet or not (they are created on the first request that carries a provider's key)
  const customers = (await findCollection(db, "customers"))?.id ?? collectionId("base", "customers");
  const payments = (await findCollection(db, "payments"))?.id ?? collectionId("base", "payments");
  const products = collectionId("base", "products"), variants = collectionId("base", "variants");
  const carts = collectionId("base", "carts"), orders = collectionId("base", "orders");
  const autodates = [{ name: "created", type: "autodate", onCreate: true, onUpdate: false }, { name: "updated", type: "autodate", onCreate: true, onUpdate: true }];
  const noWrites = { createRule: null, updateRule: null, deleteRule: null };
  // The rules name the order's own `user`, not the payments plugin's `customers.user`: a rule that traverses a
  // collection another plugin creates only when its key is set is invalid on an instance without one, and an
  // invalid rule fails the create, which used to take every request down with it (seen on the demo, 2026-09-11).
  // It is the auth record's id as text rather than a relation to `users`, because the buyer may be a record of any
  // auth collection, a superuser included, and a relation to one collection refuses every other (the same reason
  // `ai_conversations` carries an owner id).
  const ownOrder = "order.user = @request.auth.id";
  return [
    {
      name: "products", type: "base", listRule: "active = true", viewRule: "active = true", ...noWrites,
      fields: [
        { name: "title", type: "text", required: true, presentable: true },
        { name: "slug", type: "text", required: true },
        { name: "description", type: "editor" },
        { name: "images", type: "file", maxSelect: 10 },
        { name: "active", type: "bool" },
        { name: "metadata", type: "json" },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_commerce_product_slug` ON `products` (`slug`)"],
    },
    {
      name: "variants", type: "base", listRule: "active = true && product.active = true", viewRule: "active = true && product.active = true", ...noWrites,
      fields: [
        { name: "product", type: "relation", collectionId: products, maxSelect: 1, required: true, cascadeDelete: true },
        { name: "sku", type: "text", required: true, presentable: true },
        { name: "title", type: "text" },
        { name: "price", type: "number" },
        { name: "currency", type: "text" },
        { name: "weight", type: "number" },
        // what the payment provider knows this variant by (a Stripe price, a Polar product, a Lemon Squeezy
        // variant); the sku is sent when it is empty, which is what a provider keyed by sku wants
        { name: "priceId", type: "text" },
        { name: "active", type: "bool" },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_commerce_variant_sku` ON `variants` (`sku`)"],
    },
    {
      name: "inventory", type: "base", listRule: "variant.active = true", viewRule: "variant.active = true", ...noWrites,
      fields: [
        { name: "variant", type: "relation", collectionId: variants, maxSelect: 1, required: true, cascadeDelete: true },
        { name: "onHand", type: "number" },
        { name: "reserved", type: "number" },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_commerce_inventory_variant` ON `inventory` (`variant`)"],
    },
    {
      name: "carts", type: "base", listRule: "user = @request.auth.id", viewRule: "user = @request.auth.id", ...noWrites,
      fields: [
        { name: "user", type: "text" },
        { name: "token", type: "text" },
        { name: "currency", type: "text" },
        { name: "status", type: "select", maxSelect: 1, values: [...CART_STATUSES] },
        { name: "expires", type: "date" },
        // where it is going, set by POST /cart/address; the tax and shipping quotes are asked for against it and
        // asked for again at checkout, so nothing stale is ever charged
        { name: "address", type: "json" },
        ...autodates,
      ],
      indexes: ["CREATE INDEX `idx_commerce_cart_token` ON `carts` (`token`)"],
    },
    {
      name: "cart_items", type: "base", listRule: "cart.user = @request.auth.id", viewRule: "cart.user = @request.auth.id", ...noWrites,
      fields: [
        { name: "cart", type: "relation", collectionId: carts, maxSelect: 1, required: true, cascadeDelete: true },
        { name: "variant", type: "relation", collectionId: variants, maxSelect: 1, required: true, cascadeDelete: false },
        { name: "quantity", type: "number" },
        { name: "unitPrice", type: "number" },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_commerce_cart_item` ON `cart_items` (`cart`, `variant`)"],
    },
    {
      name: "orders", type: "base", listRule: "user = @request.auth.id", viewRule: "user = @request.auth.id", ...noWrites,
      fields: [
        { name: "number", type: "text", required: true, presentable: true },
        { name: "customer", type: "relation", collectionId: customers, maxSelect: 1, cascadeDelete: false },
        { name: "user", type: "text", required: true },
        { name: "email", type: "text" },
        { name: "status", type: "select", maxSelect: 1, values: [...ORDER_STATUSES] },
        { name: "currency", type: "text" },
        { name: "subtotal", type: "number" },
        { name: "tax", type: "number" },
        { name: "shipping", type: "number" },
        { name: "total", type: "number" },
        { name: "address", type: "json" },
        { name: "payment", type: "relation", collectionId: payments, maxSelect: 1, cascadeDelete: false },
        { name: "placedAt", type: "date" },
        ...autodates,
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_commerce_order_number` ON `orders` (`number`)"],
    },
    {
      // a record of what was bought, not a pointer to it: a variant's title and price may change tomorrow and the
      // order may not, so the sku, the title, the quantity and the prices are copied in at checkout
      name: "order_items", type: "base", listRule: ownOrder, viewRule: ownOrder, ...noWrites,
      fields: [
        { name: "order", type: "relation", collectionId: orders, maxSelect: 1, required: true, cascadeDelete: true },
        { name: "variant", type: "relation", collectionId: variants, maxSelect: 1, cascadeDelete: false },
        { name: "sku", type: "text" },
        { name: "title", type: "text" },
        { name: "quantity", type: "number" },
        { name: "unitPrice", type: "number" },
        { name: "total", type: "number" },
        // what the checkout named the line by at the payment provider (the variant's `priceId`, or its sku): what a
        // payment is held against where the provider says what was bought (`purchasedItems`). Added 2026-09-11
        { name: "priceId", type: "text" },
        ...autodates,
      ],
    },
    {
      name: "shipments", type: "base", listRule: ownOrder, viewRule: ownOrder, ...noWrites,
      fields: [
        { name: "order", type: "relation", collectionId: orders, maxSelect: 1, required: true, cascadeDelete: true },
        { name: "carrier", type: "text" },
        { name: "tracking", type: "text" },
        { name: "shippedAt", type: "date" },
        { name: "items", type: "json" },
        ...autodates,
      ],
    },
    {
      name: "refunds", type: "base", listRule: ownOrder, viewRule: ownOrder, ...noWrites,
      fields: [
        { name: "order", type: "relation", collectionId: orders, maxSelect: 1, required: true, cascadeDelete: true },
        { name: "amount", type: "number" },
        { name: "reason", type: "text" },
        { name: "providerId", type: "text" },
        { name: "refundedAt", type: "date" },
        ...autodates,
      ],
    },
    {
      // append-only and superuser-read: every state change in this file writes one, and nothing ever edits one
      name: "commerce_audit", type: "base", listRule: null, viewRule: null, ...noWrites,
      fields: [
        { name: "at", type: "date" },
        { name: "actor", type: "text" },
        { name: "action", type: "text", presentable: true },
        { name: "subject", type: "text" },
        { name: "detail", type: "json" },
        ...autodates,
      ],
      indexes: ["CREATE INDEX `idx_commerce_audit_subject` ON `commerce_audit` (`subject`)"],
    },
  ];
}

// ---- the shop's own arithmetic -------------------------------------------------------------------------------

/** what a line of a cart or an order is, once the variant behind it has been read */
export interface Line { item: Row; variant: Row; quantity: number; unitPrice: number }

/** what a line of an order is at the payment provider: the ids its checkout may have named it by, and how many */
interface OrderedItem { id: string; ids: string[]; quantity: number }

const lineTotal = (l: Line): number => l.quantity * l.unitPrice;
export const subtotalOf = (lines: Line[]): number => lines.reduce((sum, l) => sum + lineTotal(l), 0);
const quoteItems = (lines: Line[]): QuoteItem[] =>
  lines.map((l) => ({ variant: str(l.variant.id), sku: str(l.variant.sku), title: str(l.variant.title), quantity: l.quantity, unitPrice: l.unitPrice, ...(n(l.variant.weight) ? { weight: n(l.variant.weight) } : {}) }));

/** the address as a destination: the fields the two interfaces know, anything else dropped */
const ADDRESS_FIELDS = ["line1", "line2", "city", "region", "postcode", "country"] as const;
export function addressOf(v: unknown): QuoteAddress {
  const raw = obj(v);
  const out: Record<string, string> = {};
  for (const f of ADDRESS_FIELDS) if (str(raw[f])) out[f] = f === "country" ? str(raw[f]).toUpperCase() : str(raw[f]);
  return out as QuoteAddress;
}
const hasAddress = (a: QuoteAddress): boolean => Object.keys(a).length > 0;

/** what is left of a variant's stock: a variant with no inventory row is not tracked, and never blocks a sale */
export async function available(rows: CommerceRows, variant: string): Promise<number | null> {
  const inv = await rows.find("inventory", { variant });
  return inv ? n(inv.onHand) - n(inv.reserved) : null;
}

async function reserve(rows: CommerceRows, variant: string, quantity: number): Promise<void> {
  const inv = await rows.find("inventory", { variant });
  if (!inv) return;
  await rows.update("inventory", str(inv.id), { reserved: n(inv.reserved) + quantity });
}

async function release(rows: CommerceRows, variant: string, quantity: number): Promise<void> {
  const inv = await rows.find("inventory", { variant });
  if (!inv) return;
  await rows.update("inventory", str(inv.id), { reserved: Math.max(0, n(inv.reserved) - quantity) });
}

/** the goods left the building: the reservation goes and so does the stock it was held against */
async function ship(rows: CommerceRows, variant: string, quantity: number): Promise<void> {
  const inv = await rows.find("inventory", { variant });
  if (!inv) return;
  await rows.update("inventory", str(inv.id), { onHand: Math.max(0, n(inv.onHand) - quantity), reserved: Math.max(0, n(inv.reserved) - quantity) });
}

// ---- the plugin ----------------------------------------------------------------------------------------------

export interface CommerceDeps {
  /** where the rows live; a test hands in memory */
  rows: (env: Bindings, realtime?: RealtimeClient) => CommerceRows;
  /** the clock, in milliseconds */
  now: () => number;
  /** an anonymous cart's token */
  token: () => string;
  /** an order's number, as a human reads it out over the telephone */
  number: () => string;
}

const randomToken = (): string => crypto.randomUUID().replace(/-/g, "");
const randomNumber = (): string => `VB-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 36 ** 3).toString(36).toUpperCase().padStart(3, "0")}`;

export const defaultDeps = (): CommerceDeps => ({ rows: (env, realtime) => d1Rows(env, realtime), now: () => Date.now(), token: randomToken, number: randomNumber });

export function commerceWith(overrides: Partial<CommerceDeps> = {}): Plugin & { stopWatchingPayments: () => void } {
  const deps: CommerceDeps = { ...defaultDeps(), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as CommerceDeps;
  const iso = () => new Date(deps.now()).toISOString();

  const mustBeOn = (env: Bindings) => {
    if (!commerceOn(env)) throw new ApiError(503, `The shop is not turned on on this instance: set ${COMMERCE_VAR}=1`);
  };

  // --- the audit trail ---------------------------------------------------------------------------------------
  const audit = async (rows: CommerceRows, actor: string, action: string, subject: string, detail: Row): Promise<void> => {
    await rows.create("commerce_audit", { at: iso(), actor, action, subject, detail });
  };
  const actorOf = (auth: AuthRecord | null | undefined): string => (auth ? `${auth.collection.name}:${str(auth.row.id)}` : "anonymous");

  // --- the cart ----------------------------------------------------------------------------------------------
  const tokenOf = (c: Context<AppEnv>, body: Row = {}): string => str(c.req.header(CART_TOKEN_HEADER) || c.req.query("token") || body.token);

  /** the caller's open cart, found by their session or by the token they carry; created only when asked */
  async function cartOf(rows: CommerceRows, c: Context<AppEnv>, o: { create: boolean; body?: Row }): Promise<Row | null> {
    const auth = c.get("auth");
    const user = auth ? str(auth.row.id) : "";
    const token = tokenOf(c, o.body);
    if (user) {
      const mine = await rows.find("carts", { user, status: "open" });
      if (mine) return mine;
      // signing in with an anonymous cart in hand claims it rather than losing it
      if (token) {
        const theirs = await rows.find("carts", { token, status: "open" });
        if (theirs && !str(theirs.user)) {
          const claimed = await rows.update("carts", str(theirs.id), { user });
          await audit(rows, actorOf(auth), "cart.claimed", `cart:${str(theirs.id)}`, { token });
          return claimed;
        }
      }
    } else if (token) {
      const theirs = await rows.find("carts", { token, status: "open" });
      if (theirs) return str(theirs.user) ? null : theirs;
    }
    if (!o.create) return null;
    const created = await rows.create("carts", {
      ...(user ? { user } : { token: deps.token() }),
      currency: defaultCurrency(c.env), status: "open", expires: new Date(deps.now() + CART_TTL_MS).toISOString(), address: {},
    });
    await audit(rows, actorOf(auth), "cart.created", `cart:${str(created.id)}`, {});
    return created;
  }

  /** the cart's lines with the variant behind each, in the order they were added */
  async function linesOf(rows: CommerceRows, collection: "cart_items" | "order_items", key: string, id: string): Promise<Line[]> {
    const items = await rows.list(collection, { [key]: id });
    const lines: Line[] = [];
    for (const item of items) {
      const variant = (await rows.find("variants", { id: str(item.variant) })) ?? { id: str(item.variant) };
      lines.push({ item, variant, quantity: n(item.quantity), unitPrice: n(item.unitPrice) });
    }
    return lines;
  }

  const cartView = (cart: Row, lines: Line[]): Row => ({
    id: str(cart.id),
    ...(str(cart.token) ? { token: str(cart.token) } : {}),
    currency: str(cart.currency), status: str(cart.status), expires: str(cart.expires), address: addressOf(cart.address),
    items: lines.map((l) => ({ id: str(l.item.id), variant: str(l.variant.id), sku: str(l.variant.sku), title: str(l.variant.title), quantity: l.quantity, unitPrice: l.unitPrice, total: lineTotal(l) })),
    subtotal: subtotalOf(lines),
  });

  const orderView = (order: Row, lines: Line[] = []): Row => ({
    id: str(order.id), number: str(order.number), status: str(order.status), email: str(order.email),
    currency: str(order.currency), subtotal: n(order.subtotal), tax: n(order.tax), shipping: n(order.shipping), total: n(order.total),
    address: addressOf(order.address), placedAt: str(order.placedAt), ...(str(order.payment) ? { payment: str(order.payment) } : {}),
    ...(lines.length ? { items: lines.map((l) => ({ id: str(l.item.id), variant: str(l.item.variant), sku: str(l.item.sku), title: str(l.item.title), quantity: l.quantity, unitPrice: l.unitPrice, total: n(l.item.total) })) } : {}),
  });

  const plugin = {} as Plugin & { stopWatchingPayments: () => void };
  let ctx: Kernel | undefined;
  const need = <T,>(iface: "payments@1" | "tax@1" | "shipping@1"): T => {
    const found = ctx ? using<T | undefined>(ctx, iface) : undefined;
    if (!found) throw new ApiError(503, `the commerce plugin requires "${iface}" and nothing provides it on this instance`);
    return found;
  };

  // --- a payment the provider wrote --------------------------------------------------------------------------
  /**
   * Whether a payment is an order's total, to the unit, in its currency (providers write a currency in either case).
   * The amount compared is what the provider charged before any tax of its own (`chargedBeforeProviderTax`), not the
   * row's `amount`: Polar and Lemon Squeezy are merchants of record, they add their tax on top of what a checkout asks
   * for and write the total with it, and the order's total cannot hold that tax, since neither takes an amount line.
   * A figure that cannot be read off what the provider sent is NaN, which is no order's total.
   */
  const pays = (payment: Row, order: Row): boolean => chargedBeforeProviderTax(payment) === n(order.total) && str(payment.currency).toLowerCase() === str(order.currency).toLowerCase();
  const paidOf = (payment: Row): string => {
    const before = chargedBeforeProviderTax(payment), amount = n(payment.amount), currency = str(payment.currency);
    if (!Number.isFinite(before)) return `${amount} ${currency} with the provider's own tax (what it charged before that tax cannot be read)`;
    return before === amount ? `${amount} ${currency}` : `${before} ${currency} before the provider's own tax (${amount} ${currency} with it)`;
  };
  const owes = (order: Row): Row => ({ order: str(order.id), total: n(order.total), currency: str(order.currency) });

  /**
   * Whether a payments row is a subscription's money and not an order's. Commerce starts payment-mode checkouts only,
   * so a renewal is never for an order. The row says so when the provider linked it to a subscription
   * (`subscription`), and the object it keeps says so when the subscription's row was not there yet: a Stripe invoice
   * (`object`, `subscription`, `parent.subscription_details`), a Polar order of a subscription (`subscription_id`), a
   * Lemon Squeezy subscription invoice (`attributes.subscription_id`).
   *
   * It is kept because it keeps noise out: a subscription's payments are not even logged. It is no longer what protects
   * an order, and could not be, because it cannot see every subscription payment: a Stripe invoice's payment intent
   * carries no mark of the subscription, and its upsert replaces the invoice on the row they share. What protects an
   * order is that a payment that names no order never moves one (`onPayment`), and a subscription's names none.
   */
  const subscriptionMoney = (payment: Row): boolean => {
    const raw = obj(payment.raw);
    return !!str(payment.subscription) || raw.object === "invoice" || !!str(raw.subscription) || !!obj(raw.parent).subscription_details || !!str(raw.subscription_id) || !!str(obj(raw.attributes).subscription_id);
  };

  const subjectOf = (order: Row): string => `order:${str(order.id)}`;

  /**
   * The id of the audit row a step of a payment leaves, derived from what the step is: the order (or a note's subject),
   * the action, the payment, and the line or the status where the step has one. The same step asked for again derives
   * the same id, and `createOnce` finds its row rather than write a second. A `commerce_audit` id is what the id field
   * of every base collection takes, 15 characters of [a-z0-9], so it is the SHA-256 of the parts in base 36, cut to 15
   * (about 77 bits).
   */
  async function stepId(...parts: string[]): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|"))));
    return (digest.reduce((v, b) => (v << 8n) | BigInt(b), 0n) % 36n ** 15n).toString(36).padStart(15, "0");
  }

  /** an audit row written once: its id is its step's (`stepId`), and `alongside` lands with it or not at all */
  async function auditOnce(rows: CommerceRows, id: string, actor: string, action: string, subject: string, detail: Row, alongside?: Parameters<CommerceRows["createOnce"]>[2]): Promise<boolean> {
    return rows.createOnce("commerce_audit", { id, at: iso(), actor, action, subject, detail }, alongside);
  }

  /** a note about a payment, written once per payment and status however often the provider tells of it */
  async function noteOnce(rows: CommerceRows, actor: string, action: string, subject: string, detail: Row): Promise<void> {
    await auditOnce(rows, await stepId(subject, action, str(detail.payment), str(detail.status)), actor, action, subject, detail);
  }

  /**
   * The row a payment's move of an order leaves (`order.paid`, `order.payment_failed`), once per order, action and
   * payment. The move and its row are separate writes, and a watcher's error is the webhook's, so a provider's retry
   * finds the order moved and writes the row when it is missing; two tellings at once, or a telling that reads the order
   * between another request's claim and that request's row, write it once. Until 2026-09-11 the row was looked for in
   * the trail before it was written, which could not tell a row that failed from one another request was about to
   * write, and such news wrote a second row.
   */
  async function moveRow(rows: CommerceRows, actor: string, order: Row, action: "order.paid" | "order.payment_failed", detail: Row): Promise<void> {
    await auditOnce(rows, await stepId(str(order.id), action, str(detail.payment)), actor, action, subjectOf(order), detail);
  }

  /**
   * What an order's lines are at the provider: the ids its checkout may have named each line by, and how many. The id
   * stored on the line (`order_items.priceId`) is the one its checkout sent; a line written before that field existed
   * (0.9.0-beta.45 and earlier) has none, so the id its variant names it by now and the line's own `sku` stand in. All
   * of them are accepted, and any one matching is the line. They can disagree only where the shop has re-pointed the
   * variant since the order was placed, and then either may be what that checkout sent, so accepting each of them is
   * what keeps a paid order moving; falling back from one to the next, as this did until 2026-09-11, guessed one and
   * left an order placed before the field existed pending for good once its variant had moved on.
   */
  const orderedOf = (lines: Line[]): OrderedItem[] => lines.map((l) => {
    const ids = [...new Set([str(l.item.priceId), str(l.variant.priceId), str(l.item.sku)].filter(Boolean))];
    return { id: ids[0] ?? "", ids, quantity: l.quantity };
  });
  const itemsSaid = (items: { id: string; quantity?: number }[]): string =>
    items.map((i) => (i.quantity === undefined ? `"${i.id}"` : `${i.quantity} of "${i.id}"`)).join(" and ") || "nothing that could be read";
  /**
   * Whether the items a payment bought are the order's lines: every item bought is a line and every line is bought,
   * held to the id the checkout named the line by (any of `OrderedItem.ids`) always, and to the quantity only for an
   * item whose quantity the provider reported. The id is what closes the hole a reference a buyer can set opens, so it
   * is compared whatever else is missing; a quantity nobody reported cannot be compared with one, and a Lemon Squeezy
   * order carries none in the object its own docs print.
   */
  const boughtTheOrder = (bought: PurchasedItem[], ordered: OrderedItem[]): boolean => {
    if (bought.length !== ordered.length) return false;
    const left = [...ordered];
    for (const b of bought) {
      const i = left.findIndex((o) => o.ids.includes(b.id) && (b.quantity === undefined || b.quantity === o.quantity));
      if (i < 0) return false;
      left.splice(i, 1);
    }
    return true;
  };

  /**
   * Whether what a payment bought is what its order is, where the provider says what was bought (`purchasedItems`):
   * `why` is "" when it is, or when the provider does not say (Stripe, whose metadata no buyer can set), and otherwise
   * says what was bought against what was ordered, which the note is given as well (`bought`, `ordered`). Every item
   * bought has to be a line of the order and every line has to be bought (`boughtTheOrder`). Added 2026-09-11, because a
   * reference is a claim a buyer can make at Lemon Squeezy, whose checkout URLs take custom data: an order for another
   * variant at the same price, bought with the same email, named a pending order and paid it, and so did a subscription
   * variant's first order.
   */
  async function boughtElse(rows: CommerceRows, order: Row, payment: Row): Promise<{ why: string; note: Row }> {
    const bought = purchasedItems(payment);
    if (!bought) return { why: "", note: {} };
    const ordered = orderedOf(await linesOf(rows, "order_items", "order", str(order.id)));
    if (boughtTheOrder(bought, ordered)) return { why: "", note: {} };
    return { why: `bought ${itemsSaid(bought)}, where the order is ${itemsSaid(ordered)}`, note: { bought, ordered: ordered.map((o) => ({ id: o.id, quantity: o.quantity })) } };
  }

  /**
   * Move an order from one status to another for a payment only while it is still in the first (`updateWhere`). Stripe
   * tells of one payment twice at once, the session and its payment intent, and two requests that had both read the
   * order both moved it. A claim that changes nothing found the order moved since it was read. Moved to the status this
   * news gives it, with this same payment, it was moved by another request telling the same news, and this one goes on
   * to finish the move beside it, which repeats nothing, since every step of a move is written once. Moved anywhere
   * else, it was moved for another reason, and deciding again at once would decide against another request's writes
   * half done, so this request is the webhook's error (409): the provider retries, and the retry decides against the
   * order as it is by then.
   */
  async function claim(rows: CommerceRows, order: Row, from: OrderStatus, to: OrderStatus, payment: string): Promise<void> {
    const id = str(order.id);
    if (await rows.updateWhere("orders", id, { status: from }, { status: to, payment })) return;
    const now = await rows.find("orders", { id });
    if (str(now?.status) === to && str(now?.payment) === payment) return;
    throw new ApiError(409, `order "${id}" was ${now ? `${str(now.status) || "without a status"} with ${str(now.payment) ? `payment "${str(now.payment)}"` : "no payment"}` : "gone"} by the time payment "${payment}" came to make it ${to}; a retry decides again`);
  }

  /**
   * One line's stock moved for a payment's move of its order, with the row that records it, as one step (`createOnce`):
   * `stock.released` when a failure cancelled the order, `stock.reserved` when a success brought it back. Its id is the
   * order's, the action's, the payment's and the line's, so a retry finishes the lines the first attempt left and never
   * moves a line it moved, and two tellings at once move each line once. A line with no inventory row is untracked and
   * has no step. A reservation's row keeps what was available before it (`available`), which is what an
   * `order.oversold` note is written from, by a retry as well.
   *
   * The count is read and written back rather than added in SQL, so this step and a checkout of the same variant at the
   * same moment can lose one of the two updates: see what commerce does not do, in docs/plugins.md.
   */
  async function stockStep(rows: CommerceRows, actor: string, order: Row, action: "stock.released" | "stock.reserved", payment: string, line: Line): Promise<void> {
    const variant = str(line.item.variant), inv = await rows.find("inventory", { variant });
    if (!inv) return;
    const reserved = n(inv.reserved), releasing = action === "stock.released";
    const detail = { payment, line: str(line.item.id), variant, sku: str(line.item.sku), quantity: line.quantity, ...(releasing ? {} : { available: Math.max(0, n(inv.onHand) - reserved) }) };
    await auditOnce(rows, await stepId(str(order.id), action, payment, str(line.item.id)), actor, action, subjectOf(order), detail, [
      { collection: "inventory", id: str(inv.id), values: { reserved: releasing ? Math.max(0, reserved - line.quantity) : reserved + line.quantity } },
    ]);
  }

  /**
   * Reserve again, for the success that brought an order back, each line a failure released (the order's
   * `stock.released` rows), once each (`stockStep`), while the order is still paid by that success. Nothing but a
   * failure's move releases an order's line, so a line is reserved again only when its release is recorded: a failure
   * whose release never happened left that line reserved from checkout, and it is not reserved a second time.
   */
  async function reserveBack(rows: CommerceRows, actor: string, order: Row, payment: string): Promise<void> {
    const id = str(order.id), trail = await rows.list("commerce_audit", { subject: subjectOf(order) });
    const lineOf = (r: Row): string => str(obj(r.detail).line);
    const released = new Set(trail.filter((r) => str(r.action) === "stock.released").map(lineOf));
    if (!released.size) return;
    const now = await rows.find("orders", { id });
    if (str(now?.status) !== "paid" || str(now?.payment) !== payment) return;
    const reserved = new Set(trail.filter((r) => str(r.action) === "stock.reserved" && str(obj(r.detail).payment) === payment).map(lineOf));
    for (const l of await linesOf(rows, "order_items", "order", id)) {
      if (released.has(str(l.item.id)) && !reserved.has(str(l.item.id))) await stockStep(rows, actor, order, "stock.reserved", payment, l);
    }
  }

  /** the `order.oversold` note, once per order and payment, naming each line a success reserved above what was on hand */
  async function oversoldOnce(rows: CommerceRows, actor: string, order: Row, payment: string): Promise<void> {
    const subject = subjectOf(order);
    const short = (await rows.list("commerce_audit", { subject, action: "stock.reserved" })).map((r) => obj(r.detail)).filter((d) => str(d.payment) === payment && n(d.available) < n(d.quantity));
    if (!short.length) return;
    await auditOnce(rows, await stepId(str(order.id), "order.oversold", payment), actor, "order.oversold", subject, { payment, variants: short.map((d) => ({ variant: str(d.variant), sku: str(d.sku), quantity: n(d.quantity), available: n(d.available) })) });
  }

  /**
   * What a failure's move of an order leaves once the order is claimed (pending to cancelled, with this payment), each
   * step written once, so the provider's retry after any write failed finishes the rest and repeats nothing: each line's
   * stock released (`stock.released`) while the order is still cancelled by this payment, then the
   * `order.payment_failed` row.
   *
   * A success can bring the order back while its lines are being released (`revive`), and it reserves only the lines
   * whose release it finds recorded. So the order is read again once they are released, and when a success has brought
   * it back meanwhile, the lines released after that success looked are reserved for it here (`reserveBack`), as that
   * success's own steps, which happen once whichever request takes them.
   */
  async function failedMove(rows: CommerceRows, actor: string, order: Row, detail: Row): Promise<void> {
    const id = str(order.id), payment = str(detail.payment);
    const now = await rows.find("orders", { id });
    if (str(now?.status) === "cancelled" && str(now?.payment) === payment) {
      for (const l of await linesOf(rows, "order_items", "order", id)) await stockStep(rows, actor, order, "stock.released", payment, l);
      await finishRevive(rows, actor, order);
    }
    await moveRow(rows, actor, order, "order.payment_failed", detail);
  }

  /**
   * The steps a success that brought an order back may still be missing, because a failure released a line after that
   * success had looked: while the order is paid and carries a payment, every line whose release is recorded is reserved
   * again for that payment and an `order.oversold` note follows (`reserveBack`, `oversoldOnce`), as that success's own
   * steps, which happen once whichever request takes them (their ids are the step's).
   */
  async function finishRevive(rows: CommerceRows, actor: string, order: Row): Promise<void> {
    const after = await rows.find("orders", { id: str(order.id) });
    if (!after || str(after.status) !== "paid" || !str(after.payment)) return;
    await reserveBack(rows, actor, after, str(after.payment));
    await oversoldOnce(rows, actor, after, str(after.payment));
  }

  /**
   * A failure told again after a success brought back the order it had cancelled: the same news as before, so it writes
   * its own `order.payment_failed` row when that is missing, and then finishes what the success left (`finishRevive`).
   * Without that last step an interrupted failure ended the order paid with a line released: its release threw part-way,
   * the success had already reserved back only the releases it found recorded, and the retold failure wrote its row and
   * stopped. Both paths that retell a failure (`onPayment`'s early branch and `movedBy`'s) end here for that reason.
   */
  async function retoldFailure(rows: CommerceRows, actor: string, order: Row, detail: Row): Promise<void> {
    await moveRow(rows, actor, order, "order.payment_failed", detail);
    await finishRevive(rows, actor, order);
  }

  /**
   * What a success's move of an order leaves once the order is claimed (pending or cancelled to paid, with this payment),
   * each step written once, so a retry finishes the rest: when a failure had cancelled the order and released its lines,
   * those lines reserved again (`reserveBack`); the `order.paid` row, which for such an order says `revived` and which
   * payment's failure had cancelled it (`cancelledBy`); and an `order.oversold` note when a line's stock went to somebody
   * else meanwhile. `cancelledBy` is "" for an order that was pending, and left out by a retry, which reads it off the
   * failure's rows. Until 2026-09-11 a revive wrote its row before it reserved, and a retry wrote only a missing row,
   * which left a revived order's stock unreserved behind a row that said it was paid.
   */
  async function paidMove(rows: CommerceRows, actor: string, order: Row, detail: Row, cancelledBy?: string): Promise<void> {
    const payment = str(detail.payment);
    await reserveBack(rows, actor, order, payment);
    let by = cancelledBy ?? "";
    if (cancelledBy === undefined) {
      const trail = await rows.list("commerce_audit", { subject: subjectOf(order) });
      const failure = (action: string): string => str(obj(trail.find((r) => str(r.action) === action)?.detail).payment);
      by = failure("stock.released") || failure("order.payment_failed");
    }
    await moveRow(rows, actor, order, "order.paid", { ...detail, ...(by ? { revived: true, cancelledBy: by } : {}) });
    if (by) await oversoldOnce(rows, actor, order, payment);
  }

  /**
   * A cancelled order paid after all (`whyNotRevived` says when): claimed from cancelled to paid with this payment, then
   * the success's steps (`paidMove`), its lines reserved again among them. The money is captured whether the stock is
   * still there or not, so a line whose stock went to somebody else in the meantime is reserved all the same, which
   * leaves the reservation above what is on hand and stops the variant selling, and an `order.oversold` note names
   * every line short so that a person decides what happens to it.
   */
  async function revive(rows: CommerceRows, actor: string, order: Row, detail: Row): Promise<void> {
    const cancelledBy = str(order.payment);
    await claim(rows, order, "cancelled", "paid", str(detail.payment));
    await paidMove(rows, actor, order, detail, cancelledBy);
  }

  /**
   * Whether a failed payment is what cancelled an order that a success has since brought back: a line it released is
   * recorded, or the revived order's `order.paid` row names it (`cancelledBy`). The failure's own row can be missing, when
   * its write failed and the success came before the provider's retry; that retry is the same news again, so it writes
   * the row rather than note a contradiction.
   */
  async function cancelledBefore(rows: CommerceRows, order: Row, payment: string): Promise<boolean> {
    return (await rows.list("commerce_audit", { subject: subjectOf(order) })).some((r) => {
      const d = obj(r.detail);
      return (str(r.action) === "stock.released" && str(d.payment) === payment) || (str(r.action) === "order.paid" && str(d.cancelledBy) === payment);
    });
  }

  /**
   * The order a payment names, when the payment moves it, or none, and then why not, what that order owed, and what was
   * bought against what was ordered when that is why. It runs only for a payment that names an order (the reference
   * checkout handed to `payments@1`, which the provider carries back on the object it sends, `paymentReference`) and
   * that no order carries.
   *
   * The order named is that payment's or nobody's: Stripe tells of one payment twice, the session and then its payment
   * intent, and the second telling must not pay another order of the same total; and a name that points at somebody
   * else's order is no reason to pick one of the payer's instead. So the order has to exist, be the payer's (the same
   * `customers` row) and be pending, or, for a success, be cancelled by a failed payment that this one can mend
   * (`whyNotRevived`, and `revive` says so). A success has to be the order's total in its currency as well (`pays`), and
   * to have bought what the order is where the provider says what was bought (`boughtElse`), because the name is a claim
   * and not proof: any plugin calling `payments@1` can set a reference, a Lemon Squeezy buyer can set one in a checkout
   * URL, a variant's price id can cost something else at the provider than its `price` here, and a provider can report
   * less than the total.
   *
   * A failure needs no amount or currency: it moves no money, so it cancels the order it names whatever it cost, rather
   * than leave that order's stock reserved for good. It is held to what it bought all the same, and for the same reason
   * the success is: where a buyer can set the reference, a declined one-cent purchase of any variant would otherwise
   * cancel somebody's pending order and release its stock. Where the provider reports no purchase there is nothing to
   * check and nothing to abuse either, because the reference is not a buyer's to set there (Stripe's metadata is set
   * with the secret key alone), so a decline that names the order still cancels it.
   */
  async function orderForPayment(rows: CommerceRows, payment: Row, reference: string, named: Row | null): Promise<{ order: Row | null; revive: boolean; unmatched: string; owed: Row[]; note: Row }> {
    const customer = str(payment.customer), failed = str(payment.status) === "failed";
    const status = str(named?.status), revive = !failed && status === "cancelled";
    const judged = await (async (): Promise<{ why: string; note: Row }> => {
      if (!named) return { why: `it names order "${reference}", which does not exist`, note: {} };
      if (!customer || str(named.customer) !== customer) return { why: `it names order "${reference}", which is another customer's`, note: {} };
      if (revive) return whyNotRevived(rows, named, payment, reference);
      if (status !== "pending") return { why: `it names order "${reference}", which is ${status} and not pending`, note: {} };
      if (failed) {
        // no amount to match, since a decline moves no money, but the same bought check: see above
        const f = await boughtElse(rows, named, payment);
        return { why: f.why ? `it names order "${reference}" and ${f.why}` : "", note: f.note };
      }
      if (!pays(payment, named)) return { why: `it names order "${reference}" and pays ${paidOf(payment)}, where the order's total is ${n(named.total)} ${str(named.currency)}`, note: {} };
      const b = await boughtElse(rows, named, payment);
      return { why: b.why ? `it names order "${reference}" and ${b.why}` : "", note: b.note };
    })();
    return { order: judged.why ? null : named, revive, unmatched: judged.why, owed: judged.why && named ? [owes(named)] : [], note: judged.note };
  }

  /**
   * Why a succeeded payment cannot bring back a cancelled order it names, or "" when it can. Stripe Checkout lets a
   * buyer try again on the same session after a decline, so the payment intent whose failure cancelled the order and
   * released its stock can succeed a minute later, and the money is then captured for an order that is gone. The
   * failure need not be this payment's: a failure cancels the pending order it names whatever it was for, so a
   * `payments@1` caller's own checkout that names the order and is declined cancels it, and the order's own payment
   * then succeeds. So the order comes back when the payment names that order (one that names none never gets this far),
   * when a failed payment cancelled it, when it pays the order's total in its currency before the provider's own tax,
   * which a failure did not have to, and when it bought what the order is, where the provider says (`boughtElse`).
   *
   * The witness that a failed payment cancelled it is the order row, not the audit trail: a cancelled order that carries
   * a payment was cancelled by that payment's failure. In this file only a failure's claim (pending to cancelled, in
   * `onPayment`) writes `payment` onto an order it cancels; the checkout route cancels an order the provider refused
   * (`order.checkout_failed`) before any payment exists, and writes none; and nothing moves a cancelled order but a
   * revive. The failure's `order.payment_failed` row lands after its claim, so until 2026-09-11 a success read in between
   * found `order.placed` as the last move, noted a contradiction, answered 200, and was never retried, and a fully paid
   * order stayed cancelled. A superuser who cancels a paid order by hand, through the records API, leaves its `payment`
   * on it, and a success told again would then bring it back.
   */
  async function whyNotRevived(rows: CommerceRows, order: Row, payment: Row, reference: string): Promise<{ why: string; note: Row }> {
    const id = str(order.id);
    const was = str(order.payment) === str(payment.id) ? `it cancelled order "${id}" when it failed` : `it names order "${id}", which is cancelled`;
    if (reference !== id) return { why: `${was}, and now ${reference ? `names order "${reference}"` : "names no order"}`, note: {} };
    if (!str(order.payment)) return { why: `${was} and carries no payment, so no failed payment cancelled it: a refused checkout (order.checkout_failed) cancels an order before it has one`, note: {} };
    if (!pays(payment, order)) return { why: `${was}, and pays ${paidOf(payment)}, where the order's total is ${n(order.total)} ${str(order.currency)}`, note: {} };
    const b = await boughtElse(rows, order, payment);
    return { why: b.why ? `${was}, and ${b.why}` : "", note: b.note };
  }

  /**
   * What news of a payment does to the order that payment has moved (the order's `payment` is its id). A payment that
   * has moved an order is that order's for good and never looks for another: matching it again is how a failure told
   * after the success of the same payment intent cancelled a second pending order of the same total and released its
   * stock. The same news again (a replay, Stripe's session after its payment intent, the provider's retry after a write
   * failed) finishes the move, which writes only what was not written yet (`failedMove`, `paidMove`). News that
   * contradicts it leaves the orders alone and is said once, but for two cases: a success after the failure that
   * cancelled the order, which brings the order back (`revive`), and a failure told again after a success brought its
   * order back, which is the same news as before and writes its own row if that is missing (`cancelledBefore`).
   */
  async function movedBy(rows: CommerceRows, actor: string, payment: Row, order: Row, detail: Row, reference: string): Promise<void> {
    const status = str(payment.status), cancelled = str(order.status) === "cancelled";
    if (status === "failed" && cancelled) return failedMove(rows, actor, order, detail);
    if (status === "succeeded" && !cancelled) return paidMove(rows, actor, order, detail);
    const contradicted = async (why: string, note: Row): Promise<void> => {
      logger.info("voidbase: commerce heard a payment contradict the order it moved and left the orders alone", { ...detail, status, reason: why });
      await noteOnce(rows, actor, "order.payment_contradicted", subjectOf(order), { ...detail, status, customer: str(payment.customer), orderStatus: str(order.status), ...note, reason: why });
    };
    if (status === "failed") {
      if (await cancelledBefore(rows, order, str(payment.id))) return retoldFailure(rows, actor, order, detail);
      return contradicted(`it paid order "${str(order.id)}", which is ${str(order.status)}, and now says it failed`, {});
    }
    const { why, note } = await whyNotRevived(rows, order, payment, reference);
    return why ? contradicted(why, note) : revive(rows, actor, order, detail);
  }

  async function onPayment(e: PaymentWritten): Promise<void> {
    if (!commerceOn(e.env) || !e.payment) return;
    const status = str(e.payment.status);
    if (status !== "succeeded" && status !== "failed") return;
    // a subscription's money says nothing about an order, so it is not even logged: this keeps noise out, and it is
    // not what protects an order (see `subscriptionMoney`); the next check is
    if (subscriptionMoney(e.payment)) return;
    const payment = str(e.payment.id), reference = paymentReference(e.payment.raw), actor = `payments:${e.provider}`;
    const amount = n(e.payment.amount), before = chargedBeforeProviderTax(e.payment);
    const told = { provider: e.provider, payment, amount, currency: str(e.payment.currency), ...(before !== amount ? { beforeProviderTax: Number.isFinite(before) ? before : null } : {}) };

    // A payment that names no order never pays, cancels or revives one, and is a log line and not an audit row.
    // Commerce gives every checkout its order's id as the reference, at all three providers, so money that names no
    // order is not a commerce checkout's: a subscription invoice's payment intent, which carries neither metadata nor
    // a mark of its subscription and whose upsert can replace the invoice on the row they share; a Lemon Squeezy
    // subscription's first order; a purchase through a provider's own checkout route. Matched on the customer and the
    // amount, as they were until 2026-09-11, any of them could mark a pending order of the same total paid, a failed
    // one could cancel it, and a retry could revive it.
    if (!reference) {
      logger.info("voidbase: commerce saw a payment that names no order and left the orders alone", { ...told, status, customer: str(e.payment.customer) });
      return;
    }
    const rows = deps.rows(e.env, e.realtime);
    const detail = { ...told, reference };

    // The order this payment has moved is its own for good (`movedBy`). The order it names is read too, and carries this
    // payment when another request moved it with this payment since the first read (Stripe's session and its payment
    // intent told at once).
    const moved = await rows.find("orders", { payment });
    if (moved) return movedBy(rows, actor, e.payment, moved, detail, reference);
    const named = await rows.find("orders", { id: reference });
    if (named && str(named.payment) === payment) return movedBy(rows, actor, e.payment, named, detail, reference);
    // a failure told again after another payment brought back the order it had cancelled: the same news, and its row is
    // written if it is missing
    if (status === "failed" && named && str(named.status) !== "pending" && (await cancelledBefore(rows, named, payment))) return retoldFailure(rows, actor, named, detail);

    const { order, revive: mends, unmatched, owed, note } = await orderForPayment(rows, e.payment, reference, named);
    if (!order) {
      // the orders are left alone and the payment is said out loud: money that names an order and moves none is what a
      // superuser has to look at, so it is an audit row, once per payment and status, saying what was paid (`amount`,
      // `currency`, and `beforeProviderTax` where the provider added tax of its own) against what was owed (`owed`), and
      // what was bought against what was ordered (`bought`, `ordered`) when that is why, as well as a log line
      logger.info("voidbase: commerce matched a payment to no order and left the orders alone", { ...detail, status, reason: unmatched });
      await noteOnce(rows, actor, "order.payment_unmatched", `order:${reference}`, { ...detail, status, customer: str(e.payment.customer), owed, ...note, reason: unmatched });
      return;
    }
    if (mends) return revive(rows, actor, order, detail);
    if (status === "succeeded") {
      await claim(rows, order, "pending", "paid", payment);
      return paidMove(rows, actor, order, detail, "");
    }
    // A failure claims the order before it releases a line, and each release is a step written once (`failedMove`), so a
    // retry after any write failed finishes what the first attempt left and releases no line twice. Released before the
    // claim, a failure to mark the order had the retry release every line a second time, and a release stops at 0, so
    // the second one freed reservations other pending orders of the same variant held; claimed first without steps, a
    // failure after the claim left the stock reserved for a cancelled order, which a revive then reserved again.
    await claim(rows, order, "pending", "cancelled", payment);
    await failedMove(rows, actor, order, detail);
  }

  // --- the routes ---------------------------------------------------------------------------------------------
  const readBody = async (c: Context<AppEnv>): Promise<Row> => {
    if (!c.req.header("content-type")?.includes("json")) return {};
    try { return obj(await c.req.json()); } catch { throw badRequest("the body must be a JSON object"); }
  };
  const rowsFor = (c: Context<AppEnv>) => deps.rows(c.env, c.get("realtime"));

  /** the variant a route was asked for, which has to exist and be for sale */
  async function variantOf(rows: CommerceRows, id: string): Promise<Row> {
    const variant = id ? await rows.find("variants", { id }) : null;
    if (!variant) throw notFound(`no variant "${id}"`);
    if (variant.active === false) throw badRequest(`the variant "${id}" is not for sale`);
    return variant;
  }

  /** refuse a quantity the stock cannot cover, naming what is left */
  async function checkStock(rows: CommerceRows, variant: Row, wanted: number): Promise<void> {
    const left = await available(rows, str(variant.id));
    if (left !== null && wanted > left) throw new ApiError(409, `only ${left} of ${str(variant.sku) || str(variant.id)} ${left === 1 ? "is" : "are"} available and ${wanted} ${wanted === 1 ? "was" : "were"} asked for`);
  }

  /** the cart item a route names, which has to be in the caller's own cart */
  async function itemOf(rows: CommerceRows, c: Context<AppEnv>, body: Row): Promise<{ cart: Row; item: Row }> {
    const cart = await cartOf(rows, c, { create: false, body });
    if (!cart) throw notFound("no open cart");
    const item = await rows.find("cart_items", { id: c.req.param("id") ?? "" });
    if (!item || str(item.cart) !== str(cart.id)) throw notFound(`no item "${c.req.param("id")}" in this cart`);
    return { cart, item };
  }

  /** what this cart owes right now: the lines, the tax and the shipping rates, each asked of its own interface */
  async function quote(c: Context<AppEnv>, rows: CommerceRows, cart: Row, lines: Line[]): Promise<{ address: QuoteAddress; subtotal: number; tax: { lines: { label: string; amount: number }[]; total: number }; rates: ShippingRate[] }> {
    const address = addressOf(cart.address);
    const items = quoteItems(lines);
    const auth = c.get("auth");
    const customer = auth ? str((await rows.customers(str(auth.row.id)))[0]?.id) : "";
    const tax = await need<Tax>("tax@1").quote(c.env, { items, to: address, ...(customer ? { customer } : {}) });
    const rates = await need<Shipping>("shipping@1").rates(c.env, { items, to: address });
    return { address, subtotal: subtotalOf(lines), tax, rates };
  }

  /** the order a superuser route names */
  async function orderOf(rows: CommerceRows, id: string): Promise<Row> {
    const order = id ? await rows.find("orders", { id }) : null;
    if (!order) throw notFound(`no order "${id}"`);
    return order;
  }

  function mountRoutes(app: Kernel["app"]) {
    const cartRoute = async (c: Context<AppEnv>) => {
      mustBeOn(c.env);
      const rows = rowsFor(c);
      const body = c.req.method === "POST" ? await readBody(c) : {};
      const cart = (await cartOf(rows, c, { create: true, body }))!;
      return c.json(cartView(cart, await linesOf(rows, "cart_items", "cart", str(cart.id))));
    };
    app.get(`${API}/cart`, cartRoute);
    app.post(`${API}/cart`, cartRoute);

    app.post(`${API}/cart/items`, async (c) => {
      mustBeOn(c.env);
      const body = await readBody(c);
      const rows = rowsFor(c);
      const quantity = positiveInt(body.quantity, 1);
      if (!Number.isFinite(quantity)) throw badRequest("quantity must be a positive whole number");
      const variant = await variantOf(rows, str(body.variant));
      const cart = (await cartOf(rows, c, { create: true, body }))!;
      const existing = await rows.find("cart_items", { cart: str(cart.id), variant: str(variant.id) });
      const wanted = n(existing?.quantity) + quantity;
      await checkStock(rows, variant, wanted);
      const item = existing
        ? await rows.update("cart_items", str(existing.id), { quantity: wanted })
        : await rows.create("cart_items", { cart: str(cart.id), variant: str(variant.id), quantity, unitPrice: n(variant.price) });
      await audit(rows, actorOf(c.get("auth")), existing ? "cart.item.changed" : "cart.item.added", `cart:${str(cart.id)}`, { item: str(item.id), variant: str(variant.id), quantity: wanted });
      return c.json(cartView(cart, await linesOf(rows, "cart_items", "cart", str(cart.id))));
    });

    app.patch(`${API}/cart/items/:id`, async (c) => {
      mustBeOn(c.env);
      const body = await readBody(c);
      const rows = rowsFor(c);
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity < 0) throw badRequest("quantity must be a whole number, 0 to take the line away");
      const { cart, item } = await itemOf(rows, c, body);
      if (quantity === 0) {
        await rows.remove("cart_items", str(item.id));
        await audit(rows, actorOf(c.get("auth")), "cart.item.removed", `cart:${str(cart.id)}`, { item: str(item.id), variant: str(item.variant) });
      } else {
        await checkStock(rows, await variantOf(rows, str(item.variant)), quantity);
        await rows.update("cart_items", str(item.id), { quantity });
        await audit(rows, actorOf(c.get("auth")), "cart.item.changed", `cart:${str(cart.id)}`, { item: str(item.id), variant: str(item.variant), quantity });
      }
      return c.json(cartView(cart, await linesOf(rows, "cart_items", "cart", str(cart.id))));
    });

    app.delete(`${API}/cart/items/:id`, async (c) => {
      mustBeOn(c.env);
      const rows = rowsFor(c);
      const { cart, item } = await itemOf(rows, c, {});
      await rows.remove("cart_items", str(item.id));
      await audit(rows, actorOf(c.get("auth")), "cart.item.removed", `cart:${str(cart.id)}`, { item: str(item.id), variant: str(item.variant) });
      return c.json(cartView(cart, await linesOf(rows, "cart_items", "cart", str(cart.id))));
    });

    app.post(`${API}/cart/address`, async (c) => {
      mustBeOn(c.env);
      const body = await readBody(c);
      const rows = rowsFor(c);
      const address = addressOf(body.address ?? body);
      if (!hasAddress(address)) throw badRequest("address must say where the order is going: line1, city, postcode, country");
      const found = await cartOf(rows, c, { create: false, body });
      if (!found) throw notFound("no open cart");
      const cart = await rows.update("carts", str(found.id), { address });
      const lines = await linesOf(rows, "cart_items", "cart", str(cart.id));
      const q = await quote(c, rows, cart, lines);
      await audit(rows, actorOf(c.get("auth")), "cart.address.set", `cart:${str(cart.id)}`, { address, tax: q.tax.total, rates: q.rates.length });
      return c.json({ cart: str(cart.id), currency: str(cart.currency), address: q.address, subtotal: q.subtotal, tax: q.tax, shipping: q.rates });
    });

    app.post(`${API}/checkout`, async (c) => {
      const auth = requireAuth(c);
      mustBeOn(c.env);
      const body = await readBody(c);
      const success = str(body.success), cancelUrl = str(body.cancel);
      if (!success) throw badRequest("success must be the URL to return to");
      const rows = rowsFor(c);
      const cart = await cartOf(rows, c, { create: false, body });
      if (!cart) throw notFound("no open cart");
      const lines = await linesOf(rows, "cart_items", "cart", str(cart.id));
      if (!lines.length) throw badRequest("the cart is empty");
      if (!hasAddress(addressOf(cart.address))) throw badRequest(`POST ${API}/cart/address first: tax and shipping are quoted against a destination`);
      for (const l of lines) {
        if (!str(l.variant.sku) && !str(l.variant.priceId)) throw badRequest(`the variant "${str(l.item.variant)}" is gone; take it out of the cart`);
        await checkStock(rows, l.variant, l.quantity);
      }
      const q = await quote(c, rows, cart, lines);
      const chosen = str(body.shipping) ? q.rates.find((r) => r.id === str(body.shipping)) : q.rates[0];
      if (str(body.shipping) && !chosen) throw badRequest(`"${str(body.shipping)}" is not one of the shipping rates for this address`);
      const shipping = chosen?.amount ?? 0;
      const total = q.subtotal + q.tax.total + shipping;
      const currency = str(cart.currency);

      // what the provider is asked to charge adds up to the order's total: the variants at the provider's own
      // prices, and the tax and the shipping as amounts of their own, because there is no price id for a sum
      // computed a second ago, and leaving them out is how an order of 5900 was charged 4500 on the demo (2026-09-11)
      const amounts = [
        ...(q.tax.total ? [{ name: q.tax.lines.map((l) => l.label).filter(Boolean).join(", ") || "Tax", amount: q.tax.total, currency }] : []),
        ...(shipping ? [{ name: str(chosen?.label) || "Shipping", amount: shipping, currency }] : []),
      ];
      // and in the cart's currency, which Polar would otherwise replace with the buyer's own where the product has a
      // price in it, leaving a payment in a currency the order is not in
      const charge: CheckoutRequest = {
        items: lines.map((l) => ({ price: str(l.variant.priceId) || str(l.variant.sku), quantity: l.quantity })),
        ...(amounts.length ? { amounts } : {}), ...(currency ? { currency } : {}), success, ...(cancelUrl ? { cancel: cancelUrl } : {}), mode: "payment",
      };

      // a provider that cannot charge all of that refuses before anything has happened: no customer at the
      // provider, no order, no reservation. It is asked about a checkout for an order, because that is what this will
      // be, and a provider refuses more of one (Polar a second product, which its own route lists for a buyer to pick
      // from). The reference is the order's id, and there is no order yet: no provider reads a reference's value to
      // decide, so the cart's id stands in for it. Then the customers row, the one step that may call the provider,
      // and nothing here has happened yet if it fails
      const payments = need<Payments>("payments@1");
      payments.checkCheckout?.(c.env, { ...charge, reference: `cart:${str(cart.id)}` });
      const customer = await payments.customer(c.env, auth);
      for (const l of lines) await reserve(rows, str(l.variant.id), l.quantity);
      const order = await rows.create("orders", {
        number: deps.number(), customer, user: str(auth.row.id), email: str(auth.row.email), status: "pending", currency: str(cart.currency),
        subtotal: q.subtotal, tax: q.tax.total, shipping, total, address: q.address, placedAt: iso(),
      });
      for (const l of lines) {
        await rows.create("order_items", { order: str(order.id), variant: str(l.variant.id), sku: str(l.variant.sku), title: str(l.variant.title), quantity: l.quantity, unitPrice: l.unitPrice, total: lineTotal(l), priceId: str(l.variant.priceId) || str(l.variant.sku) });
      }
      await rows.update("carts", str(cart.id), { status: "ordered" });
      await audit(rows, actorOf(auth), "order.placed", `order:${str(order.id)}`, { cart: str(cart.id), number: str(order.number), total, tax: q.tax.total, shipping, lines: lines.length });

      try {
        // the order's id travels as the reference, so the payment that comes back names the order it pays
        const { url } = await payments.checkout(c.env, { ...charge, customer, reference: str(order.id) });
        return c.json({ order: orderView(order), url });
      } catch (e) {
        // the provider refused: the order never existed as far as the customer is concerned, and the stock goes back
        for (const l of lines) await release(rows, str(l.variant.id), l.quantity);
        await rows.update("orders", str(order.id), { status: "cancelled" });
        await audit(rows, actorOf(auth), "order.checkout_failed", `order:${str(order.id)}`, { error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    });

    app.post(`${API}/orders/:id/fulfil`, async (c) => {
      const auth = requireSuperuser(c);
      mustBeOn(c.env);
      const body = await readBody(c);
      const rows = rowsFor(c);
      const order = await orderOf(rows, c.req.param("id"));
      if (str(order.status) !== "paid") throw new ApiError(409, `an order is fulfilled once it is paid, and this one is ${str(order.status)}`);
      const lines = await linesOf(rows, "order_items", "order", str(order.id));
      const items = lines.map((l) => ({ variant: str(l.item.variant), sku: str(l.item.sku), title: str(l.item.title), quantity: l.quantity }));
      for (const l of lines) await ship(rows, str(l.item.variant), l.quantity);
      const shipment = await rows.create("shipments", { order: str(order.id), carrier: str(body.carrier), tracking: str(body.tracking), shippedAt: iso(), items });
      const updated = await rows.update("orders", str(order.id), { status: "fulfilled" });
      await audit(rows, actorOf(auth), "order.fulfilled", `order:${str(order.id)}`, { shipment: str(shipment.id), carrier: str(body.carrier), tracking: str(body.tracking), items: items.length });
      return c.json({ order: orderView(updated), shipment: { id: str(shipment.id), carrier: str(shipment.carrier), tracking: str(shipment.tracking), shippedAt: str(shipment.shippedAt), items } });
    });

    app.post(`${API}/orders/:id/refund`, async (c) => {
      const auth = requireSuperuser(c);
      mustBeOn(c.env);
      const body = await readBody(c);
      const rows = rowsFor(c);
      const order = await orderOf(rows, c.req.param("id"));
      if (str(order.status) !== "paid" && str(order.status) !== "fulfilled") throw new ApiError(409, `an order is refunded once it is paid, and this one is ${str(order.status)}`);
      const amount = body.amount === undefined ? n(order.total) : n(body.amount);
      if (amount <= 0 || amount > n(order.total)) throw badRequest(`amount must be between 1 and the order's total of ${n(order.total)}`);
      const reason = str(body.reason);
      // the provider gives the money back when its plugin offers that; when it does not, the refund is recorded
      // here and given back from the provider's own dashboard, which is what the optional method on the
      // interface exists to say out loud
      const payments = need<Payments>("payments@1");
      let providerId = "";
      if (payments.refund && str(order.payment)) {
        providerId = str((await payments.refund(c.env, { payment: str(order.payment), amount, ...(reason ? { reason } : {}) })).providerId);
      }
      const refund = await rows.create("refunds", { order: str(order.id), amount, reason, providerId, refundedAt: iso() });
      const updated = await rows.update("orders", str(order.id), { status: "refunded" });
      await audit(rows, actorOf(auth), "order.refunded", `order:${str(order.id)}`, { refund: str(refund.id), amount, reason, providerId, atProvider: !!providerId });
      return c.json({ order: orderView(updated), refund: { id: str(refund.id), amount, reason, providerId, refundedAt: str(refund.refundedAt) } });
    });

    app.get(`${API}/orders`, async (c) => {
      const auth = requireAuth(c);
      mustBeOn(c.env);
      const rows = rowsFor(c);
      const mine: Row[] = [];
      for (const customer of await rows.customers(str(auth.row.id))) mine.push(...(await rows.list("orders", { customer: str(customer.id) })));
      return c.json({ items: mine.map((o) => orderView(o)) });
    });

    app.get(`${API}/orders/:id`, async (c) => {
      const auth = requireAuth(c);
      mustBeOn(c.env);
      const rows = rowsFor(c);
      const order = await orderOf(rows, c.req.param("id"));
      if (!isSuperuser(auth)) {
        const mine = (await rows.customers(str(auth.row.id))).map((r) => str(r.id));
        if (!mine.includes(str(order.customer))) throw forbidden("this order belongs to somebody else");
      }
      const lines = await linesOf(rows, "order_items", "order", str(order.id));
      const shipments = await rows.list("shipments", { order: str(order.id) });
      const refunds = await rows.list("refunds", { order: str(order.id) });
      return c.json({
        ...orderView(order, lines),
        shipments: shipments.map((s) => ({ id: str(s.id), carrier: str(s.carrier), tracking: str(s.tracking), shippedAt: str(s.shippedAt), items: s.items ?? [] })),
        refunds: refunds.map((r) => ({ id: str(r.id), amount: n(r.amount), reason: str(r.reason), providerId: str(r.providerId), refundedAt: str(r.refundedAt) })),
      });
    });
  }

  let stop: (() => void) | undefined;
  Object.assign(plugin, {
    manifest: {
      name: "commerce", version: "0.1.0", tier: "official" as const, voidbase: "*",
      requires: ["payments@1" as const, "tax@1" as const, "shipping@1" as const],
      collections: [...COMMERCE_COLLECTIONS],
    },
    info: (env: Bindings) => commerceInfo(env),
    stopWatchingPayments: () => { stop?.(); stop = undefined; },
    apply(kernel: Kernel) {
      ctx = kernel;
      onBootstrap(kernel, async (env) => {
        if (!commerceOn(env)) return;
        await ensureCollections(plugin, env.DB, await collectionDefinitions(env.DB));
      });
      stop?.();
      stop = onPaymentWritten(kernel.app, onPayment);
      mountRoutes(kernel.app);
    },
  });
  return plugin;
}

/** what `/api/plugins` says about it: whether the shop is on and what a new cart is priced in */
export const commerceInfo = (env?: object): { on: boolean; currency: string } => ({ on: commerceOn(env), currency: defaultCurrency(env) });

/** the shipped plugin: the rows in D1, the real clock, random tokens and order numbers */
export const commerce: Plugin & { stopWatchingPayments: () => void } = commerceWith();
