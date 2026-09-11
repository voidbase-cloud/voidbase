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
  // Cloudflare Email Service: the send_email binding the deploy adds with VOIDBASE_MAIL_DOMAIN (plugins/mail.ts)
  SEND_EMAIL?: { send(message: EmailMessage): Promise<unknown> }; // EmailMessage: the global from @cloudflare/workers-types
  VOIDBASE_MAIL_DOMAIN?: string;
  // Workers AI: the `ai` binding the deploy adds with VOIDBASE_AI (plugins/ai.ts); typed to what the plugin calls
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  VOIDBASE_AI?: string;
  // Stripe: the secret key and the webhook signing secret, both secrets on the Worker (plugins/stripe.ts)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // a project instance: the repository it deploys from and a token that commits there (plugins/installer.ts)
  VOIDBASE_PROJECT_REPO?: string;
  VOIDBASE_PROJECT_BRANCH?: string;
  VOIDBASE_GH_TOKEN?: string;
}

export interface Variables {
  auth: AuthRecord | null;
  /** the realtime client for this request's bindings, from the realtime plugin (realtime@1) */
  realtime: import("./interfaces").RealtimeClient;
  /** set by a route serving a stored file, so the response policy (hardening@1) applies the files' Content-Security-Policy */
  file?: true;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
