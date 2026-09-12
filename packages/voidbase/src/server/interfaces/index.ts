// The interfaces a plugin may provide or require.
//
// The roadmap calls this the highest-consequence design on the page, and the reason is that an interface defined
// badly is inherited by everything downstream: a marketplace where every plugin invents its own contract is no
// better than having none. So they live here, in one place, versioned, and this file is the list.
//
// A name carries its major version: `payments@1`. A major bump is a different interface rather than a compatible
// one, which is what stops two plugins half-matching and finding out at request time. cordis resolves them by
// name, so the version is part of the name it resolves.
//
// Who may define one is the governance question the roadmap flags as unresolved. For now: we do, here, and a
// community plugin consumes an interface rather than inventing one. When that stops being enough, this file is
// where the answer goes.
import type { MiddlewareHandler } from "hono";
import type { AppEnv, AuthRecord, Bindings, Row } from "../types";
import type { Field } from "../collections/fields";
import type { ResponsePolicy } from "../response-policy";
import type { MailMessage } from "../mail/message";

/**
 * Authentication. Three parts, not one (plan.md, decision 0.3, taken 2026-09-09).
 *
 * The roadmap's contract is "a request goes in, a record or null comes out", and that is too small for what the
 * core actually does with auth: filter/compile.ts resolves `@request.auth.<field>` against the record's fields
 * when it compiles a rule to SQL, and the records API resolves list and view rules against the auth collections.
 * The core knows auth's shape, not only its result, so the shape is in the contract: `schema` says what every
 * auth record answers to in a rule beyond its collection's own fields, and `collections` says which collections
 * hold accounts. What a superuser is belongs to the provider too; the core asks and does not decide. Bindings
 * arrive with the request, so the lookups take them rather than holding one.
 *
 * The core reaches the provider through src/server/auth-slot.ts and never imports it. An instance with no
 * provider runs with nobody signed in and says which core interface it is missing.
 */
export interface Auth {
  /** who is making this request, or nobody: the token the request carries, verified against this instance */
  authenticate(request: Request, env: Bindings): Promise<AuthRecord | null>;
  /** the record behind a token this provider issued, of one of its kinds: "auth" (the default), "file", "verification", "passwordReset", "emailChange" */
  fromToken(token: string, env: Bindings, type?: string): Promise<AuthRecord | null>;
  /** the fields every auth record answers to in a rule whatever its collection declares: what `@request.auth.<field>` may name beyond the collection's own fields */
  schema(): Pick<Field, "name" | "type">[];
  /** which collections hold auth records, since list and view rules resolve against them */
  collections(env: Bindings): Promise<string[]>;
  /** whether this record is a superuser, which the core asks about and does not decide */
  isSuperuser(record: AuthRecord | null | undefined): boolean;
}

/**
 * Taking money. One plugin per provider, all of them providing this, which is the roadmap's own worked example and
 * the first real test of the mechanism: swapping Stripe for Polar is removing one plugin and installing another,
 * and nothing that required `payments@1` changes or is aware.
 *
 * A provider's key and webhook secret are secrets, and secrets arrive with the request rather than at module scope,
 * so this is answered per env the way mail is (reshaped 2026-09-11 with the stripe plugin): `route(env)` says where
 * payments go with these bindings and which webhook URL to register, or null when the provider has no key here, in
 * which case every other call refuses with the knob's name. `customer` and `subscription` are ids of the rows in the
 * collections the provider owns (`customers`, `subscriptions`, `payments`), never the provider's own ids: the app
 * talks about its rows and the plugin translates.
 */
export interface PaymentsRoute {
  via: string;
  webhook: string;
  livemode: boolean;
  /** other shipped providers whose key is set too; `via` answers because it comes first in the shipped order */
  also?: string[];
  /** why `via` and not one of `also`, for whoever reads /api/plugins */
  reason?: string;
}
export interface Payments {
  /** where payments go with these bindings, for /api/plugins; null means this provider has no key here */
  route(env: Bindings): PaymentsRoute | null;
  /**
   * The `customers` row for a signed-in user, created at the provider on the first contact: the id every other
   * method takes. Added 2026-09-11 with the commerce plugin, which has an auth record and needs the row id the
   * provider's own checkout route would have looked up for itself.
   */
  customer(env: Bindings, auth: AuthRecord): Promise<string>;
  /**
   * Start a checkout for a customers row and return where to send the customer. A checkout with a `reference` is
   * charged in full or refused (400): every item at its quantity and every amount line. One without a reference is
   * too, but at Polar, which lists its products for the buyer to pick among and charges the one picked, once (an amount
   * line is refused there either way); such a checkout names no order, so it moves no commerce order.
   */
  checkout(env: Bindings, o: CheckoutRequest & { customer: string }): Promise<{ url: string }>;
  /**
   * Refuse (400) a checkout the active provider cannot charge in full, the same check `checkout` makes first, without
   * starting one. Optional, like `refund`. Added 2026-09-11 with amount lines, so that commerce refuses a cart the
   * provider cannot charge in full before it creates the customer at the provider, writes the order and reserves the
   * stock, rather than undoing all three afterwards. It is not the provider route's check of its own body (Stripe's
   * route requires `cancel` and this does not), because a caller of the interface did not use the route.
   */
  checkCheckout?(env: Bindings, o: CheckoutRequest): void;
  /** where a customer manages their own billing, when the provider hosts such a page */
  portal(env: Bindings, o: { customer: string; return: string }): Promise<{ url: string }>;
  /** verify and interpret a provider's webhook and write what it says into the collections; the route belongs to the provider's own plugin */
  webhook(env: Bindings, request: Request): Promise<{ kind: string; customer?: string; subscription?: string; payment?: string; raw: Row } | null>;
  /** stop a subscriptions row: at the period's end by default, or now; `resume` takes a period-end cancellation back */
  cancel(env: Bindings, subscription: string, o?: { now?: boolean; resume?: boolean }): Promise<void>;
  /**
   * Give money back for a `payments` row, when the provider offers it. Optional, and no shipped provider
   * implements it yet: a caller asks whether the method is there and records the refund either way, which is what
   * lets commerce refund an order against a provider that can only be refunded from its own dashboard.
   */
  refund?(env: Bindings, o: { payment: string; amount?: number; reason?: string }): Promise<{ providerId: string }>;
}

