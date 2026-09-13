import type { Payments } from "@voidbase-cloud/voidbase/interfaces";
import type { Bindings, Row } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
import { type PaymentDeps, type PaymentProvider, type PaymentRows, type WebhookResult } from "@voidbase-cloud/voidbase/plugins/payments-shared";
export declare const LEMONSQUEEZY_API = "https://api.lemonsqueezy.com";
export declare const KEY_VAR = "LEMONSQUEEZY_API_KEY";
export declare const STORE_VAR = "LEMONSQUEEZY_STORE_ID";
export declare const WEBHOOK_SECRET_VAR = "LEMONSQUEEZY_WEBHOOK_SECRET";
export declare const PROVIDER = "lemonsqueezy";
export declare const API: string;
export declare const WEBHOOK_PATH: string;
export declare const apiKey: (env: Bindings) => string;
export declare const storeId: (env: Bindings) => string;
export declare const webhookSecret: (env: Bindings) => string;
/** the hex HMAC SHA-256 of the raw body under the signing secret: what Lemon Squeezy puts in `X-Signature` */
export declare function signPayload(secret: string, payload: string): Promise<string>;
/**
 * Check `X-Signature` against the payload as it arrived. Lemon Squeezy signs the raw body and nothing else, so
 * there is no timestamp to bound: a replay of a signed body verifies, and the upsert by provider id is what makes
 * it a no-op.
 */
export declare function verifySignature(payload: string, header: string | null, secret: string): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
}>;
/** Lemon Squeezy's subscription statuses as the rows' vocabulary; `cancelled` still runs until `ends_at` */
export declare const SUBSCRIPTION_STATUS: Record<string, string>;
/** write one verified event into the rows; null for an event this plugin does not read */
export declare function applyEvent(rows: PaymentRows, event: Row): Promise<WebhookResult | null>;
export type LemonSqueezyDeps = PaymentDeps;
/** Lemon Squeezy over its dependencies: the knobs, the calls, the signature, the events */
export declare function lemonsqueezyProvider(deps: PaymentDeps): PaymentProvider;
/** the plugin over its dependencies: the shipped one uses fetch, D1 and the clock; tests replace all three */
export declare function lemonsqueezyWith(overrides?: Partial<LemonSqueezyDeps>): Omit<Plugin, "manifest"> & {
    payments: Payments;
};
/** the shipped plugin: Lemon Squeezy over fetch, the rows in D1, the real clock; it joins stripe's family for payments@1 */
declare const lemonsqueezy: Omit<Plugin, "manifest"> & {
    payments: Payments;
};
export default lemonsqueezy;
