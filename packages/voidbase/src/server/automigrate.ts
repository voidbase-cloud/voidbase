// Automigrate (voidbase-stories git-connection.feature, 9.1): a collection created, changed or deleted from the admin
// panel writes the migration that makes the same change, the way PocketBase's automigrate does, so a schema made by
// clicking travels with the project instead of living only in one database.
//
// Off unless VOIDBASE_AUTOMIGRATE says on. `voidbase serve` turns it on for a vanilla instance, where the panel is
// what declares the schema; an extended project turns it on itself (`voidbase({ automigrate: true })`, or
// `--automigrate` on its entry), because there the repository declares the schema and a change made in the panel is
// a change to the project that has to get back into it.
//
// Where the migration goes, and what the instance says about it:
//   the database   always recorded as applied in _pbMigrations: the change it describes has just been made here, so
//                  neither a restart nor the deploy that carries the file runs it a second time.
//   pb_migrations  written beside an instance that holds its own files (the platform's `migrationFiles`).
//   the repository committed to the branch when the instance is connected to git (VOIDBASE_PROJECT_REPO), which is
//                  the project's pipeline carrying it from there.
//   pending        otherwise the change still applies, and the instance keeps it as a schema change that is not in
//                  the repository: /api/automigrate answers the list and the admin panel shows it.
import { logger } from "#platform/log";
import { all, run } from "./db";
import { nowString } from "./ids";
import { repoOf } from "./installer-info";
import { commitFiles } from "./project-sync";
import { readKnob } from "./response-policy";
import type { Bindings } from "./types";

export const AUTOMIGRATE_VAR = "VOIDBASE_AUTOMIGRATE";
export type SchemaChange = "created" | "updated" | "deleted";
/** where a migration file is written, when the instance holds its own pb_migrations */
export interface MigrationFiles { write(file: string, source: string): void }
export interface Pending { file: string; collection: string; change: SchemaChange; at: string; source: string }
export interface Recorded { file: string; written: boolean; committed: string | null; inRepository: boolean }

const PENDING = "automigrate-pending";

export const automigrateOn = (env?: object): boolean => ["1", "on", "true", "yes"].includes(readKnob(AUTOMIGRATE_VAR, env).toLowerCase());

/** PocketBase's name for it: the unix second, what happened, and to which collection */
export const migrationFileName = (change: SchemaChange, collection: string, now = Date.now()): string =>
  `${Math.floor(now / 1000)}_${change}_${collection.replace(/[^A-Za-z0-9_]/g, "_")}.js`;

/** a JS migration that makes the change and undoes it, with what a migration's `app` has (hooks/migrations.ts) */
export function migrationSource(change: SchemaChange, before: object | null, after: object | null): string {
  const b = before as { id?: string; name?: string } | null, a = after as { id?: string; name?: string } | null;
  const name = a?.name ?? b?.name ?? "collection";
  const importing = (c: object | null) => `app.importCollections([${JSON.stringify(c, null, 2).replace(/\n/g, "\n    ")}], false);`;
  const deleting = (id: string | undefined) => `app.delete(app.findCollectionByNameOrId(${JSON.stringify(id)}));`;
  const up = change === "deleted" ? deleting(b?.id) : importing(after);
  const down = change === "created" ? deleting(a?.id) : importing(before);
  return `/// <reference path="../pb_data/types.d.ts" />\n// written by voidbase automigrate: the collection ${JSON.stringify(name)} was ${change} from the admin panel\nmigrate((app) => {\n  return ${up}\n}, (app) => {\n  return ${down}\n});\n`;
}

export async function pendingSchemaChanges(db: D1Database): Promise<Pending[]> {
  const rows = await all<{ value: string }>(db, "SELECT value FROM `_params` WHERE id = ?", [PENDING]);
  return rows[0] ? (JSON.parse(rows[0].value) as Pending[]) : [];
}

async function keepPending(db: D1Database, p: Pending): Promise<void> {
  const list = [...(await pendingSchemaChanges(db)), p]; const now = nowString();
  await run(db, "INSERT INTO `_params` (id, value, created, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated = excluded.updated", [PENDING, JSON.stringify(list), now, now]);
}

/** a schema change made from the panel, as a migration: null when automigrate is off */
export async function recordSchemaChange(env: Bindings, files: MigrationFiles | null, change: SchemaChange, before: object | null, after: object | null, now = Date.now()): Promise<Recorded | null> {
  if (!automigrateOn(env)) return null;
  const collection = String((after as { name?: string } | null)?.name ?? (before as { name?: string } | null)?.name ?? "collection");
  const file = migrationFileName(change, collection, now);
  const source = migrationSource(change, before, after);
  const recorded: Recorded = { file, written: false, committed: null, inRepository: false };
  await run(env.DB, "INSERT OR IGNORE INTO `_pbMigrations` (file, applied) VALUES (?, ?)", [file, now]);
  if (files) { files.write(file, source); recorded.written = true; }
  const repo = repoOf(env);
  if (repo) {
    try {
      const c = await commitFiles(repo, [{ path: `pb_migrations/${file}`, content: source }], `chore(schema): ${collection} ${change} from the admin panel`);
      recorded.committed = c.url; recorded.inRepository = true;
    } catch (err) { logger.error("voidbase: automigrate could not commit the migration; it is kept as pending", { file, repository: repo.fullName, error: err instanceof Error ? err.message : String(err) }); }
  }
  if (!recorded.inRepository) await keepPending(env.DB, { file, collection, change, at: nowString(), source });
  return recorded;
}
