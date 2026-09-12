// View collections against PocketBase: field inference from the SELECT (clones of source fields, relation for a
// source id, number for count/total, CAST types, json fallback), read-only records, and the query error messages.
//   bun test/conformance/views.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
class Server {
  h: Record<string, string> = {}; ids: Record<string, string> = {}; labels: Record<string, string> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object) { const r = await fetch(`${this.base}${path}`, { method, headers: { ...this.h, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null }; }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) };
    for (const n of ["ks_vw", "ks_vc", "ks_vp"]) await this.api("DELETE", `/api/collections/${n}`);
    const p = await this.api("POST", "/api/collections", { name: "ks_vp", type: "base", listRule: "", viewRule: "", fields: [{ name: "title", type: "text", max: 50 }, { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 }, { name: "score", type: "number" }, { name: "flag", type: "bool" }, { name: "happened", type: "date" }] });
    if (p.status !== 200) throw new Error(`${this.base} ks_vp ${p.status} ${JSON.stringify(p.json)}`);
    const c = await this.api("POST", "/api/collections", { name: "ks_vc", type: "base", listRule: "", fields: [{ name: "label", type: "text" }, { name: "parent", type: "relation", collectionId: String(p.json!.id), maxSelect: 1 }] });
    if (c.status !== 200) throw new Error(`${this.base} ks_vc ${c.status}`);
    const mk = async (label: string, coll: string, data: Record<string, unknown>) => { const r = await this.api("POST", `/api/collections/${coll}/records`, data); if (r.status !== 200) throw new Error(`${label} ${JSON.stringify(r.json)}`); this.ids[label] = String(r.json!.id); this.labels[String(r.json!.id)] = label; };
    await mk("p1", "ks_vp", { title: "first", tags: ["a"], score: 1.5, flag: true, happened: "2026-01-02 03:04:05.000Z" }); await mk("p2", "ks_vp", { title: "second", tags: ["a", "b"], score: 2 });
    await mk("c1", "ks_vc", { label: "c1", parent: this.ids.p1 }); await mk("c2", "ks_vc", { label: "c2", parent: this.ids.p1 });
  }
  async teardown() { for (const n of ["ks_vw", "ks_vc", "ks_vp"]) await this.api("DELETE", `/api/collections/${n}`); }
  norm(v: unknown): unknown { if (typeof v === "string") return this.labels[v] ? `<${this.labels[v]}>` : v; if (Array.isArray(v)) return v.map((x) => this.norm(x)); if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !["created", "updated", "collectionId", "id"].includes(k)).map(([k, x]) => [k, this.norm(x)])); return v; }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(44)} pb=${JSON.stringify(a).slice(0, 400)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 900)}`}`);
};
const QUERY = "SELECT p.id, p.title AS name, p.score, p.tags, p.flag, p.happened, COUNT(c.id) AS children, TOTAL(p.score) AS total_score, CAST(p.score AS TEXT) AS score_text, CAST(p.score AS INTEGER) AS score_int, (p.score * 2) AS doubled, c.parent AS parent_ref, (p.title || '!') AS shout FROM ks_vp p LEFT JOIN ks_vc c ON c.parent = p.id GROUP BY p.id";
const fieldShape = (f: Record<string, unknown>) => { const { id: _id, ...rest } = f; return rest; };
try {
  await step("create view collection: fields inferred", async (s) => { const r = await s.api("POST", "/api/collections", { name: "ks_vw", type: "view", listRule: "", viewRule: "", viewQuery: QUERY }); return r.status === 200 ? { status: r.status, fields: (r.json!.fields as Record<string, unknown>[]).map((f) => s.norm(fieldShape(f))) } : { status: r.status, body: r.json }; });
  await step("view records", async (s) => { const r = await s.api("GET", "/api/collections/ks_vw/records?sort=name"); return s.norm(r.json?.items ?? r.json); });
  await step("view records are read-only", async (s) => { const r = await s.api("POST", "/api/collections/ks_vw/records", { name: "x" }); return { status: r.status, body: r.json }; });
  await step("filter on an inferred number", async (s) => { const r = await s.api("GET", `/api/collections/ks_vw/records?filter=${encodeURIComponent("children > 1")}`); return s.norm(((r.json?.items as { name: string }[]) ?? []).map((i) => i.name)); });
  await step("expand the inferred relation", async (s) => { const r = await s.api("GET", "/api/collections/ks_vw/records?sort=name&expand=parent_ref"); return s.norm(((r.json?.items as Record<string, unknown>[]) ?? []).map((i) => ({ name: i.name, expand: i.expand }))); });
  await step("update view query: fields re-derived", async (s) => { const r = await s.api("PATCH", "/api/collections/ks_vw", { viewQuery: "SELECT id, title, score FROM ks_vp" }); return r.status === 200 ? { status: r.status, fields: (r.json!.fields as Record<string, unknown>[]).map((f) => s.norm(fieldShape(f))) } : { status: r.status, body: r.json }; });
  await step("missing id column", async (s) => { const r = await s.api("PATCH", "/api/collections/ks_vw", { viewQuery: "SELECT title FROM ks_vp" }); return { status: r.status, body: r.json }; });
  await step("wildcard columns", async (s) => { const r = await s.api("PATCH", "/api/collections/ks_vw", { viewQuery: "SELECT * FROM ks_vp" }); return { status: r.status, body: r.json }; });
  await step("invalid sql", async (s) => { const r = await s.api("PATCH", "/api/collections/ks_vw", { viewQuery: "SELECT id FROM nope_table" }); return { status: r.status, keys: Object.keys((r.json?.data as object) ?? {}).sort(), code: (r.json?.data as { viewQuery?: { code: string } })?.viewQuery?.code, msgPrefix: String((r.json?.data as { viewQuery?: { message: string } })?.viewQuery?.message ?? "").slice(0, 16) }; });
  await step("create with an expression PocketBase's parser rejects", async (s) => { const r = await s.api("POST", "/api/collections", { name: "ks_vw2", type: "view", viewQuery: "SELECT id, title || '!' AS shout FROM ks_vp" }); await s.api("DELETE", "/api/collections/ks_vw2"); return { status: r.status, keys: Object.keys((r.json?.data as object) ?? {}).sort() }; });
  await step("row_number id", async (s) => { const r = await s.api("PATCH", "/api/collections/ks_vw", { viewQuery: "SELECT (ROW_NUMBER() OVER()) as id, title FROM ks_vp" }); const l = await s.api("GET", "/api/collections/ks_vw/records?sort=title"); return { status: r.status, fields: (r.json?.fields as Record<string, unknown>[] | undefined)?.map((f) => s.norm(fieldShape(f))), items: s.norm(l.json?.items) }; });
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
