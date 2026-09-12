// The superuser hook store, for work that happens outside a request: the bootstrap and serve events, a cron job, a
// workflow step, a scheduled backup. `$app` then works inside a hook exactly as it does in a request.
//
// It sat in ./migrations.ts, beside the thing that first needed it, and it is here because of what that cost the
// three callers that are not migrations. ./migrations.ts imports `#platform/migrations` at module scope, and on Bun
// that pick compiles pb_migrations with the TypeScript compiler API at import -- through hooks-plugin.ts, the Vite
// build plugin, which imports src/node/installed.ts and the shipped-plugin list with it. So `withHookStore` dragged
// the build plugin and the marketplace resolver into the graph of everything that wanted a hook store, backups
// included; 7.6 found it by extracting the backups plugin, whose package reached src/server/plugins/shipped.ts on
// Bun through this one import and nothing else (test/unit/plugin-extraction.test.ts).
//
// Nothing here is about migrations: applying them is ./migrations.ts's, which imports this and runs its pending
// files inside it.
import { loadCollections } from "../collections/model";
import { realtimeFor } from "../realtime/hub-client";
import type { RecordContext } from "../records/service";
import { loadSettings } from "../settings";
import type { AppEnv } from "../types";
import { hookStore } from "./runtime";

/** Runs fn inside a superuser hook store outside any request (migrations, cron jobs), so $app works as in a request. */
export async function withHookStore<T>(db: D1Database, bindings: AppEnv["Bindings"] | undefined, fn: () => Promise<T> | T): Promise<T> {
  const collections = await loadCollections(db);
  const ctx = async (): Promise<RecordContext> => ({
    db, storage: bindings?.STORAGE as R2Bucket, auth: null, superuser: true,
    request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" },
    collections: await loadCollections(db),
    // outside a request there may be no bindings at all (the Bun runtime); then there is no hub and the feed is used
    realtime: realtimeFor((bindings ?? {}) as AppEnv["Bindings"]),
  });
  const store = { c: undefined as never, ctx, collections, settings: await loadSettings(db), env: (bindings ?? {}) as Record<string, unknown> };
  return hookStore.run(store, () => fn());
}
