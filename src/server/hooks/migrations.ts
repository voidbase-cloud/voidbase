// PocketBase-style JS migrations (pb_migrations/*.js): `migrate(up, down)` files applied once at bootstrap,
// tracked in _pbMigrations (file, applied). The `app` handed to `up` is $app plus importCollections, so the
// starter's snapshot migration creates its schema on a fresh database and later migrations can use
// findCollectionByNameOrId / save / delete like they do in PocketBase.
import { migrations } from "virtual:voidbase-migrations";
import { importCollections } from "../collections/service";
import { all, stmt } from "../db";

export type MigrationFn = (app: Record<string, unknown>) => unknown;

export async function applyPendingMigrations(db: D1Database, globals: Record<string, unknown> = {}): Promise<string[]> {
  if (!migrations.length) return [];
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
    await m.run({ ...globals, migrate });
    if (up) await (up as MigrationFn)(app);
    await stmt(db, "INSERT OR IGNORE INTO `_pbMigrations` (file, applied) VALUES (?, ?)", [m.name, Date.now()]).run();
    done.push(m.name);
  }
  if (done.length) console.log(`voidbase: applied ${done.length} pb_migrations: ${done.join(", ")}`);
  return done;
}
