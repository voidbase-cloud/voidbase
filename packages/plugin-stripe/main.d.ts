import type { Payments } from "@voidbase-cloud/voidbase/interfaces";
import type { Bindings, Row } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
import { type PaymentDeps, type PaymentProvider, type PaymentRows, type WebhookResult } from "@voidbase-cloud/voidbase/plugins/payments-shared";
export { collectionDefinitions, customerForUser, d1Rows, PAYMENT_STATUSES, SUBSCRIPTION_STATUSES, TOLERANCE_SECONDS, type Fetch, type PaymentCollection, type PaymentRows, type WebhookResult, } from "@voidbase-cloud/voidbase/plugins/payments-shared";
export declare const STRIPE_API = "https://api.stripe.com";
/** the API version every call pins, so a change on Stripe's side arrives when this line changes and not before */
export declare const STRIPE_VERSION = "2025-08-27.basil";
export declare const KEY_VAR = "STRIPE_SECRET_KEY";
export declare const WEBHOOK_SECRET_VAR = "STRIPE_WEBHOOK_SECRET";
export declare const PROVIDER = "stripe";
export declare const API: string;
export declare const WEBHOOK_PATH: string;
/** the secret key these bindings carry, or empty */
export declare const secretKey: (env: Bindings) => string;
/** the webhook signing secret these bindings carry, or empty */
export declare const webhookSecret: (env: Bindings) => string;
/** whether a key is a live one: `sk_live_`, `rk_live_`; anything else is test mode */
export declare const isLive: (key: string) => boolean;
/** Stripe's form encoding of nested params: `{ line_items: [{ price }] }` becomes `line_items[0][price]` */
export declare function formEncode(params: Record<string, unknown>): string;
/** HMAC SHA-256 of `${t}.${payload}` under the signing secret, in hex: what Stripe puts in `v1=` */
export declare function signPayload(secret: string, payload: string, t: number): Promise<string>;
/**
 * Check a `Stripe-Signature` header (`t=<unix seconds>,v1=<hex>[,v1=<hex>]`) against the payload as it arrived:
 * the signature is over `t.payload`, so the body is verified as bytes and parsed only afterwards. A timestamp more
 * than `tolerance` seconds from `now` is refused whatever the signature says, which is what closes replay.
 */
export declare function verifySignature(payload: string, header: string | null, secret: string, o?: {
    now?: number;
    tolerance?: number;
}): Promise<{
    ok: true;
    t: number;
} | {
    ok: false;
    reason: string;
}>;
/** write one verified event into the rows; null for an event this plugin does not read */
export declare function applyEvent(rows: PaymentRows, event: Row): Promise<WebhookResult | null>;
export type StripeDeps = PaymentDeps;
/** Stripe over its dependencies: the knobs, the calls, the signature, the events */
export declare function stripeProvider(deps: PaymentDeps): PaymentProvider;
/** the plugin over its dependencies: the shipped one uses fetch, D1 and the clock; tests replace all three */
export declare function stripeWith(overrides?: Partial<StripeDeps>): Omit<Plugin, "manifest"> & {
    payments: Payments;
};
/** the shipped plugin: Stripe over fetch, the rows in D1, the real clock */
declare const stripe: Omit<Plugin, "manifest"> & {
    payments: Payments;
};
export default stripe;
