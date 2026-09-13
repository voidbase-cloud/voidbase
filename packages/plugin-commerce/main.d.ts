import type { QuoteAddress, RealtimeClient } from "@voidbase-cloud/voidbase/interfaces";
import type { Bindings, Row } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
export declare const API = "/api/commerce";
export declare const COMMERCE_VAR = "VOIDBASE_COMMERCE";
export declare const CURRENCY_VAR = "VOIDBASE_COMMERCE_CURRENCY";
/** the header (or `?token=`) an anonymous cart is carried by */
export declare const CART_TOKEN_HEADER = "x-cart-token";
/** how long an untouched cart is good for */
export declare const CART_TTL_MS: number;
/** whether this instance sells anything: `VOIDBASE_COMMERCE` set to anything but 0, false or off */
export declare const commerceOn: (env?: object) => boolean;
/** the currency a new cart is in; lower case, the way every provider writes it */
export declare const defaultCurrency: (env?: object) => string;
export declare const COMMERCE_COLLECTIONS: readonly ["products", "variants", "inventory", "carts", "cart_items", "orders", "order_items", "shipments", "refunds", "commerce_audit"];
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
    createOnce(collection: CommerceCollection, values: Row & {
        id: string;
    }, alongside?: {
        collection: CommerceCollection;
        id: string;
        values: Row;
    }[]): Promise<boolean>;
    remove(collection: CommerceCollection, id: string): Promise<void>;
    /** the payments plugin's `customers` rows for a signed-in user, read only */
    customers(user: string): Promise<Row[]>;
}
/** the rows in D1, written through the records service as a superuser so hooks fire and realtime sees the change */
export declare function d1Rows(env: Bindings, realtime?: RealtimeClient): CommerceRows;
export declare const ORDER_STATUSES: readonly ["pending", "paid", "fulfilled", "cancelled", "refunded"];
export declare const CART_STATUSES: readonly ["open", "ordered", "abandoned"];
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
export declare function collectionDefinitions(db: D1Database): Promise<Record<string, unknown>[]>;
/** what a line of a cart or an order is, once the variant behind it has been read */
export interface Line {
    item: Row;
    variant: Row;
    quantity: number;
    unitPrice: number;
}
export declare const subtotalOf: (lines: Line[]) => number;
export declare function addressOf(v: unknown): QuoteAddress;
/** what is left of a variant's stock: a variant with no inventory row is not tracked, and never blocks a sale */
export declare function available(rows: CommerceRows, variant: string): Promise<number | null>;
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
export declare const defaultDeps: () => CommerceDeps;
export declare function commerceWith(overrides?: Partial<CommerceDeps>): Omit<Plugin, "manifest"> & {
    stopWatchingPayments: () => void;
};
/** what `/api/plugins` says about it: whether the shop is on and what a new cart is priced in */
export declare const commerceInfo: (env?: object) => {
    on: boolean;
    currency: string;
};
/** the shipped plugin: the rows in D1, the real clock, random tokens and order numbers */
declare const commerce: Omit<Plugin, "manifest"> & {
    stopWatchingPayments: () => void;
};
export default commerce;
