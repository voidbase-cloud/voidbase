// Differential conformance: fire the same requests at PocketBase and voidbase, compare status + JSON.
//   bun test/conformance/compare.ts [--pb http://127.0.0.1:8090] [--vb http://127.0.0.1:5180] [--only name]
// Volatile values (ids, timestamps, tokens, ips) are masked before comparing.
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "1"] : [])).filter((x) => x.length));
const PB = args.pb ?? "http://127.0.0.1:8090";
const VB = args.vb ?? "http://127.0.0.1:5180";
const SUPER = { identity: "admin@example.com", password: "changeme123" };
const USER = { identity: "user@example.com", password: "changeme123" };

type Case = { name: string; method?: string; path: string; body?: unknown; auth?: "super" | "user" | "bad" | "none"; bearer?: boolean; skip?: string };

const cases: Case[] = [
  { name: "health anon", path: "/api/health" },
  { name: "health superuser", path: "/api/health", auth: "super" },
  { name: "health bearer prefix", path: "/api/health", auth: "super", bearer: true },
  { name: "login superuser", method: "POST", path: "/api/collections/_superusers/auth-with-password", body: SUPER },
  { name: "login wrong password", method: "POST", path: "/api/collections/_superusers/auth-with-password", body: { ...SUPER, password: "nope" } },
  { name: "login validation", method: "POST", path: "/api/collections/_superusers/auth-with-password", body: {} },
  { name: "auth-refresh superuser", method: "POST", path: "/api/collections/_superusers/auth-refresh", auth: "super" },
  { name: "auth-refresh no auth", method: "POST", path: "/api/collections/_superusers/auth-refresh" },
  { name: "auth-refresh bad token", method: "POST", path: "/api/collections/_superusers/auth-refresh", auth: "bad" },
  { name: "auth-methods superusers", path: "/api/collections/_superusers/auth-methods" },
  { name: "settings superuser", path: "/api/settings", auth: "super" },
  { name: "settings anon", path: "/api/settings" },
  { name: "collections list", path: "/api/collections?page=1&perPage=500&sort=%2Bname&skipTotal=1", auth: "super", skip: "user collections exist only on the reference server until milestone two" },
  { name: "collection view _superusers", path: "/api/collections/_superusers", auth: "super" },
  { name: "collection view _mfas", path: "/api/collections/_mfas", auth: "super" },
  { name: "collection 404", path: "/api/collections/nope", auth: "super" },
  { name: "oauth2 providers", path: "/api/collections/meta/oauth2-providers", auth: "super" },
  { name: "scaffolds", path: "/api/collections/meta/scaffolds", auth: "super" },
  { name: "superusers records", path: "/api/collections/_superusers/records?perPage=1&sort=-@rowid", auth: "super" },
  { name: "superusers records skipTotal", path: "/api/collections/_superusers/records?perPage=1&skipTotal=1", auth: "super" },
  { name: "superusers records anon", path: "/api/collections/_superusers/records" },
  { name: "unknown api route", path: "/api/nope", auth: "super", skip: "the starter's pb_hooks override PocketBase's default 404 message" },
];

const VOLATILE = new Set(["id", "created", "updated", "token", "tokenKey", "exp", "realIP", "canBackup", "possibleProxyHeader", "secret", "recordRef", "collectionRef"]);
function mask(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => mask(x));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, VOLATILE.has(k) ? typeof x : mask(x, k)]));
  }
  if (key === "logo" && typeof v === "string") return "svg";
  if (typeof v === "string") return v.replace(/(idx_[A-Za-z]+_)[a-z0-9]{10}/g, "$1<rand>");
  return v;
}

async function login(base: string, creds: typeof SUPER, coll: string): Promise<string> {
  const r = await fetch(`${base}/api/collections/${coll}/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds) });
  const j = (await r.json()) as { token?: string };
  if (!j.token) throw new Error(`login failed on ${base}: ${r.status}`);
  return j.token;
}

async function run(base: string, c: Case, tokens: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (c.body) headers["content-type"] = "application/json";
  if (c.auth === "super" || c.auth === "user") headers.Authorization = (c.bearer ? "Bearer " : "") + tokens[c.auth]!;
  if (c.auth === "bad") headers.Authorization = "bad";
  const r = await fetch(base + c.path, { method: c.method ?? "GET", headers, body: c.body ? JSON.stringify(c.body) : undefined });
  const text = await r.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, json, keys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json as object) : null };
}

const tokens: Record<string, Record<string, string>> = { pb: {}, vb: {} };
tokens.pb!.super = await login(PB, SUPER, "_superusers");
tokens.vb!.super = await login(VB, SUPER, "_superusers");
try { tokens.pb!.user = await login(PB, USER, "users"); } catch { /* optional */ }

let pass = 0, fail = 0, skipped = 0;
for (const c of cases) {
  if (args.only && !c.name.includes(args.only)) continue;
  const [a, b] = await Promise.all([run(PB, c, tokens.pb!), run(VB, c, tokens.vb!)]);
  const sameStatus = a.status === b.status;
  const ma = JSON.stringify(mask(a.json)), mb = JSON.stringify(mask(b.json));
  const sameBody = ma === mb;
  const sameOrder = JSON.stringify(a.keys) === JSON.stringify(b.keys);
  if (c.skip && !(sameStatus && sameBody)) { skipped++; console.log(`SKIP  ${c.name}  (${c.skip})`); continue; }
  if (sameStatus && sameBody && sameOrder) { pass++; console.log(`PASS  ${c.name}  [${a.status}]`); continue; }
  fail++;
  console.log(`FAIL  ${c.name}  pb=${a.status} vb=${b.status}${sameOrder ? "" : "  (key order differs)"}`);
  if (!sameBody) {
    console.log("   pb:", ma.slice(0, 400)); console.log("   vb:", mb.slice(0, 400));
    if (args.dump) {
      const safe = c.name.replace(/[^a-z0-9]+/gi, "-");
      await Bun.write(`${args.dump}/${safe}.pb.json`, JSON.stringify(mask(a.json), null, 1));
      await Bun.write(`${args.dump}/${safe}.vb.json`, JSON.stringify(mask(b.json), null, 1));
      console.log(`   dumped to ${args.dump}/${safe}.{pb,vb}.json`);
    }
  }
  else if (!sameOrder) { console.log("   pb keys:", a.keys); console.log("   vb keys:", b.keys); }
}
console.log(`\n${pass} pass, ${fail} fail, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
