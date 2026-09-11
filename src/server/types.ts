/// <reference types="@cloudflare/workers-types" />
import type { Collection } from "./collections/model";

export type Row = Record<string, unknown>;

export interface AuthRecord {
  collection: Collection;
  row: Row;
}

export interface Bindings {
  DB: D1Database;
  STORAGE: R2Bucket;
  // optional Cloudflare bindings, declared by the deploy (queues/jobs.ts, wrangler ratelimits / analytics_engine_datasets)
  QUEUE_JOBS?: { send(body: unknown, options?: { delaySeconds?: number }): Promise<void> };
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  LOGS_ANALYTICS?: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
  HUB?: DurableObjectNamespace; // the instance's realtime hub (src/server/hub.ts)
  // the instance's database as a SQLite-backed Durable Object (src/server/durable-db.ts), bound instead of D1 with
  // VOIDBASE_DATABASE=durable; every entry point rebinds DB to it first (src/server/durable-d1.ts bindDatabase)
  DB_OBJECT?: DurableObjectNamespace;
  // Cloudflare Email Service: the send_email binding the deploy adds with VOIDBASE_MAIL_DOMAIN (plugins/mail.ts)
  SEND_EMAIL?: { send(message: EmailMessage): Promise<unknown> }; // EmailMessage: the global from @cloudflare/workers-types
  VOIDBASE_MAIL_DOMAIN?: string;
  // Workers AI: the `ai` binding the deploy adds with VOIDBASE_AI (plugins/ai.ts); typed to what the plugin calls
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  VOIDBASE_AI?: string;
  // Stripe: the secret key and the webhook signing secret, both secrets on the Worker (plugins/stripe.ts)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Polar: the access token, the webhook secret, and `1` for the sandbox (plugins/polar.ts)
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_SANDBOX?: string;
  // Lemon Squeezy: the API key, the store the checkouts belong to, the webhook signing secret (plugins/lemonsqueezy.ts)
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_STORE_ID?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  // the shop and the two flat-rate plugins beside it (plugins/commerce.ts, tax-flat.ts, shipping-flat.ts)
  VOIDBASE_COMMERCE?: string;
  VOIDBASE_COMMERCE_CURRENCY?: string;
  VOIDBASE_TAX_RATE?: string;
  VOIDBASE_SHIPPING_FLAT?: string;
  VOIDBASE_SHIPPING_FREE_OVER?: string;
  // a project instance: the repository it deploys from and a token that commits there (plugins/installer.ts)
  VOIDBASE_PROJECT_REPO?: string;
  VOIDBASE_PROJECT_BRANCH?: string;
  VOIDBASE_GH_TOKEN?: string;
  // the backups plugin's schedule and off-site copy (src/server/backups.ts)
  VOIDBASE_BACKUP_KIND?: string;
  VOIDBASE_BACKUP_KEEP?: string;
  VOIDBASE_BACKUP_S3_ENDPOINT?: string;
  VOIDBASE_BACKUP_S3_BUCKET?: string;
  VOIDBASE_BACKUP_S3_ACCESS_KEY_ID?: string;
  VOIDBASE_BACKUP_S3_SECRET_ACCESS_KEY?: string;
  VOIDBASE_BACKUP_S3_REGION?: string;
}

export interface Variables {
  auth: AuthRecord | null;
  /** the realtime client for this request's bindings, from the realtime plugin (realtime@1) */
  realtime: import("./interfaces").RealtimeClient;
  /** set by a route serving a stored file, so the response policy (hardening@1) applies the files' Content-Security-Policy */
  file?: true;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
