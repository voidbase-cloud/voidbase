// PocketBase-style JS migrations (pb_migrations/*.js): `migrate(up, down)` files applied once at bootstrap,
// tracked in _pbMigrations (file, applied). The `app` handed to `up` is $app plus importCollections, so the
// starter's snapshot migration creates its schema on a fresh database and later migrations can use
// findCollectionByNameOrId / save / delete like they do in PocketBase.
//
// `withHookStore` is ./store.ts's, and is re-exported here because it lived here first. Importing it from there
// rather than from this module is what keeps `#platform/migrations` -- which on Bun compiles pb_migrations at import,
// through the Vite build plugin -- out of a caller that only wants a hook store.
import { migrations } from "#platform/migrations";
import { invalidateCollections, loadCollections } from "../collections/model";
import { importCollections } from "../collections/service";
import { all, run, stmt } from "../db";
import type { AppEnv } from "../types";
import { hookStore } from "./runtime";
import { withHookStore } from "./store";

export { withHookStore };

export type MigrationFn = (app: Record<string, unknown>) => unknown;

export async function applyPendingMigrations(db: D1Database, globals: Record<string, unknown> = {}, bindings?: AppEnv["Bindings"]): Promise<string[]> {
  if (!migrations.length) return [];
  return withHookStore(db, bindings, () => runPending(db, globals));
}

async function runPending(db: D1Database, globals: Record<string, unknown>): Promise<string[]> {
  const applied = new Set((await all<{ file: string }>(db, "SELECT file FROM `_pbMigrations`")).map((r) => r.file));
  const own: Record<string, unknown> = {
    importCollections: (list: Record<string, unknown>[], deleteMissing = false) => importCollections(db, list, deleteMissing),
    // raw DDL/DML for migrations that are not about collections (a Void app's Drizzle migrations, see src/adapter):
    // voidbase-specific, PocketBase spells this app.db().newQuery(sql).execute()
    execSQL: (sql: string, params: unknown[] = []) => run(db, sql, params),
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
    // the next migration must see what this one created (PocketBase reloads its collections cache the same way)
    const store = hookStore.getStore(); if (store) { const fresh = await loadCollections(db); store.collections.clear(); for (const [k, v] of fresh) store.collections.set(k, v); }
    await stmt(db, "INSERT OR IGNORE INTO `_pbMigrations` (file, applied) VALUES (?, ?)", [m.name, Date.now()]).run();
    done.push(m.name);
  }
  if (done.length) console.log(`voidbase: applied ${done.length} pb_migrations: ${done.join(", ")}`);
  return done;
}
