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
  // a project instance: the repository it deploys from and a token that commits there (plugins/installer.ts)
  VOIDBASE_PROJECT_REPO?: string;
  VOIDBASE_PROJECT_BRANCH?: string;
  VOIDBASE_GH_TOKEN?: string;
}

export interface Variables {
  auth: AuthRecord | null;
  /** the realtime client for this request's bindings, from the realtime plugin (realtime@1) */
  realtime: import("./interfaces").RealtimeClient;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
