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
//     line items to `payments@1` and answers the URL it gets back. It does not verify a signature, own a webhook
//     path or know what a Stripe price is.
//   - Learning that an order was paid therefore cannot be a route of ours. The seam is `onPaymentWritten` in
//     payments-shared.ts, added with this plugin because none existed: the shared webhook path calls its watchers
//     once a provider has verified an event and upserted its `payments` row, and this plugin's watcher moves the
//     matching order. A watcher's error is the webhook's error, so a provider retries and the move is idempotent.
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
import type { Payments, QuoteAddress, QuoteItem, RealtimeClient, Shipping, ShippingRate, Tax } from "../interfaces";
import { onBootstrap, using, type Kernel } from "../kernel";
import { createRecord, deleteRecord, updateRecord, type RecordContext } from "../records/service";
import { rowToValues } from "../records/values";
import type { AppEnv, AuthRecord, Bindings, Row } from "../types";
import { ensureCollections } from "./collections";
import type { Plugin } from "./manifest";
import { obj, onPaymentWritten, str, type PaymentWritten } from "./payments-shared";
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
  const users = (await findCollection(db, "users"))?.id ?? collectionId("auth", "users");
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
        { name: "user", type: "relation", collectionId: users, maxSelect: 1, cascadeDelete: true },
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
        { name: "user", type: "relation", collectionId: users, maxSelect: 1, cascadeDelete: false },
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
   * The pending order a payments row belongs to: the same customer, and the same money where it can be told
   * apart, oldest first. A customer has one pending order at a time in every shop that takes one payment per
   * order, and matching on the amount and currency first is what keeps two of them from being crossed.
   */
  async function orderForPayment(rows: CommerceRows, payment: Row): Promise<Row | null> {
    const customer = str(payment.customer);
    if (!customer) return null;
    const pending = await rows.list("orders", { customer, status: "pending" });
    if (!pending.length) return null;
    return pending.find((o) => n(o.total) === n(payment.amount) && str(o.currency) === str(payment.currency)) ?? pending[0]!;
  }

  async function onPayment(e: PaymentWritten): Promise<void> {
    if (!commerceOn(e.env) || !e.payment) return;
    const status = str(e.payment.status);
    if (status !== "succeeded" && status !== "failed") return;
    const rows = deps.rows(e.env, e.realtime);
    const order = await orderForPayment(rows, e.payment);
    if (!order) {
      logger.info("voidbase: commerce saw a payment with no pending order of its own", { provider: e.provider, payment: str(e.payment.id), status });
      return;
    }
    const subject = `order:${str(order.id)}`;
    const detail = { provider: e.provider, payment: str(e.payment.id), amount: n(e.payment.amount), currency: str(e.payment.currency) };
    if (status === "succeeded") {
      await rows.update("orders", str(order.id), { status: "paid", payment: str(e.payment.id) });
      await audit(rows, `payments:${e.provider}`, "order.paid", subject, detail);
      return;
    }
    for (const l of await linesOf(rows, "order_items", "order", str(order.id))) await release(rows, str(l.item.variant), l.quantity);
    await rows.update("orders", str(order.id), { status: "cancelled", payment: str(e.payment.id) });
    await audit(rows, `payments:${e.provider}`, "order.payment_failed", subject, detail);
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

      // the customers row comes first: it is the one step that may call the provider, and nothing here has
      // happened yet if it fails
      const payments = need<Payments>("payments@1");
      const customer = await payments.customer(c.env, auth);
      for (const l of lines) await reserve(rows, str(l.variant.id), l.quantity);
      const order = await rows.create("orders", {
        number: deps.number(), customer, user: str(auth.row.id), email: str(auth.row.email), status: "pending", currency: str(cart.currency),
        subtotal: q.subtotal, tax: q.tax.total, shipping, total, address: q.address, placedAt: iso(),
      });
      for (const l of lines) {
        await rows.create("order_items", { order: str(order.id), variant: str(l.variant.id), sku: str(l.variant.sku), title: str(l.variant.title), quantity: l.quantity, unitPrice: l.unitPrice, total: lineTotal(l) });
      }
      await rows.update("carts", str(cart.id), { status: "ordered" });
      await audit(rows, actorOf(auth), "order.placed", `order:${str(order.id)}`, { cart: str(cart.id), number: str(order.number), total, tax: q.tax.total, shipping, lines: lines.length });

      try {
        const { url } = await payments.checkout(c.env, {
          customer, items: lines.map((l) => ({ price: str(l.variant.priceId) || str(l.variant.sku), quantity: l.quantity })),
          success, ...(cancelUrl ? { cancel: cancelUrl } : {}), mode: "payment",
        });
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
