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

test("with a git connection the migration is committed to the branch, and when GitHub fails it stays pending", async () => {
  const seen: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let failing = false;
  const github = Bun.serve({ port: 0, fetch: async (req) => {
    const path = new URL(req.url).pathname; const body = req.method === "GET" ? null : ((await req.json()) as Record<string, unknown>);
    seen.push({ method: req.method, path, body });
    if (failing) return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    if (path === "/repos/me/app/git/ref/heads/master") return Response.json({ object: { sha: "head1" } });
    if (path === "/repos/me/app/git/commits/head1") return Response.json({ tree: { sha: "tree1" } });
    if (path === "/repos/me/app/git/blobs") return Response.json({ sha: "blob1" });
    if (path === "/repos/me/app/git/trees") return Response.json({ sha: "tree2" });
    if (path === "/repos/me/app/git/commits") return Response.json({ sha: "commit2", html_url: "https://github.com/me/app/commit/commit2" });
    if (path === "/repos/me/app/git/refs/heads/master") return Response.json({ ref: "refs/heads/master" });
    return new Response("not found", { status: 404 });
  } });
  try {
    const db = database();
    const env = { DB: db, VOIDBASE_AUTOMIGRATE: "on", VOIDBASE_PROJECT_REPO: "me/app", VOIDBASE_GH_TOKEN: "t", GITHUB_API_BASE: `http://127.0.0.1:${github.port}` } as unknown as Bindings;
    const r = await recordSchemaChange(env, null, "created", null, vaults, 1_789_000_100_000);
    expect(r).toEqual({ file: "1789000100_created_vaults.js", written: false, committed: "https://github.com/me/app/commit/commit2", inRepository: true });
    expect(seen.find((s) => s.path.endsWith("/git/blobs"))?.body?.content).toBe(migrationSource("created", null, vaults));
    expect(seen.find((s) => s.path.endsWith("/git/trees"))?.body).toEqual({ base_tree: "tree1", tree: [{ path: "pb_migrations/1789000100_created_vaults.js", mode: "100644", type: "blob", sha: "blob1" }] });
    expect(seen.find((s) => s.method === "PATCH")?.body).toEqual({ sha: "commit2", force: false });
    expect(await pendingSchemaChanges(db)).toEqual([]);

    failing = true;
    const kept = await recordSchemaChange(env, null, "deleted", vaults, null, 1_789_000_200_000);
    expect(kept).toMatchObject({ committed: null, inRepository: false });
    expect((await pendingSchemaChanges(db)).map((p) => p.file)).toEqual(["1789000200_deleted_vaults.js"]);
  } finally { github.stop(true); }
});
