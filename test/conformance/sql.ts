// POST /api/sql (0.40 SQL console). The reference is 0.39.11, which lacks the endpoint, so this suite checks
// voidbase's own contract against apis/sql.go and only compares with the reference when it answers 200.
//   bun test/conformance/sql.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const auth = async (base: string) => ({ authorization: String(((await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(CREDS) }).then((r) => r.json())) as { token: string }).token) });
const H = { pb: await auth(PB), vb: await auth(VB) };
const call = async (base: string, h: Record<string, string>, body: unknown) => { const r = await fetch(`${base}/api/sql`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null }; };
const probe = await call(PB, H.pb, { query: "SELECT 1 AS n" });
const referenceHasSql = probe.status === 200;
console.log(`reference SQL endpoint: ${referenceHasSql ? "available" : `not available (${probe.status}), checking voidbase alone`}`);
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(44)} ${JSON.stringify(detail).slice(0, 300)}`); };
// declared type names on the system tables differ between the two schemas (BOOLEAN vs integer); names and rows must match
const strip = (r: { status: number; json: Record<string, unknown> | null }) => ({ status: r.status, ...(r.json ? { ...r.json, columns: Array.isArray(r.json.columns) ? (r.json.columns as { name: string; nullable: boolean }[]).map((c) => ({ name: c.name, nullable: c.nullable })) : r.json.columns, execTime: typeof r.json.execTime === "number" ? "n" : r.json.execTime, message: typeof r.json.message === "string" ? (r.json.message as string).split("\n")[0] : r.json.message } : {}) });
const compareOrCheck = async (label: string, body: unknown, expect: (v: Record<string, unknown>) => boolean) => {
  const b = strip(await call(VB, H.vb, body));
  if (referenceHasSql) { const a = strip(await call(PB, H.pb, body)); check(label, JSON.stringify(a) === JSON.stringify(b), { pb: a, vb: b }); }
  else check(label, expect(b), b);
};
await compareOrCheck("select scalar", { query: "SELECT 1 AS n, 'a' AS s, NULL AS z" }, (v) => v.status === 200 && JSON.stringify(v.rows) === '[[1,"a",null]]' && JSON.stringify((v.columns as { name: string }[]).map((c) => c.name)) === '["n","s","z"]');
await compareOrCheck("select from a table", { query: "SELECT email, verified FROM _superusers ORDER BY email LIMIT 1" }, (v) => v.status === 200 && (v.rows as unknown[][]).length === 1 && (v.columns as { name: string }[])[0]?.name === "email");
await compareOrCheck("write query reports affected rows", { query: "UPDATE _params SET updated = updated WHERE id = 'settings'" }, (v) => v.status === 200 && v.affectedRows === 1 && JSON.stringify(v.columns) === "[]");
await compareOrCheck("invalid sql", { query: "SELEC nope" }, (v) => v.status === 400 && String(v.message).startsWith("Failed to execute query. Raw error:"));
await compareOrCheck("empty query", { query: "" }, (v) => v.status === 400 && JSON.stringify(v.data) === '{"query":{"code":"validation_required","message":"Cannot be blank."}}');
await compareOrCheck("too long", { query: "SELECT '" + "x".repeat(5001) + "'" }, (v) => v.status === 400 && String(JSON.stringify(v.data)).includes("validation_length_too_long"));
const anon = await fetch(`${VB}/api/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "SELECT 1" }) });
check("requires superuser", anon.status === 401, anon.status);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
