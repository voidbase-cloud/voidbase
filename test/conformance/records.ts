// Replays the recorded records lifecycle (test/fixtures/pb/records/*.json) against voidbase and diffs responses.
//   bun test/conformance/records.ts [--vb http://127.0.0.1:5180]
// Ids differ between servers, so ids are mapped as records are created and masked in responses.
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "1"] : [])).filter((x) => x.length));
const VB = args.vb ?? "http://127.0.0.1:5180";
const FX = "test/fixtures/pb/records";
const read = async (n: string) => JSON.parse(await Bun.file(`${FX}/${n}.json`).text()) as { method: string; path: string; request: unknown; status: number; response: unknown };

const ID_RE = /^[a-z0-9]{15}$/;
const idMap = new Map<string, string>(); // PocketBase id -> voidbase id
const VOLATILE = new Set(["created", "updated", "token", "tokenKey", "exp", "secret", "username"]);
function mask(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => mask(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, VOLATILE.has(k) ? typeof x : mask(x, k)]));
  if (typeof v === "string") {
    if (ID_RE.test(v)) return "<id>";
    return v.replace(/_[a-z0-9]{10}(\.[a-z0-9]+)/g, "_<rand>$1").replace(/[a-z0-9]{15}/g, (m) => (idMap.has(m) || [...idMap.values()].includes(m) ? "<id>" : m));
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(mask(a)) === JSON.stringify(mask(b));
function firstDiff(a: unknown, b: unknown): string {
  const sa = String(JSON.stringify(mask(a))), sb = String(JSON.stringify(mask(b)));
  let i = 0; while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  return `expected …${sa.slice(Math.max(0, i - 100), i + 200)}\n   got      …${sb.slice(Math.max(0, i - 100), i + 200)}`;
}
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: () => string) => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); if (detail) console.log("   " + detail()); } };

// substitute PocketBase ids with voidbase ids inside paths/bodies
const sub = (s: string) => s.replace(/[a-z0-9]{15}/g, (m) => idMap.get(m) ?? m);
function subDeep(v: unknown): unknown {
  if (typeof v === "string") return sub(v);
  if (Array.isArray(v)) return v.map(subDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, subDeep(x)]));
  return v;
}

