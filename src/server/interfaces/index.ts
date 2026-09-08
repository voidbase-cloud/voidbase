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
import type { AuthRecord, Bindings, Row } from "../types";
import type { Field } from "../collections/fields";

/**
 * Authentication. Three parts, not one.
 *
 * The roadmap's contract is "a request goes in, a record or null comes out", and that is too small for what the
 * core actually does with auth: filter/compile.ts resolves `@request.auth.<field>` against the record's fields
 * when it compiles a rule to SQL. The core knows auth's shape, not only its result, so the shape is in the
 * contract. Without `schema` a rule referring to a field that does not exist would compile and fail at query time
 * instead of being refused when it was written.
 */
export interface Auth {
  /** who is making this request, or nobody */
  authenticate(request: Request): Promise<AuthRecord | null>;
  /** the fields `@request.auth.*` may name, so rules can still be checked when they are written */
  schema(): Promise<Field[]>;
  /** which collections hold auth records, since list and view rules resolve against them */
  collections(): Promise<string[]>;
  /** whether this record is a superuser, which the core asks about and does not decide */
  isSuperuser(record: AuthRecord): boolean;
}

/**
 * Taking money. One plugin per provider, all of them providing this, which is the roadmap's own worked example and
 * the first real test of the mechanism: swapping Stripe for Polar is removing one plugin and installing another,
 * and nothing that required `payments@1` changes or is aware.
 */
export interface Payments {
  /** start a checkout and return where to send the customer */
  checkout(o: { customer: string; items: { price: string; quantity: number }[]; success: string; cancel: string }): Promise<{ url: string }>;
  /** verify and interpret a provider's webhook; the route belongs to the provider's own plugin */
  webhook(request: Request): Promise<{ kind: string; customer?: string; subscription?: string; raw: Row } | null>;
  /** stop a subscription */
  cancel(subscription: string): Promise<void>;
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

/** Sending mail. The core sends it; which service carries it is a plugin's business. */
export interface Mail {
  send(m: { to: string; subject: string; html: string; text?: string }): Promise<void>;
}

/** every interface this voidbase defines, and the type behind each */
export interface Interfaces {
  "auth@1": Auth;
  "payments@1": Payments;
  "realtime@1": Realtime;
  "mail@1": Mail;
}

export type Known = keyof Interfaces;

/** the list, for the loader to check a manifest against something rather than accepting any string */
export const KNOWN: Known[] = ["auth@1", "payments@1", "realtime@1", "mail@1"];
