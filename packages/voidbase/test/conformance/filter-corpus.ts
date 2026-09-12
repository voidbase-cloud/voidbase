// Generated filter corpus: every operator against every field type with several values, plus modifiers, relation
// paths, back-relations, JSON paths, macros and boolean combinations. Same request at the reference PocketBase and
// voidbase; the matched record labels (or the error status) must be identical.
//   bun test/conformance/filter-corpus.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180] [--verbose]
const PB = process.argv[2] ?? "http://127.0.0.1:8090"; const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const VERBOSE = process.argv.includes("--verbose");
const CREDS = { identity: "admin@example.com", password: "changeme123" };
class Server {
  h: Record<string, string> = {}; ids: Record<string, string> = {}; labels: Record<string, string> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: Record<string, unknown> | null = null; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json };
  }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) };
    for (const n of ["ks_fx", "ks_fx_p"]) await this.api("DELETE", `/api/collections/${n}`, undefined, this.h);
    const p = await this.api("POST", "/api/collections", { name: "ks_fx_p", type: "base", listRule: "", viewRule: "", fields: [{ name: "name", type: "text" }, { name: "score", type: "number" }] }, this.h);
    if (p.status !== 200) throw new Error(`${this.base} ks_fx_p ${p.status} ${JSON.stringify(p.json)}`);
    const pid = String(p.json!.id);
    const c = await this.api("POST", "/api/collections", { name: "ks_fx", type: "base", listRule: "", viewRule: "", fields: [
      { name: "title", type: "text" }, { name: "n", type: "number" }, { name: "flag", type: "bool" }, { name: "mail", type: "email" }, { name: "site", type: "url" },
      { name: "when", type: "date" }, { name: "tag", type: "select", values: ["a", "b", "c"], maxSelect: 1 }, { name: "tags", type: "select", values: ["a", "b", "c"], maxSelect: 3 },
      { name: "meta", type: "json", maxSize: 2000 }, { name: "rel", type: "relation", collectionId: pid, maxSelect: 1 }, { name: "rels", type: "relation", collectionId: pid, maxSelect: 5 },
    ] }, this.h);
    if (c.status !== 200) throw new Error(`${this.base} ks_fx ${c.status} ${JSON.stringify(c.json)}`);
    const mk = async (label: string, coll: string, data: Record<string, unknown>) => { const r = await this.api("POST", `/api/collections/${coll}/records`, data, this.h); if (r.status !== 200) throw new Error(`${this.base} ${label}: ${r.status} ${JSON.stringify(r.json)}`); this.ids[label] = String(r.json!.id); this.labels[this.ids[label]!] = label; };
    await mk("p1", "ks_fx_p", { name: "Alpha", score: 1 }); await mk("p2", "ks_fx_p", { name: "beta", score: 2 }); await mk("p3", "ks_fx_p", { name: "", score: 0 });
    await mk("r1", "ks_fx", { title: "Hello World", n: 1, flag: true, mail: "a@example.com", site: "https://a.example.com/x", when: "2026-01-01 10:00:00.000Z", tag: "a", tags: ["a", "b"], meta: { k: "x", num: 1, arr: [1, 2], nested: { j: true } }, rel: this.ids.p1, rels: [this.ids.p1, this.ids.p2] });
    await mk("r2", "ks_fx", { title: "hello", n: 2.5, flag: false, mail: "b@example.com", site: "http://b.example.com", when: "2026-01-02 00:00:00.000Z", tag: "b", tags: ["b", "c"], meta: "plain", rel: this.ids.p2, rels: [this.ids.p2] });
    await mk("r3", "ks_fx", { title: "", n: 0, flag: false, mail: "", site: "", when: "", tag: "", tags: [], meta: null, rel: "", rels: [] });
    await mk("r4", "ks_fx", { title: "10", n: -1, flag: true, mail: "c@example.com", site: "https://c.example.com", when: "2020-05-05 05:05:05.000Z", tag: "c", tags: ["a"], meta: [1, "two", null], rel: this.ids.p3, rels: [this.ids.p1, this.ids.p2, this.ids.p3] });
    await mk("r5", "ks_fx", { title: "a'b\"c", n: 100, flag: true, mail: "d@example.com", site: "https://d.example.com/?q=1", when: "2030-12-31 23:59:59.000Z", tag: "a", tags: ["c"], meta: 42, rel: this.ids.p1, rels: [this.ids.p3] });
    await mk("r6", "ks_fx", { title: "Hello World", n: 1, flag: false, mail: "e@example.com", site: "https://e.example.com", when: "2026-01-01 10:00:00.000Z", tag: "b", tags: ["a", "b", "c"], meta: { k: "y", num: 2 }, rel: this.ids.p2, rels: [] });
  }
  async teardown() { for (const n of ["ks_fx", "ks_fx_p"]) await this.api("DELETE", `/api/collections/${n}`, undefined, this.h); }
  async run(coll: string, filter: string, superuser: boolean) {
    const f = filter.replace(/\{(p\d|r\d)\}/g, (_m, l: string) => this.ids[l] ?? l);
    const r = await this.api("GET", `/api/collections/${coll}/records?perPage=50&sort=created,id&filter=${encodeURIComponent(f)}`, undefined, superuser ? this.h : {});
    if (r.status !== 200) return `${r.status} ${String(r.json?.message ?? "")}`;
    return ((r.json?.items as { id: string }[]) ?? []).map((i) => this.labels[i.id] ?? "?").sort().join(",") || "(none)";
  }
}
const OPS = ["=", "!=", ">", "<", ">=", "<=", "~", "!~", "?=", "?!=", "?>", "?<", "?>=", "?<=", "?~", "?!~"];
const q = (v: unknown) => typeof v === "string" ? `'${v.replace(/'/g, "\\'")}'` : String(v);
const VALUES: Record<string, unknown[]> = {
  title: ["Hello World", "hello", "", "10", "a'b\"c", 10, "%", "Hello%"],
  n: [0, 1, 2.5, -1, "1", "", 100, "abc"],
  flag: [true, false, 1, 0, "true", ""],
  mail: ["a@example.com", "", "example.com"],
  site: ["https://a.example.com/x", "", "example"],
  when: ["2026-01-01 10:00:00.000Z", "2026-01-01", "2026-01-01 10:00:00", "", "2025-06-01 00:00:00.000Z", "2026-01-02 00:00:00.000Z"],
  tag: ["a", "b", "", "z"],
  tags: ["a", "b", "", "z", '["a","b"]'],
  meta: ["x", "plain", 42, 1, "", null, true, "[1,\"two\",null]"],
  rel: ["{p1}", "{p2}", "", "nope"],
  rels: ["{p1}", "{p3}", "", '["{p1}","{p2}"]'],
  id: ["{r1}", "", "nope"],
  created: ["2000-01-01 00:00:00.000Z", "", "2100-01-01 00:00:00.000Z"],
};
interface Case { coll: string; filter: string; superuser?: boolean }
const cases: Case[] = [];
for (const [field, values] of Object.entries(VALUES)) for (const op of OPS) for (const v of values) cases.push({ coll: "ks_fx", filter: `${field} ${op} ${q(v)}` });
// modifiers
for (const op of ["=", "!=", "~", "?="]) for (const v of ["hello world", "hello", "", "HELLO"]) cases.push({ coll: "ks_fx", filter: `title:lower ${op} ${q(v)}` });
for (const op of ["=", "!=", ">", "<", ">=", "<=", "?=", "?>"]) for (const v of [0, 1, 2, 3]) { cases.push({ coll: "ks_fx", filter: `tags:length ${op} ${v}` }); cases.push({ coll: "ks_fx", filter: `rels:length ${op} ${v}` }); }
for (const op of ["=", "!=", "~", "?=", "?!="]) for (const v of ["a", "b", "c", "", "z"]) cases.push({ coll: "ks_fx", filter: `tags:each ${op} ${q(v)}` });
for (const op of ["=", "!=", "?=", "?!="]) for (const v of ["{p1}", "{p2}", "{p3}", ""]) cases.push({ coll: "ks_fx", filter: `rels:each ${op} ${q(v)}` });
// relation paths and back-relations
for (const op of ["=", "!=", "~", "?=", "?!=", ">", "<"]) {
  for (const v of ["Alpha", "beta", "", "alpha"]) { cases.push({ coll: "ks_fx", filter: `rel.name ${op} ${q(v)}` }); cases.push({ coll: "ks_fx", filter: `rels.name ${op} ${q(v)}` }); }
  for (const v of [0, 1, 2, "1"]) { cases.push({ coll: "ks_fx", filter: `rel.score ${op} ${q(v)}` }); cases.push({ coll: "ks_fx", filter: `rels.score ${op} ${q(v)}` }); }
  for (const v of ["Hello World", "", "hello"]) { cases.push({ coll: "ks_fx_p", filter: `ks_fx_via_rel.title ${op} ${q(v)}` }); cases.push({ coll: "ks_fx_p", filter: `ks_fx_via_rels.title ${op} ${q(v)}` }); }
  for (const v of [0, 1, 100]) { cases.push({ coll: "ks_fx_p", filter: `ks_fx_via_rel.n ${op} ${v}` }); cases.push({ coll: "ks_fx_p", filter: `ks_fx_via_rels.n ${op} ${v}` }); }
}
cases.push({ coll: "ks_fx", filter: "rel.name:lower = 'alpha'" }, { coll: "ks_fx", filter: "rels.name:lower ?= 'alpha'" }, { coll: "ks_fx", filter: "rel.name:length > 0" }, { coll: "ks_fx", filter: "rel.id = '{p1}'" }, { coll: "ks_fx", filter: "rel.id != ''" }, { coll: "ks_fx", filter: "rels.id ?= '{p3}'" }, { coll: "ks_fx_p", filter: "ks_fx_via_rels.rel.name ?= 'Alpha'" }, { coll: "ks_fx_p", filter: "ks_fx_via_rel.rels.score ?> 1" });
// json paths
for (const op of ["=", "!=", ">", "<", "~", "?="]) for (const path of ["meta.k", "meta.num", "meta.nested.j", "meta.arr", "meta.arr.0", "meta.missing"]) for (const v of ["x", 1, true, "", null]) cases.push({ coll: "ks_fx", filter: `${path} ${op} ${q(v)}` });
// macros and literals
for (const m of ["@now", "@todayStart", "@todayEnd", "@monthStart", "@monthEnd", "@yearStart", "@yearEnd", "@second", "@minute", "@hour", "@weekday", "@day", "@month", "@year"]) for (const op of ["<", ">", "=", "!="]) cases.push({ coll: "ks_fx", filter: `when ${op} ${m}` });
for (const f of ["title", "n", "flag", "when", "tag", "tags", "meta", "rel", "rels"]) for (const lit of ["null", "true", "false"]) for (const op of ["=", "!=", "?="]) cases.push({ coll: "ks_fx", filter: `${f} ${op} ${lit}` });
// field vs field, combinations, grouping, whitespace and syntax errors
cases.push(
  { coll: "ks_fx", filter: "title = title" }, { coll: "ks_fx", filter: "n = rel.score" }, { coll: "ks_fx", filter: "n > rel.score" }, { coll: "ks_fx", filter: "rels.score ?= n" }, { coll: "ks_fx", filter: "tag = tags" }, { coll: "ks_fx", filter: "tags ?= tag" }, { coll: "ks_fx", filter: "tag ?= tags" },
  { coll: "ks_fx", filter: "flag = true && n > 0" }, { coll: "ks_fx", filter: "flag = true || n > 50" }, { coll: "ks_fx", filter: "(flag = true || n > 50) && tag = 'a'" }, { coll: "ks_fx", filter: "flag = true || n > 50 && tag = 'a'" }, { coll: "ks_fx", filter: "((n > 0))" },
  { coll: "ks_fx", filter: "  title   =   'hello'  " }, { coll: "ks_fx", filter: "title='hello'" }, { coll: "ks_fx", filter: "title =\n'hello'" }, { coll: "ks_fx", filter: "title = \"hello\"" }, { coll: "ks_fx", filter: "title ~ 'Hello'" }, { coll: "ks_fx", filter: "title ~ 'o W'" }, { coll: "ks_fx", filter: "title ~ '%'" }, { coll: "ks_fx", filter: "title ~ '_'" }, { coll: "ks_fx", filter: "title ~ '\\%'" }, { coll: "ks_fx", filter: "title !~ ''" },
  { coll: "ks_fx", filter: "" }, { coll: "ks_fx", filter: "title" }, { coll: "ks_fx", filter: "title =" }, { coll: "ks_fx", filter: "= 'x'" }, { coll: "ks_fx", filter: "title == 'x'" }, { coll: "ks_fx", filter: "title = 'x' &&" }, { coll: "ks_fx", filter: "title = 'x' & n = 1" }, { coll: "ks_fx", filter: "title = 'x' AND n = 1" }, { coll: "ks_fx", filter: "(title = 'x'" }, { coll: "ks_fx", filter: "title = 'x')" }, { coll: "ks_fx", filter: "nope = 1" }, { coll: "ks_fx", filter: "rel.nope = 1" }, { coll: "ks_fx", filter: "title.x = 1" }, { coll: "ks_fx", filter: "title:nope = 'x'" }, { coll: "ks_fx", filter: "n:lower = 1" }, { coll: "ks_fx", filter: "tags:each:length = 1" }, { coll: "ks_fx", filter: "@nope = 1" }, { coll: "ks_fx", filter: "title = 'unterminated" }, { coll: "ks_fx", filter: "1 = 1" }, { coll: "ks_fx", filter: "'a' = 'a'" }, { coll: "ks_fx", filter: "true" }, { coll: "ks_fx", filter: "n = 1e2" }, { coll: "ks_fx", filter: "n = .5" }, { coll: "ks_fx", filter: "n = -1" }, { coll: "ks_fx", filter: "n = - 1" }, { coll: "ks_fx", filter: "n > 1.0" },
);
// @request.* as superuser (the anonymous case is a 403 checked in security.ts) and @collection.*
for (const f of ["@request.auth.id != ''", "@request.auth.id = ''", "@request.auth.email != ''", "@request.auth.collectionName = '_superusers'", "@request.auth.verified = true", "@request.method = 'GET'", "@request.method != 'POST'", "@request.context = 'default'", "@request.query.perPage = 50", "@request.query.perPage = '50'", "@request.query.nope = ''", "@request.query.nope:isset = false", "@request.headers.x_nope = ''", "@request.body.title = ''", "@request.body.title:isset = false", "@request.auth.nope = ''", "@collection.ks_fx_p.name ?= 'Alpha'", "@collection.ks_fx_p.score ?> 1", "@collection.ks_fx_p.name = 'Alpha'", "@collection.ks_fx_p:alias.name ?= 'beta' && @collection.ks_fx_p:alias.score ?= 2", "@collection.nope.x = 1", "@collection.ks_fx_p.nope = 1", "@collection.ks_fx_p.id ?= rel"]) cases.push({ coll: "ks_fx", filter: f, superuser: true });

const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0; const failures: string[] = [];
try {
  const CONCURRENCY = 6;
  for (let i = 0; i < cases.length; i += CONCURRENCY) {
    await Promise.all(cases.slice(i, i + CONCURRENCY).map(async (c) => {
      const [a, b] = await Promise.all([pb.run(c.coll, c.filter, !!c.superuser), vb.run(c.coll, c.filter, !!c.superuser)]);
      if (a === b) { pass++; if (VERBOSE) console.log(`PASS  ${c.coll} ${c.filter}  -> ${a}`); } else { fail++; failures.push(`FAIL  ${c.coll} ${JSON.stringify(c.filter)}\n      pb: ${a}\n      vb: ${b}`); }
    }));
  }
} finally { await pb.teardown(); await vb.teardown(); }
for (const f of failures) console.log(f);
console.log(`\n${pass} pass, ${fail} fail  (${cases.length} filter expressions)`); process.exit(fail ? 1 : 0);