/**
 * What a checkout charges. `items` are prices the provider already knows, by its own id. `amounts` are lines that
 * carry their own amount in the currency's minor unit, for what has no price at the provider because it was
 * computed a second ago: commerce's tax and shipping, added 2026-09-11 after a Stripe session on the demo charged
 * an order's 4500 subtotal and not its 5900 total. A provider that cannot charge an amount line refuses the whole
 * checkout rather than leave the line out. `reference` is the caller's own id for what is being paid for (commerce's
 * order): the provider carries it in its metadata, it comes back on the object the webhook writes into `raw`, and
 * that is how a payment says which order it pays. It is a claim and not proof, since any caller of `payments@1` can
 * give one, so commerce holds it against the amount paid; and a payment that comes back without one moves no order of
 * commerce's. A checkout with a reference is paid only by its whole total, so a provider refuses more of it (Polar a
 * second product) and Polar and Lemon Squeezy offer its buyer no discount code. The provider routes read neither
 * from a request body, because a browser that names its own amounts sets its own price and one that names an order
 * could pay somebody else's.
 */
export interface CheckoutRequest {
  items: { price: string; quantity: number }[];
  amounts?: { name: string; amount: number; currency: string }[];
  /**
   * The currency the caller priced what is paid for in (commerce's cart's), in either case. Added 2026-09-11 for
   * Polar, which shows a buyer their local currency when the product has a price in it: a Polar checkout with a
   * reference is sent it, lower-cased, so the payment comes back in the currency its order was priced in. Stripe and
   * Lemon Squeezy ignore it.
   */
  currency?: string;
  success: string;
  cancel?: string;
  mode?: "payment" | "subscription";
  reference?: string;
}

/**
 * What a shop asks of somebody else. Two interfaces, deliberately small, added 2026-09-11 with the commerce
 * plugin, which requires them rather than any particular plugin: a tax engine supplies the tax, a carrier
 * supplies the rates, and commerce never learns which.
 *
 * They are shaped the way `payments@1` is, and for the same reason: an API key or a rate table arrives with the
 * request rather than at module scope, so the env is the first argument of every method rather than something the
 * provider holds. There is no `route(env)` twin, because neither of these has a webhook to register or a knob a
 * caller has to be told about: a provider with nothing configured answers zero rather than refusing, which is what
 * makes the shipped flat-rate pair a working default instead of a wall.
 *
 * Every amount is an integer in the currency's minor unit, like the `payments` collection's `amount`, because a
 * price that has been through a float is a price you cannot reconcile.
 */
export interface QuoteAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postcode?: string;
  /** ISO 3166-1 alpha-2, upper case, as a tax engine and a carrier both expect it */
  country?: string;
}
/** one line of what is being quoted for: what it is, how many, and what each costs in the minor unit */
export interface QuoteItem {
  /** the `variants` row, when the caller has one */
  variant?: string;
  sku?: string;
  title?: string;
  quantity: number;
  unitPrice: number;
  /** grams, when the variant says; a carrier that prices by weight reads it */
  weight?: number;
}
export interface TaxLine {
  label: string;
  amount: number;
}
export interface Tax {
  /** what tax these items owe going to this address; `customer` is the `customers` row id when there is one */
  quote(env: Bindings, o: { items: QuoteItem[]; to: QuoteAddress; customer?: string }): Promise<{ lines: TaxLine[]; total: number }>;
}
export interface ShippingRate {
  /** stable for this quote: what a checkout names to choose this rate */
  id: string;
  label: string;
  amount: number;
  /** what the carrier says about delivery, free text ("2 to 4 working days") */
  eta?: string;
}
export interface Shipping {
  /** the ways these items can be sent to this address, cheapest first by convention; an empty list means none */
  rates(env: Bindings, o: { items: QuoteItem[]; to: QuoteAddress }): Promise<ShippingRate[]>;
}

