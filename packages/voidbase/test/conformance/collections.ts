// Scenario conformance for the collections engine.
//   bun test/conformance/collections.ts [--vb http://127.0.0.1:5180] [--pb-fixtures test/fixtures/pb]
// 1) imports the starter's collections snapshot and compares GET /api/collections with the reference list
// 2) replays the recorded kitchen-sink lifecycle (create, view, update, rename, truncate, delete, errors)
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "1"] : [])).filter((x) => x.length));
const VB = args.vb ?? "http://127.0.0.1:5180";
const FX = args["pb-fixtures"] ?? "test/fixtures/pb";
const read = async (p: string) => JSON.parse(await Bun.file(p).text());

const VOLATILE = new Set(["created", "updated", "token", "tokenKey", "exp", "secret"]);
function mask(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => mask(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, VOLATILE.has(k) ? typeof x : mask(x, k)]));
  if (typeof v === "string") {
    return v.replace(/(idx_[A-Za-z]+_)[a-z0-9]{10}/g, "$1<rand>")
      .replace(/(existing reference in )([^.]+)\./, (_m, p, list: string) => p + list.split(", ").sort().join(", ") + ".");
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(mask(a)) === JSON.stringify(mask(b));

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: () => string) {
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); if (detail) console.log("   " + detail()); }
}
function firstDiff(a: unknown, b: unknown): string {
  const sa = String(JSON.stringify(mask(a))), sb = String(JSON.stringify(mask(b)));
  let i = 0; while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  return `expected …${sa.slice(Math.max(0, i - 80), i + 160)}\n   got      …${sb.slice(Math.max(0, i - 80), i + 160)}`;
}

const login = await fetch(`${VB}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: "changeme123" }) });
const token = ((await login.json()) as { token: string }).token;
const H = { Authorization: token, "content-type": "application/json" };
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(VB + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

// clean slate for the replay
for (const n of ["ks_all", "ks_all2", "1bad", "undefined", "ks_rec"]) await call("DELETE", `/api/collections/${n}`);

// 1) import the starter snapshot
const starterDir = process.env.STARTER_DIR ?? "../pocketbase-sveltekit-starter";  // scripts/ci-oracles.sh exports it
const snapshotSrc = await Bun.file(`${starterDir}/pb/pb_migrations/1774379551_collections_snapshot.js`).text();
const snapshot = JSON.parse(/(\[\s*\{[\s\S]*\}\s*\])/.exec(snapshotSrc)![1]!);
const imp = await call("PUT", "/api/collections/import", { collections: snapshot, deleteMissing: false });
check("import starter snapshot -> 204", imp.status === 204, () => JSON.stringify(imp.json));
const refList = await read(`${FX}/collections-list.json`);
const list = await call("GET", "/api/collections?page=1&perPage=500&sort=%2Bname&skipTotal=1");
const refNames = (refList.items as { name: string }[]).map((c) => c.name);
const gotNames = ((list.json as { items: { name: string }[] }).items ?? []).map((c) => c.name);
check("collections list names match reference", JSON.stringify(refNames) === JSON.stringify(gotNames), () => `expected ${refNames}\n   got ${gotNames}`);
for (const ref of refList.items as { name: string }[]) {
  const got = ((list.json as { items: { name: string }[] }).items ?? []).find((c) => c.name === ref.name);
  check(`collection ${ref.name} JSON matches reference`, !!got && same(ref, got), () => firstDiff(ref, got));
}

// 2) kitchen sink replay
const resCreate = await read(`${FX}/collections/res-create.json`);
const create = await call("POST", "/api/collections", await read(`${FX}/collections/req-create.json`));
check("create ks_all", create.status === 200 && same(resCreate, create.json), () => `${create.status} ${firstDiff(resCreate, create.json)}`);
const resView = await read(`${FX}/collections/res-view.json`);
const view = await call("GET", "/api/collections/ks_all");
check("view ks_all", same(resView, view.json), () => firstDiff(resView, view.json));
const recs = await call("GET", "/api/collections/ks_all/records?perPage=1");
check("records of new collection", same(await read(`${FX}/collections/res-records-empty.json`), recs.json), () => JSON.stringify(recs.json));
for (const [n, expectStatus] of [["dup", 400], ["badname", 200], ["badfield", 400], ["noname", 400], ["reservedfield", 400]] as const) {
  const r = await call("POST", "/api/collections", await read(`${FX}/collections/req-create-${n}.json`));
  const ref = await read(`${FX}/collections/res-create-${n}.json`);
  check(`create ${n} -> ${expectStatus}`, r.status === expectStatus && same(ref, r.json), () => `${r.status} ${firstDiff(ref, r.json)}`);
}
await call("DELETE", "/api/collections/1bad");
const resUpdate = await read(`${FX}/collections/res-update.json`);
const upd = await call("PATCH", "/api/collections/ks_all", await read(`${FX}/collections/req-update.json`));
check("update ks_all (rename field, add, remove, select multi)", upd.status === 200 && same(resUpdate, upd.json), () => `${upd.status} ${firstDiff(resUpdate, upd.json)}`);
const cols = await call("GET", "/api/collections/ks_all/records?perPage=1");
check("records still listable after sync", cols.status === 200, () => JSON.stringify(cols.json));
const resRename = await read(`${FX}/collections/res-rename.json`);
const ren = await call("PATCH", "/api/collections/ks_all", await read(`${FX}/collections/req-rename.json`));
check("rename collection rewrites indexes", ren.status === 200 && same(resRename, ren.json), () => `${ren.status} ${firstDiff(resRename, ren.json)}`);
const tr = await call("DELETE", "/api/collections/ks_all2/truncate");
check("truncate -> 204", tr.status === 204, () => JSON.stringify(tr.json));
const del = await call("DELETE", "/api/collections/ks_all2");
check("delete -> 204", del.status === 204, () => JSON.stringify(del.json));
const delSys = await call("DELETE", "/api/collections/_superusers");
check("delete system -> 400", same(await read(`${FX}/collections/res-delete-system.json`), delSys.json), () => JSON.stringify(delSys.json));
const resDelRef = await read(`${FX}/collections/res-delete-referenced.json`);
const delRef = await call("DELETE", "/api/collections/users");
check("delete referenced -> 400", same(resDelRef, delRef.json), () => firstDiff(resDelRef, delRef.json));
const gone = await call("GET", "/api/collections/ks_all2");
check("deleted collection is 404", gone.status === 404);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
