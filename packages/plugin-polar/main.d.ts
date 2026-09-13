import type { Payments } from "@voidbase-cloud/voidbase/interfaces";
import type { Bindings, Row } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
import { type PaymentDeps, type PaymentProvider, type PaymentRows, type WebhookResult } from "@voidbase-cloud/voidbase/plugins/payments-shared";
export declare const POLAR_API = "https://api.polar.sh";
export declare const POLAR_SANDBOX_API = "https://sandbox-api.polar.sh";
export declare const KEY_VAR = "POLAR_ACCESS_TOKEN";
export declare const WEBHOOK_SECRET_VAR = "POLAR_WEBHOOK_SECRET";
/** `1` points every call at the sandbox, where nothing is real money */
export declare const SANDBOX_VAR = "POLAR_SANDBOX";
export declare const PROVIDER = "polar";
export declare const API: string;
export declare const WEBHOOK_PATH: string;
export declare const accessToken: (env: Bindings) => string;
export declare const webhookSecret: (env: Bindings) => string;
export declare const isSandbox: (env: Bindings) => boolean;
export declare const apiBase: (env: Bindings) => string;
/**
 * The key a `whsec_...` secret stands for, both ways Polar has meant it. Secrets generated on or after 8 September
 * 2026 follow Standard Webhooks: the part after `whsec_` is base64 and the key is its bytes. Older secrets use what
 * Polar calls Polar HMAC: the key is the UTF-8 bytes of the whole `whsec_...` string. A signature that matches
 * either is accepted, the way Polar's own SDKs try both.
 */
export declare function webhookKeys(secret: string): (string | Uint8Array)[];
/** the base64 HMAC SHA-256 of `${id}.${timestamp}.${payload}`: what goes after `v1,` in `webhook-signature` */
export declare function signPayload(secret: string, id: string, timestamp: number, payload: string, scheme?: "standard" | "legacy"): Promise<string>;
/**
 * Check the three Standard Webhooks headers against the payload as it arrived: `webhook-id`, `webhook-timestamp`
 * (unix seconds) and `webhook-signature` (`v1,<base64>` entries separated by spaces). A timestamp more than
 * `tolerance` seconds from `now` is refused whatever the signature says.
 */
export declare function verifySignature(payload: string, headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
}, secret: string, o?: {
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
export type PolarDeps = PaymentDeps;
/** Polar over its dependencies: the knobs, the calls, the signature, the events */
export declare function polarProvider(deps: PaymentDeps): PaymentProvider;
/** the plugin over its dependencies: the shipped one uses fetch, D1 and the clock; tests replace all three */
export declare function polarWith(overrides?: Partial<PolarDeps>): Omit<Plugin, "manifest"> & {
    payments: Payments;
};
/** the shipped plugin: Polar over fetch, the rows in D1, the real clock; it joins stripe's family for payments@1 */
declare const polar: Omit<Plugin, "manifest"> & {
    payments: Payments;
};
export default polar;
