// PocketBase-style JS migrations (pb_migrations/*.js): `migrate(up, down)` files applied once at bootstrap,
// tracked in _pbMigrations (file, applied). The `app` handed to `up` is $app plus importCollections, so the
// starter's snapshot migration creates its schema on a fresh database and later migrations can use
// findCollectionByNameOrId / save / delete like they do in PocketBase.
//
// `withHookStore` is ./store.ts's, and is re-exported here because it lived here first. Importing it from there
// rather than from this module is what keeps `#platform/migrations` -- which on Bun compiles pb_migrations at import,
// through the Vite build plugin -- out of a caller that only wants a hook store.
import { migrations } from "#platform/migrations";
import { collectionToJSON, invalidateCollections, loadCollections } from "../collections/model";
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

/** the `app` a migration's up and down receive: $app, plus importCollections and execSQL on this database */
function appFor(db: D1Database, globals: Record<string, unknown>): Record<string, unknown> {
  const own: Record<string, unknown> = {
    importCollections: (list: Record<string, unknown>[], deleteMissing = false) => importCollections(db, list, deleteMissing),
    // raw DDL/DML for migrations that are not about collections (a Void app's Drizzle migrations, see src/adapter):
    // voidbase-specific, PocketBase spells this app.db().newQuery(sql).execute()
    execSQL: (sql: string, params: unknown[] = []) => run(db, sql, params),
  };
  const $app = (globals.$app ?? {}) as Record<string, unknown>;
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : $app[k as string]), has: (t, k) => k in t || k in $app });
}

/** the next migration must see what this one changed (PocketBase reloads its collections cache the same way) */
async function refreshCollections(db: D1Database): Promise<void> {
  invalidateCollections();
  const store = hookStore.getStore(); if (store) { const fresh = await loadCollections(db); store.collections.clear(); for (const [k, v] of fresh) store.collections.set(k, v); }
}

async function runPending(db: D1Database, globals: Record<string, unknown>): Promise<string[]> {
  const applied = new Set((await all<{ file: string }>(db, "SELECT file FROM `_pbMigrations`")).map((r) => r.file));
  const app = appFor(db, globals);
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
    await refreshCollections(db);
    await stmt(db, "INSERT OR IGNORE INTO `_pbMigrations` (file, applied) VALUES (?, ?)", [m.name, Date.now()]).run();
    done.push(m.name);
  }
  if (done.length) console.log(`voidbase: applied ${done.length} pb_migrations: ${done.join(", ")}`);
  return done;
}

/**
 * `voidbase migrate down [n]`, as PocketBase's: the last n applied migrations, newest first, each reverted by its own
 * `down` and taken out of _pbMigrations. A migration with no `down` is taken out all the same, which is what PocketBase
 * does too. One whose file is gone cannot be reverted, and says so rather than dropping its row unrun.
 */
export async function revertMigrations(db: D1Database, globals: Record<string, unknown> = {}, count = 1, bindings?: AppEnv["Bindings"]): Promise<string[]> {
  return withHookStore(db, bindings, async () => {
    const rows = await all<{ file: string }>(db, "SELECT file FROM `_pbMigrations` ORDER BY applied DESC, file DESC LIMIT ?", [Math.max(0, count)]);
    const byName = new Map(migrations.map((m) => [m.name, m]));
    const app = appFor(db, globals);
    const done: string[] = [];
    for (const { file } of rows) {
      const m = byName.get(file);
      if (!m) throw new Error(`${file} was applied, but pb_migrations has no such file to revert it with: put it back, or run voidbase migrate history-sync`);
      let down: MigrationFn | null = null;
      await m.run({ ...globals, migrate: (_up: MigrationFn, d?: MigrationFn) => { down = d ?? null; } });
      if (down) await (down as MigrationFn)(app);
      await refreshCollections(db);
      await stmt(db, "DELETE FROM `_pbMigrations` WHERE file = ?", [file]).run();
      done.push(file);
    }
    return done;
  });
}

/** `voidbase migrate history-sync`, as PocketBase's: forget the applied migrations whose files are no longer there */
export async function syncMigrationsHistory(db: D1Database): Promise<string[]> {
  const present = new Set(migrations.map((m) => m.name));
  const applied = (await all<{ file: string }>(db, "SELECT file FROM `_pbMigrations`")).map((r) => r.file);
  const gone = applied.filter((f) => !present.has(f));
  for (const file of gone) await stmt(db, "DELETE FROM `_pbMigrations` WHERE file = ?", [file]).run();
  return gone;
}

/** `voidbase migrate collections`, as PocketBase's: every collection as it is now, as a migration that imports them */
export async function collectionsSnapshot(db: D1Database): Promise<string> {
  const collections = [...(await loadCollections(db)).values()].map((c) => collectionToJSON(c));
  return `/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const snapshot = ${JSON.stringify(collections, null, 2).split("\n").join("\n  ")};

  return app.importCollections(snapshot, false);
}, (app) => {
  return null;
})
`;
}
