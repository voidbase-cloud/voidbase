// Automigrate (src/server/automigrate.ts): a collection changed from the panel writes a migration that makes the same
// change and undoes it, recorded as applied here, written into pb_migrations under the name the migration loader
// gives it, and kept as not in the repository when the instance has no git connection.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileMigrationsDir } from "../../hooks-plugin";
import { d1 } from "../../src/node/d1";
import { automigrateOn, migrationFileName, migrationSource, pendingSchemaChanges, recordSchemaChange } from "../../src/server/automigrate";
import type { Bindings } from "../../src/server/types";

const ROOT = resolve(import.meta.dir, "../..");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function database() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(`${ROOT}/db/migrations`).filter((x) => x.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${ROOT}/db/migrations/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.run(s);
  }
  return d1(sqlite);
}

/** a migration's up and down, run against an app that records what they asked of it */
function run(source: string) {
  let up: (app: unknown) => unknown = () => undefined, down: (app: unknown) => unknown = () => undefined;
  new Function("migrate", source)((u: typeof up, d: typeof down) => { up = u; down = d; });
  const calls = (fn: typeof up) => { const asked: unknown[] = []; fn({ importCollections: (list: unknown, deleteMissing: boolean) => asked.push(["import", list, deleteMissing]), findCollectionByNameOrId: (id: string) => ({ id }), delete: (c: unknown) => asked.push(["delete", c]) }); return asked; };
  return { up: calls(up), down: calls(down) };
}

const vaults = { id: "pbc_vaults", name: "vaults", type: "base", fields: [{ name: "title", type: "text" }] };
const vaultsWithNote = { ...vaults, fields: [...vaults.fields, { name: "note", type: "text" }] };

test("it is off unless VOIDBASE_AUTOMIGRATE says on", () => {
  expect(automigrateOn({})).toBe(false);
  expect(automigrateOn({ VOIDBASE_AUTOMIGRATE: "on" })).toBe(true);
  expect(automigrateOn({ VOIDBASE_AUTOMIGRATE: "off" })).toBe(false);
  expect(migrationFileName("updated", "vaults", 1_789_000_000_123)).toBe("1789000000_updated_vaults.js");
});

test("each change is a migration that makes it and undoes it", () => {
  expect(run(migrationSource("created", null, vaults))).toEqual({ up: [["import", [vaults], false]], down: [["delete", { id: "pbc_vaults" }]] });
  expect(run(migrationSource("updated", vaults, vaultsWithNote))).toEqual({ up: [["import", [vaultsWithNote], false]], down: [["import", [vaults], false]] });
  expect(run(migrationSource("deleted", vaults, null))).toEqual({ up: [["delete", { id: "pbc_vaults" }]], down: [["import", [vaults], false]] });
});

test("with automigrate on and no git connection: written, recorded as applied, and not in the repository", async () => {
  const db = database(); const dir = mkdtempSync(join(tmpdir(), "vb-automigrate-")); dirs.push(dir);
  const written: Record<string, string> = {};
  const env = { DB: db, VOIDBASE_AUTOMIGRATE: "on" } as unknown as Bindings;
  const r = await recordSchemaChange(env, { write: (file, source) => { written[file] = source; Bun.write(join(dir, file), source); } }, "updated", vaults, vaultsWithNote, 1_789_000_000_000);
  expect(r).toEqual({ file: "1789000000_updated_vaults.js", written: true, committed: null, inRepository: false });
  expect(Object.keys(written)).toEqual(["1789000000_updated_vaults.js"]);
  expect((await db.prepare("SELECT file FROM `_pbMigrations`").all<{ file: string }>()).results.map((x) => x.file)).toContain("1789000000_updated_vaults.js");
  expect((await pendingSchemaChanges(db)).map((p) => [p.collection, p.change, p.file])).toEqual([["vaults", "updated", "1789000000_updated_vaults.js"]]);
  // the loader names the file the same way, so a restart finds it applied and does not run it again
  await Bun.sleep(5);
  expect(compileMigrationsDir(dir)).toContain('name: "1789000000_updated_vaults.js"');
  expect(await recordSchemaChange({ DB: db } as unknown as Bindings, null, "deleted", vaults, null)).toBeNull();
});
