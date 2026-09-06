// API rule validation on collection save, differential against the reference PocketBase
// (core/collection_validate.go checkRule + the auth options rules): codes, messages and key order.
//   bun test/conformance/rules.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
const PB = process.argv[2] ?? "http://127.0.0.1:8090"; const VB = process.argv[3] ?? "http://127.0.0.1:5180";
async function tok(b: string) { return ((await fetch(`${b}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: "changeme123" }) }).then((r) => r.json())) as { token: string }).token; }
const cases: Record<string, unknown>[] = [
  { name: "ks_rule1", type: "base", listRule: "nope = 1" },
  { name: "ks_rule2", type: "base", listRule: "id = 1 &&" },
  { name: "ks_rule3", type: "base", viewRule: "@request.auth.id != '' && created > 1", createRule: "@collection.zzz.id ?= id" },
  { name: "ks_rule4", type: "view", viewQuery: "select id from posts", createRule: "", updateRule: "1=1", deleteRule: null, listRule: "id != ''" },
  { name: "ks_rule5", type: "auth", manageRule: "", authRule: "verified = true", mfa: { enabled: false, duration: 1800, rule: "id = 'x'" } },
  { name: "ks_rule6", type: "auth", manageRule: "nope = 1", authRule: "bad = ", mfa: { enabled: false, duration: 1800, rule: "zzz = 1" } },
  { name: "ks_rule7", type: "auth", mfa: { enabled: false, duration: 1800, rule: "zzz = 1" } },
  { name: "ks_rule8", type: "base", listRule: "@request.auth.verified = true && @request.body.title:isset = false", updateRule: "@request.query.x = 'y' || @request.headers.x_y = 1", deleteRule: "posts_via_user.id ?= id" },
  { name: "ks_rule9", type: "view", viewQuery: "select id, title from posts", listRule: "title != '' && missing = 1" },
  { name: "ks_rule10", type: "auth", passwordAuth: { enabled: true, identityFields: ["email"] }, otp: { enabled: true, duration: 180, length: 8, emailTemplate: { subject: "OTP", body: "{OTP}" } }, mfa: { enabled: true, duration: 1800, rule: "zzz = 1" } },
  { name: "ks_rule11", type: "base", listRule: "nope_via_x.id ?= id", viewRule: "posts_via_nope.id ?= id", createRule: "posts_via_title.id ?= id" },
];
let pass = 0, fail = 0;
async function run(base: string, c: Record<string, unknown>) {
  const t = await tok(base);
  await fetch(`${base}/api/collections/${c.name}`, { method: "DELETE", headers: { authorization: t } });
  const r = await fetch(`${base}/api/collections`, { method: "POST", headers: { authorization: t, "content-type": "application/json" }, body: JSON.stringify(c) });
  const j = (await r.json()) as Record<string, unknown>;
  if (r.status === 200) await fetch(`${base}/api/collections/${c.name}`, { method: "DELETE", headers: { authorization: t } });
  return { status: r.status, body: r.status === 200 ? "created" : JSON.stringify(j) };
}
for (const c of cases) {
  const [pb, vb] = await Promise.all([run(PB, c), run(VB, c)]);
  const ok = pb.status === vb.status && pb.body === vb.body;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name} ${JSON.stringify(c).slice(0, 90)}`);
  if (!ok) console.log(`   pb ${pb.status} ${pb.body}\n   vb ${vb.status} ${vb.body}`);
}
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
