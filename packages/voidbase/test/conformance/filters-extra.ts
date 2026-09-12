// Any-match operators, :each / :length modifiers, multi-value raw comparison, back-relation filters and expands
// (via) against PocketBase with a purpose-built parent/child pair.
//   bun test/conformance/filters-extra.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
class Server {
  h: Record<string, string> = {}; ids: Record<string, string> = {}; labels: Record<string, string> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object, headers: Record<string, string> = {}) { const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null }; }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) };
    for (const n of ["ks_fc", "ks_fp"]) await this.api("DELETE", `/api/collections/${n}`, undefined, this.h);
    const p = await this.api("POST", "/api/collections", { name: "ks_fp", type: "base", listRule: "", viewRule: "", fields: [{ name: "title", type: "text" }, { name: "tags", type: "select", values: ["a", "b", "c"], maxSelect: 3 }, { name: "score", type: "number" }] }, this.h);
    if (p.status !== 200) throw new Error(`${this.base} ks_fp ${p.status} ${JSON.stringify(p.json)}`);
    const pid = String(p.json!.id);
    const c = await this.api("POST", "/api/collections", { name: "ks_fc", type: "base", listRule: "", viewRule: "", fields: [{ name: "label", type: "text" }, { name: "parent", type: "relation", collectionId: pid, maxSelect: 1 }, { name: "parents", type: "relation", collectionId: pid, maxSelect: 5 }] }, this.h);
    if (c.status !== 200) throw new Error(`${this.base} ks_fc ${c.status} ${JSON.stringify(c.json)}`);
    const mk = async (label: string, coll: string, data: Record<string, unknown>) => { const r = await this.api("POST", `/api/collections/${coll}/records`, data, this.h); if (r.status !== 200) throw new Error(`${label} ${r.status} ${JSON.stringify(r.json)}`); this.ids[label] = String(r.json!.id); this.labels[String(r.json!.id)] = label; };
    await mk("p1", "ks_fp", { title: "p1", tags: ["a", "b"], score: 1 }); await mk("p2", "ks_fp", { title: "p2", tags: ["b", "c"], score: 2 }); await mk("p3", "ks_fp", { title: "p3", tags: [], score: 3 });
    await mk("c1", "ks_fc", { label: "c1", parent: this.ids.p1, parents: [this.ids.p1, this.ids.p2] }); await mk("c2", "ks_fc", { label: "c2", parent: this.ids.p2, parents: [this.ids.p2] }); await mk("c3", "ks_fc", { label: "c3", parent: this.ids.p1, parents: [] });
  }
  async teardown() { for (const n of ["ks_fc", "ks_fp"]) await this.api("DELETE", `/api/collections/${n}`, undefined, this.h); }
  map(v: unknown): unknown { if (typeof v === "string") return this.labels[v] ? `<${this.labels[v]}>` : v; if (Array.isArray(v)) return v.map((x) => this.map(x)); if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !["created", "updated", "collectionId"].includes(k)).map(([k, x]) => [k, this.map(x)])); return v; }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(52)} pb=${JSON.stringify(a).slice(0, 260)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 600)}`}`);
};
const list = (coll: string, filter: string, extra = "") => async (s: Server) => { const r = await s.api("GET", `/api/collections/${coll}/records?sort=id&filter=${encodeURIComponent(filter)}${extra}`); return r.status === 200 ? { items: ((r.json!.items as { id: string }[]).map((i) => s.labels[i.id] ?? i.id)).sort() } : { status: r.status, body: r.json }; };
try {
  await step("tags ?= 'b' (any match)", list("ks_fp", "tags ?= 'b'"));
  await step("tags ?!= 'a'", list("ks_fp", "tags ?!= 'a'"));
  await step("tags:each = 'b'", list("ks_fp", "tags:each = 'b'"));
  await step("tags:each ?= 'a'", list("ks_fp", "tags:each ?= 'a'"));
  await step("tags:each != 'a'", list("ks_fp", "tags:each != 'a'"));
  await step("tags:length > 1", list("ks_fp", "tags:length > 1"));
  await step("tags:length = 0", list("ks_fp", "tags:length = 0"));
  await step("tags = 'a' (raw JSON compare quirk)", list("ks_fp", "tags = 'a'"));
  await step("tags ~ 'a'", list("ks_fp", "tags ~ 'a'"));
  await step("tags = '' (empty list)", list("ks_fp", "tags = ''"));
  await step("score ?> 1", list("ks_fp", "score ?> 1"));
  await step("score ?<= 2 && tags ?= 'c'", list("ks_fp", "score ?<= 2 && tags ?= 'c'"));
  await step("via single relation: ks_fc_via_parent.label ?= 'c1'", list("ks_fp", "ks_fc_via_parent.label ?= 'c1'"));
  await step("via single relation: ks_fc_via_parent.label = 'c3'", list("ks_fp", "ks_fc_via_parent.label = 'c3'"));
  await step("via multiple relation: ks_fc_via_parents.label ?= 'c1'", list("ks_fp", "ks_fc_via_parents.label ?= 'c1'"));
  await step("via multiple relation: ks_fc_via_parents.label = 'c2'", list("ks_fp", "ks_fc_via_parents.label = 'c2'"));
  await step("via + length: ks_fc_via_parent.label:length > 0", list("ks_fp", "ks_fc_via_parent.label:length > 0"));
  await step("child: parent.tags ?= 'a'", list("ks_fc", "parent.tags ?= 'a'"));
  await step("child: parents.score ?= 2", list("ks_fc", "parents.score ?= 2"));
  await step("child: parents.tags:each ?= 'c'", list("ks_fc", "parents.tags:each ?= 'c'"));
  await step("child: parents.score = 2 (all match)", list("ks_fc", "parents.score = 2"));
  await step("child: parents:length = 0", list("ks_fc", "parents:length = 0"));
  await step("child: parent.title ~ 'p'", list("ks_fc", "parent.title ~ 'p'"));
  await step("expand via on parent", async (s) => { const r = await s.api("GET", `/api/collections/ks_fp/records/${s.ids.p1}?expand=ks_fc_via_parent,ks_fc_via_parents`); return s.map(r.json); });
  await step("expand nested on child", async (s) => { const r = await s.api("GET", `/api/collections/ks_fc/records/${s.ids.c1}?expand=parent,parents`); return s.map(r.json); });
  await step("expand via in list", async (s) => { const r = await s.api("GET", `/api/collections/ks_fp/records?sort=title&expand=ks_fc_via_parent`); return s.map((r.json?.items as unknown[]) ?? r.json); });
  await step("invalid via", list("ks_fp", "nope_via_parent.label = 'x'"));
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
