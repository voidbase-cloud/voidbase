// Relation cascade on delete, PocketBase vs voidbase: cascadeDelete children go, multi relations lose the id and are
// deleted only when empty, plain relations are unlinked (with `updated` bumped), required references refuse the delete.
//   bun test/conformance/cascade.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const NAMES = ["ks_q", "ks_r", "ks_m", "ks_c", "ks_p"]; // delete order (children first)

class Server {
  h: Record<string, string> = {};
  ids: Record<string, string> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: unknown) {
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...this.h, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: unknown = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: r.status, json: json as Record<string, unknown> | null };
  }
  async setup() {
    const auth = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS);
    this.h = { authorization: String(auth.json?.token) };
    for (const n of NAMES) await this.api("DELETE", `/api/collections/${n}`);
    const p = await this.api("POST", "/api/collections", { name: "ks_p", type: "base", fields: [{ name: "title", type: "text" }] });
    if (p.status !== 200) throw new Error(`${this.base} ks_p ${p.status} ${JSON.stringify(p.json)}`);
    const pid = String(p.json!.id);
    const rel = (name: string, extra: Record<string, unknown>) => ({ name, type: "relation", collectionId: pid, cascadeDelete: false, minSelect: 0, maxSelect: 1, required: false, ...extra });
    for (const [name, field] of [
      ["ks_c", rel("parent", { cascadeDelete: true })],
      ["ks_m", rel("parents", { cascadeDelete: true, maxSelect: 5 })],
      ["ks_r", rel("ref", {})],
      ["ks_q", rel("ref", { required: true })],
    ] as const) {
      const r = await this.api("POST", "/api/collections", { name, type: "base", fields: [field] });
      if (r.status !== 200) throw new Error(`${this.base} ${name} ${r.status} ${JSON.stringify(r.json)}`);
    }
    const mk = async (label: string, coll: string, data: Record<string, unknown>) => {
      const r = await this.api("POST", `/api/collections/${coll}/records`, data);
      if (r.status !== 200) throw new Error(`${this.base} ${label} ${r.status} ${JSON.stringify(r.json)}`);
      this.ids[label] = String(r.json!.id);
    };
    await mk("p1", "ks_p", { title: "p1" }); await mk("p2", "ks_p", { title: "p2" });
    await mk("c1", "ks_c", { parent: this.ids.p1 });
    await mk("m1", "ks_m", { parents: [this.ids.p1, this.ids.p2] }); await mk("m2", "ks_m", { parents: [this.ids.p1] });
    await mk("r1", "ks_r", { ref: this.ids.p1 }); await mk("q1", "ks_q", { ref: this.ids.p2 });
  }
  async teardown() { for (const n of NAMES) await this.api("DELETE", `/api/collections/${n}`); }
  // maps this server's ids back to labels so responses compare across servers
  label(v: unknown): unknown {
    if (typeof v === "string") { for (const [k, id] of Object.entries(this.ids)) if (v === id) return `<${k}>`; return v; }
    if (Array.isArray(v)) return v.map((x) => this.label(x));
    return v;
  }
}

const pb = new Server(PB), vb = new Server(VB);
await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb), run(vb)]);
  const same = JSON.stringify(a) === JSON.stringify(b);
  same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(40)} pb=${JSON.stringify(a)}${same ? "" : `\n      vb=${JSON.stringify(b)}`}`);
};
const get = (coll: string, label: string, field?: string) => async (s: Server) => {
  const r = await s.api("GET", `/api/collections/${coll}/records/${s.ids[label]}`);
  return field ? { status: r.status, [field]: s.label(r.json?.[field]), bumped: r.json ? r.json.updated !== r.json.created : null } : { status: r.status };
};
const del = (coll: string, label: string) => async (s: Server) => { const r = await s.api("DELETE", `/api/collections/${coll}/records/${s.ids[label]}`); return { status: r.status, body: r.json }; };
try {
  await step("delete p1", del("ks_p", "p1"));
  await step("c1 cascaded away", get("ks_c", "c1"));
  await step("m1 keeps p2 only", get("ks_m", "m1", "parents"));
  await step("m2 cascaded away (list became empty)", get("ks_m", "m2"));
  await step("r1 unlinked", get("ks_r", "r1", "ref"));
  await step("delete p2 refused (q1 requires it)", del("ks_p", "p2"));
  await step("p2 still there", get("ks_p", "p2"));
  await step("m1 untouched by the refused delete", get("ks_m", "m1", "parents"));
  await step("delete q1", del("ks_q", "q1"));
  await step("delete p2", del("ks_p", "p2"));
  await step("m1 cascaded away", get("ks_m", "m1"));
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
