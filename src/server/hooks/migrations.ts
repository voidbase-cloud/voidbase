// PocketBase-style JS migrations (pb_migrations/*.js): `migrate(up, down)` files applied once at bootstrap,
// tracked in _pbMigrations (file, applied). The `app` handed to `up` is $app plus importCollections, so the
// starter's snapshot migration creates its schema on a fresh database and later migrations can use
// findCollectionByNameOrId / save / delete like they do in PocketBase.
import { migrations } from "virtual:voidbase-migrations";
import { invalidateCollections, loadCollections } from "../collections/model";
import { importCollections } from "../collections/service";
import { all, stmt } from "../db";
import { loadSettings } from "../settings";
import type { RecordContext } from "../records/service";
import type { AppEnv } from "../types";
import { hookStore } from "./runtime";

export type MigrationFn = (app: Record<string, unknown>) => unknown;

// Runs fn inside a superuser hook store outside any request (migrations, cron jobs), so $app works as in a request.
export async function withHookStore<T>(db: D1Database, bindings: AppEnv["Bindings"] | undefined, fn: () => Promise<T> | T): Promise<T> {
  const collections = await loadCollections(db);
  const ctx = async (): Promise<RecordContext> => ({
    db, storage: bindings?.STORAGE as R2Bucket, auth: null, superuser: true,
    request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" },
    collections: await loadCollections(db),
  });
  const store = { c: undefined as never, ctx, collections, settings: await loadSettings(db), env: (bindings ?? {}) as Record<string, unknown> };
  return hookStore.run(store, () => fn());
}

export async function applyPendingMigrations(db: D1Database, globals: Record<string, unknown> = {}, bindings?: AppEnv["Bindings"]): Promise<string[]> {
  if (!migrations.length) return [];
  return withHookStore(db, bindings, () => runPending(db, globals));
}

async function runPending(db: D1Database, globals: Record<string, unknown>): Promise<string[]> {
  const applied = new Set((await all<{ file: string }>(db, "SELECT file FROM `_pbMigrations`")).map((r) => r.file));
  const own: Record<string, unknown> = {
    importCollections: (list: Record<string, unknown>[], deleteMissing = false) => importCollections(db, list, deleteMissing),
  };
  const $app = (globals.$app ?? {}) as Record<string, unknown>;
  const app = new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : $app[k as string]), has: (t, k) => k in t || k in $app });
  const done: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (applied.has(m.name)) continue;
    let up: MigrationFn | null = null;
    const migrate = (u: MigrationFn, _down?: MigrationFn) => { up = u; };
    try {
      await m.run({ ...globals, migrate });
      if (up) await (up as MigrationFn)(app);
    } catch (err) {
      console.error(`voidbase: migration ${m.name} failed:`, err instanceof Error ? err.message : err);
      throw err;
    }
    invalidateCollections();
    await stmt(db, "INSERT OR IGNORE INTO `_pbMigrations` (file, applied) VALUES (?, ?)", [m.name, Date.now()]).run();
    done.push(m.name);
  }
  if (done.length) console.log(`voidbase: applied ${done.length} pb_migrations: ${done.join(", ")}`);
  return done;
}