/**
 * Fanning a change out to whoever is watching.
 *
 * Bindings arrive with the request, not at module scope, so this is a factory over them rather than a service that
 * holds one: `for(env)` returns the client for this request. The client answers `active()` — is there a hub — and
 * every caller that asks and hears no falls back to the D1 change feed and its poll loop, which is the caller's own
 * code rather than a second implementation of this interface. Nobody installs a hub; it is a deployment detail, so
 * this is one plugin whose client follows the binding, not two plugins chosen by composition.
 */
export interface RealtimeClient {
  /** whether a change has somewhere to go, which decides if the write path records one at all */
  active(): boolean;
  publish(changes: { collection: string; recordId: string; action: "create" | "update" | "delete" | "message"; data?: Row | null }[]): Promise<void>;
  presence(op: string, member: unknown, o: { max: number; ttlMs: number }): Promise<{ members: unknown[]; holdsSlot: boolean } | null>;
  publishToClient(clientId: string, event: string, data: unknown): Promise<boolean>;
  controlClient(clientId: string, subscriptions: string[], token: string): Promise<void>;
  openSocket(clientId: string): Promise<WebSocket>;
}
export interface Realtime {
  for(env: Bindings): RealtimeClient;
}

/**
 * The limits every request meets before a route sees it (PocketBase's body limit and its rate limit rules) and
 * the response policy every answer leaves through (the security headers, the files' Content-Security-Policy,
 * CORS, the CSRF check: src/server/response-policy.ts).
 *
 * Middleware runs in the order it was registered and the kernel loads after the routes are mounted, so the provider
 * does not mount anything. It hands over the handlers and app.ts keeps their place in the chain with slots that
 * ask for them at request time. No provider means no limits and no policy, which is what an instance stripped to
 * the loader is supposed to mean, and also how a different limiter or a company's own policy takes this one's place.
 */
export interface Hardening {
  /** refuses a body over the limit with 413 before anything reads it */
  bodyLimit: MiddlewareHandler<AppEnv>;
  /** PocketBase's rate limit rules per client, 429 when one is exceeded */
  rateLimit: MiddlewareHandler<AppEnv>;
  /** first in the chain: CORS, the headers on every response, the files' policy, the CSRF refusal */
  responsePolicy: MiddlewareHandler<AppEnv>;
  /** the knobs as an env resolves them, for whoever wants to read the policy rather than apply it */
  policy(env?: object): ResponsePolicy;
}

/**
 * Sending mail. The core builds every message and decides when it goes (src/server/mail); which service carries it
 * is a plugin's business. Bindings arrive with the request, so the provider answers per env like realtime does:
 * `carrier(env)` names where mail goes with these bindings, or null when it has nothing to send with, in which case
 * the core uses what it had (the HTTP provider, the SMTP settings, a log line). A provider tied to one domain
 * declines another sender in `refuses`, with the reason the core shows when no other transport can take the message.
 */
export interface Mail {
  /** where mail goes with these bindings, for the log and /api/plugins; null means this provider cannot carry it here */
  carrier(env: Bindings): string | null;
  /** why this sender cannot leave through this provider, or null when it can */
  refuses(from: string, env: Bindings): string | null;
  /** deliver one message; `text` is the plain part beside the html */
  send(env: Bindings, m: MailMessage, text: string): Promise<void>;
}

/**
 * Seeing what the instance is doing. The second core interface (2026-09-11), because an instance you cannot see
 * into is one you cannot operate.
 *
 * Two halves, and the split is the same one hardening's is. `sample` is middleware, and middleware is the one
 * thing a plugin cannot mount for itself: the kernel loads after the routes are mounted, so app.ts holds its
 * place in the chain and asks the provider at request time. `report` is what `/api/plugins` says about it, which
 * an instance has to be able to answer about itself: where its numbers come from, how much of the path is
 * sampled, and whether the request log it falls back to is being written at all.
 *
 * Reading the numbers is not in the contract. The routes are the provider's own, the way a payment provider's
 * webhook route is, because what they answer from (Analytics Engine, the request log, somebody else's service)
 * is exactly what a replacement is replacing.
 */
export interface Observability {
  /** measures every request and records it; never fails one, whatever the recording does */
  sample: MiddlewareHandler<AppEnv>;
  /** what `/api/plugins` reports, per env: bindings and knobs arrive with the request, not at module scope */
  report(env: Bindings): Promise<{ via: "analytics-engine" | "request-log"; sampling: number; logs: boolean }>;
}

/** every interface this voidbase defines, and the type behind each */
export interface Interfaces {
  "auth@1": Auth;
  "payments@1": Payments;
  "tax@1": Tax;
  "shipping@1": Shipping;
  "realtime@1": Realtime;
  "hardening@1": Hardening;
  "mail@1": Mail;
  "observability@1": Observability;
}

export type Known = keyof Interfaces;

/** the list, for the loader to check a manifest against something rather than accepting any string */
export const KNOWN: Known[] = ["auth@1", "payments@1", "tax@1", "shipping@1", "realtime@1", "hardening@1", "mail@1", "observability@1"];