const tokens: Record<string, string> = {};
async function login(coll: string, identity: string, password: string) {
  const r = await fetch(`${VB}/api/collections/${coll}/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity, password }) });
  const j = (await r.json()) as { token?: string; record?: { id: string } };
  if (!j.token) throw new Error(`login ${identity} failed: ${r.status} ${JSON.stringify(j)}`);
  return j as { token: string; record: { id: string } };
}
async function call(method: string, path: string, body?: unknown, token?: string, multipart?: FormData) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = token;
  if (body !== undefined && !multipart) headers["content-type"] = "application/json";
  const r = await fetch(VB + path, { method, headers, body: multipart ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json: json as Record<string, unknown> | null };
}

// --- setup: superuser, the reference app user, the ks_rec collection ------------------------------------
const su = await login("_superusers", "admin@example.com", "changeme123");
tokens.A = su.token;
let user = await call("POST", "/api/collections/users/auth-with-password", { identity: "user@example.com", password: "changeme123" });
if (user.status !== 200) {
  const created = await call("POST", "/api/collections/users/records", { email: "user@example.com", password: "changeme123", passwordConfirm: "changeme123" });
  if (created.status !== 200) { console.log("cannot create reference user:", created.status, JSON.stringify(created.json)); process.exit(1); }
  user = await call("POST", "/api/collections/users/auth-with-password", { identity: "user@example.com", password: "changeme123" });
}
tokens.U = String(user.json!.token);
const UID = String((user.json!.record as { id: string }).id);
await call("PATCH", `/api/collections/users/records/${UID}`, { name: "" }, tokens.A); // match the reference user's empty name
idMap.set("quxxcxy7bd5x5g4", UID); // the reference server's user@example.com id
for (const e of ["new1@example.com"]) {
  const l = await call("GET", `/api/collections/users/records?perPage=1&filter=${encodeURIComponent(`email='${e}'`)}`, undefined, tokens.A);
  for (const it of ((l.json?.items as { id: string }[]) ?? [])) await call("DELETE", `/api/collections/users/records/${it.id}`, undefined, tokens.A);
}
await call("DELETE", "/api/collections/ks_rec", undefined, tokens.A);
const coll = JSON.parse(await Bun.file(`${FX}/_collection.json`).text());
const cc = await call("POST", "/api/collections", coll, tokens.A);
check("create ks_rec collection", cc.status === 200, () => JSON.stringify(cc.json));

// --- replay -------------------------------------------------------------------------------------------
type Step = { name: string; token?: "A" | "U" | "NT"; multipart?: (fx: Awaited<ReturnType<typeof read>>) => Promise<FormData>; after?: (res: Record<string, unknown> | null, fx: Awaited<ReturnType<typeof read>>) => void };
const png = await Bun.file("public/_/images/favicon.png").arrayBuffer();
const mp = (fields: Record<string, string | string[] | { file: ArrayBuffer; name: string; type: string }[]>) => async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) { if (typeof item === "string") fd.append(k, item); else fd.append(k, new Blob([item.file], { type: item.type }), item.name); }
    else fd.append(k, v);
  }
  return fd;
};
const remember = (res: Record<string, unknown> | null, fx: { response: unknown }) => { const pbId = (fx.response as { id?: string })?.id; const vbId = res?.id; if (pbId && vbId) idMap.set(pbId, String(vbId)); };
const steps: Step[] = [
  { name: "create-full", token: "A", after: remember },
  { name: "create-custom-id", token: "A", after: remember },
  { name: "create-minimal", token: "A", after: remember },
  { name: "create-empty", token: "A" },
  { name: "create-invalid", token: "A" },
  { name: "create-duplicate-unique", token: "A" },
  { name: "create-bad-id", token: "A" },
  { name: "create-anon-forbidden" },
  { name: "create-as-user", token: "U", after: remember },
  { name: "view-full", token: "A" },
  { name: "view-expand", token: "A" },
  { name: "view-fields", token: "A" },
  { name: "view-expand-invalid", token: "A" },
  { name: "view-expand-anon" },
  { name: "view-missing", token: "A" },
  { name: "update-modifiers", token: "A" },
  { name: "update-modifiers-2", token: "A" },
  { name: "update-number-minus", token: "A" },
  { name: "update-invalid", token: "A" },
  { name: "update-as-user-not-author", token: "U" },
  { name: "update-as-user-author", token: "U" },
  { name: "update-anon" },
  ...["list-default", "list-sort", "list-fields", "list-expand", "list-excerpt", "f-eq", "f-neq", "f-gt", "f-like", "f-nlike", "f-bool", "f-bool-false", "f-and-or", "f-select-any", "f-select-eq", "f-select-single", "f-relation-path", "f-relation-multi-path", "f-json-path", "f-length", "f-isset-empty", "f-not-empty", "f-null", "f-date-macro", "f-date-lit", "f-lower", "f-in-like-num", "f-geo", "f-invalid", "f-unknown-field", "f-collection", "f-each", "sort-random", "sort-rowid", "sort-invalid", "page-2", "skip-total", "perpage-cap"].map((name) => ({ name, token: "A" as const })),
  { name: "f-request-auth", token: "U" },
  { name: "list-anon" },
  { name: "users-signup", after: remember },
  { name: "users-signup-mismatch" },
  { name: "users-signup-dup-email" },
  { name: "users-signup-short" },
  { name: "users-login-new", after: (res) => { tokens.NT = String(res?.token ?? ""); } },
  { name: "users-update-self", token: "NT" },
  { name: "users-change-password-no-old", token: "NT" },
  { name: "users-change-password", token: "NT" },
  { name: "users-set-verified-self", token: "NT" },
  { name: "users-set-verified-superuser", token: "A" },
  { name: "users-view-other", token: "U" },
  { name: "users-view-self", token: "U" },
  { name: "users-list-as-user", token: "U" },
  { name: "users-delete", token: "A" },
  { name: "create-multipart", token: "A", multipart: mp({ title: "With files", attachments: [{ file: png, name: "favicon.png", type: "image/png" }, { file: png, name: "second.png", type: "image/png" }], tags: ["a", "b"], meta: '{"k":1}' }), after: remember },
  { name: "update-multipart-remove-file", token: "A", multipart: async (fx) => { const fd = new FormData(); const req = fx.request as Record<string, string>; fd.append("attachments-", idMap.get(req["attachments-"] ?? "") ?? ""); return fd; } },
  { name: "update-multipart-append-file", token: "A", multipart: mp({ "attachments+": [{ file: png, name: "third.png", type: "image/png" }] }) },
  { name: "update-multipart-bad-mime", token: "A", multipart: mp({ attachments: [{ file: new TextEncoder().encode("# readme\n").buffer as ArrayBuffer, name: "README.md", type: "text/plain" }] }) },
  { name: "delete", token: "A" },
  { name: "view-after-delete", token: "A" },
  { name: "delete-as-user-not-author", token: "U" },
  { name: "delete-as-user-author", token: "U" },
];
let firstFile: string | null = null;
for (const step of steps) {
  const fx = await read(step.name);
  const path = sub(fx.path);
  const body = step.multipart ? undefined : fx.request === null ? undefined : subDeep(fx.request);
  const token = step.token ? tokens[step.token] : undefined;
  const res = await call(fx.method, path, body, token, step.multipart ? await step.multipart(fx) : undefined);
  if (res.json && Array.isArray(res.json.attachments) && (res.json.attachments as string[]).length) { const names = res.json.attachments as string[]; firstFile = names[0] ?? null; }
  if (step.name === "create-multipart" && res.json) { const req = (await read("update-multipart-remove-file")).request as Record<string, string>; idMap.set(req["attachments-"] ?? "", ((res.json.attachments as string[]) ?? [])[0] ?? ""); }
  const ok = res.status === fx.status && same(fx.response, res.json);
  check(`${step.name} [${fx.method} ${fx.status}]`, ok, () => `${res.status} ${firstDiff(fx.response, res.json)}`);
  step.after?.(res.json, fx);
}
// file download semantics
if (firstFile) {
  const rec = idMap.get(JSON.parse(await Bun.file(`${FX}/create-multipart.json`).text()).response.id);
  const r = await fetch(`${VB}/api/files/ks_rec/${rec}/${firstFile}`);
  check("file download 200 image/png", r.status === 200 && (r.headers.get("content-type") ?? "").includes("image/png") && (r.headers.get("content-disposition") ?? "").startsWith("inline"), () => `${r.status} ${r.headers.get("content-type")} ${r.headers.get("content-disposition")}`);
  const t = await fetch(`${VB}/api/files/ks_rec/${rec}/${firstFile}?thumb=100x100`);
  check("file thumb 200 image/png", t.status === 200 && (t.headers.get("content-type") ?? "").includes("image/png"), () => `${t.status}`);
  const m = await fetch(`${VB}/api/files/ks_rec/${rec}/nope.png`);
  check("missing file 404", m.status === 404);
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
