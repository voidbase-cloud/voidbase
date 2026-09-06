// Exports everything from a running voidbase into a directory you can take elsewhere:
//   <out>/data.db           SQLite file with the same tables and columns as PocketBase (user collections, _collections,
//                           _params, _externalAuths, _authOrigins, _mfas, _otps), rows copied verbatim (password hashes included)
//   <out>/collections.json  the collections in PocketBase's import format (Settings > Import collections)
//   <out>/storage/          every uploaded file under {collectionId}/{recordId}/{filename}
// Reads through the superuser API only (POST /api/sql, GET /api/files), so it works against a deployed instance.
//   bun scripts/export.ts <url> <outDir> [superuserEmail] [superuserPassword]
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
const [url, out, email = process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com", password = process.env.VOIDBASE_SUPERUSER_PASSWORD ?? "changeme123"] = process.argv.slice(2);
if (!url || !out) { console.error("usage: bun scripts/export.ts <url> <outDir> [email] [password]"); process.exit(1); }
const base = url.replace(/\/$/, "");
const auth = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: email, password }) });
if (auth.status !== 200) { console.error(`superuser login failed: ${auth.status} ${await auth.text()}`); process.exit(1); }
const token = ((await auth.json()) as { token: string }).token;
const H = { authorization: token, "content-type": "application/json" };
async function sql(query: string): Promise<{ columns: { name: string; type: string }[]; rows: (string | null)[][] }> {
  const r = await fetch(`${base}/api/sql`, { method: "POST", headers: H, body: JSON.stringify({ query }) });
  if (r.status !== 200) throw new Error(`sql failed (${r.status}): ${query.slice(0, 80)} -> ${await r.text()}`);
  return (await r.json()) as { columns: { name: string; type: string }[]; rows: (string | null)[][] };
}
const collections = ((await fetch(`${base}/api/collections?perPage=500&sort=+created`, { headers: H }).then((r) => r.json())) as { items: Record<string, unknown>[] }).items;
if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/storage`, { recursive: true });
writeFileSync(`${out}/collections.json`, JSON.stringify(collections, null, 2));
const db = new Database(`${out}/data.db`, { create: true });
// system auth collections (_externalAuths, _authOrigins, _mfas, _otps) are collections too, so dedupe
const tables = [...new Set([...collections.filter((c) => c.type !== "view").map((c) => String(c.name)), "_collections", "_params", "_externalAuths", "_authOrigins", "_mfas", "_otps"])];
let files = 0, rows = 0;
for (const table of tables) {
  const info = await sql(`PRAGMA table_info("${table}")`);
  if (!info.rows.length) { console.warn(`skip ${table}: no such table`); continue; }
  const cols = info.rows.map((r) => ({ name: String(r[1]), type: String(r[2] ?? ""), pk: r[5] === "1" }));
  db.run(`CREATE TABLE "${table}" (${cols.map((c) => `"${c.name}" ${c.type}${c.pk ? " PRIMARY KEY" : ""}`).join(", ")})`);
  const insert = db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c.name}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const coll = collections.find((c) => c.name === table);
  const fileFields = ((coll?.fields as { name: string; type: string }[] | undefined) ?? []).filter((f) => f.type === "file").map((f) => f.name);
  let after = 0;
  for (;;) {
    const page = await sql(`SELECT rowid AS __rowid, ${cols.map((c) => `"${c.name}"`).join(", ")} FROM "${table}" WHERE rowid > ${after} ORDER BY rowid LIMIT 1000`);
    if (!page.rows.length) break;
    db.transaction(() => { for (const r of page.rows) insert.run(...r.slice(1)); })();
    rows += page.rows.length; after = Number(page.rows.at(-1)![0]);
    for (const r of page.rows) {
      const rec = Object.fromEntries(cols.map((c, i) => [c.name, r[i + 1]]));
      for (const f of fileFields) {
        let names: string[] = []; const raw = rec[f]; if (!raw) continue;
        try { const parsed = JSON.parse(String(raw)); names = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]; } catch { names = [String(raw)]; }
        for (const name of names) {
          const res = await fetch(`${base}/api/files/${coll!.id}/${rec.id}/${encodeURIComponent(name)}?download=1`, { headers: { authorization: token } });
          if (res.status !== 200) { console.warn(`file ${table}/${rec.id}/${name}: HTTP ${res.status}`); continue; }
          mkdirSync(`${out}/storage/${coll!.id}/${rec.id}`, { recursive: true });
          writeFileSync(`${out}/storage/${coll!.id}/${rec.id}/${name}`, new Uint8Array(await res.arrayBuffer())); files++;
        }
      }
    }
    if (page.rows.length < 1000) break;
  }
}
for (const c of collections.filter((c) => c.type === "view")) { try { db.run(`CREATE VIEW "${c.name}" AS ${String(c.viewQuery ?? "")}`); } catch (e) { console.warn(`view ${c.name} not recreated: ${e instanceof Error ? e.message : e}`); } }
db.close();
writeFileSync(`${out}/README.txt`, `voidbase export from ${base} at ${new Date().toISOString()}\n\ndata.db          SQLite: one table per collection with PocketBase's column layout, plus _collections/_params/_externalAuths/_authOrigins/_mfas/_otps\ncollections.json PocketBase collections import format (Settings > Import collections in any PocketBase or voidbase)\nstorage/         uploaded files as {collectionId}/{recordId}/{filename}\n\nTo move to PocketBase: import collections.json, then load rows from data.db (same table and column names) and copy storage/ into pb_data/storage/.\n`);
console.log(`exported ${collections.length} collections, ${rows} rows, ${files} files to ${out}`);
