// `voidbase cloud <verb>` end to end, against a mock of voidbase.cloud: the site here keeps the session (one CLI
// token), the rows (vb_instances, vb_repos), the templates, a tiny release, and the two pass-throughs, Cloudflare's
// onto test/cf-mock.ts and GitHub's onto an inline mock; an instance's plugins are served by an inline instance.
// The CLI runs as a child process with XDG_CONFIG_HOME in a temporary directory, so the session file is checked too.
//   bun test/cloud-cli.ts
import { writeFileSync, mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assetHash, contentTypeFor, type ReleaseManifest } from "../src/cloud/rest";

const ROOT = resolve(import.meta.dir, "..");
const freePort = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };
const CF_PORT = freePort(); const CF = `http://127.0.0.1:${CF_PORT}`;
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const cfMock = Bun.spawn(["bun", resolve(import.meta.dir, "cf-mock.ts"), String(CF_PORT)], { stdout: "ignore", stderr: "inherit" });
for (let i = 0; i < 50; i++) { try { await fetch(`${CF}/__calls`); break; } catch { await Bun.sleep(100); } }
const cfState = async () => (await fetch(`${CF}/__state`).then((r) => r.json())) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const cfCalls = async () => (await fetch(`${CF}/__calls`).then((r) => r.json())) as string[];

// ---- a tiny release, in memory, the way the site serves it file by file --------------------------------------
async function fakeRelease(version: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>(); const enc = new TextEncoder();
  files.set("worker/index.js", enc.encode("export default { fetch() { return new Response('ok') } }")); files.set("worker/assets/app.js", enc.encode("export const x = 1;"));
  const m: ReleaseManifest = { version, voidbase: "0.1.0", builtAt: new Date().toISOString(), compatibilityDate: "2026-09-05", compatibilityFlags: ["nodejs_compat"], mainModule: "index.js", modules: [{ path: "index.js", type: "esm", size: 1 }, { path: "assets/app.js", type: "esm", size: 1 }], assets: [], migrations: [{ name: "0000_init.sql", size: 1 }], crons: ["0 * * * *"], durableObjects: [{ binding: "HUB", className: "VoidbaseHub", tag: "voidbase-hub-v1" }], queueBinding: "QUEUE_JOBS", assetsConfig: { not_found_handling: "404-page" } };
  for (const [path, body] of [["_/index.html", "<!doctype html><title>panel</title>"], ["404.html", "<h1>404</h1>"]] as const) { files.set(`assets/${path}`, enc.encode(body)); m.assets.push({ path, size: body.length, hash: await assetHash(enc.encode(body)), contentType: contentTypeFor(path) }); }
  files.set("migrations/0000_init.sql", enc.encode("CREATE TABLE a (id TEXT);")); files.set("manifest.json", enc.encode(JSON.stringify(m)));
  return files;
}
const V1 = "0.1.0-cli", V2 = "0.1.0-cli-next";
const releases = new Map<string, Map<string, Uint8Array>>([[V1, await fakeRelease(V1)], [V2, await fakeRelease(V2)]]); let current = V1;

// ---- the site: session, rows, templates, release, pass-throughs -----------------------------------------------
const TOKEN = "cli-test-token"; const UID = "u1";
const instRows = new Map<string, Record<string, unknown>>(); const repoRows = new Map<string, Record<string, unknown>>(); let ids = 0;
const wires: { id: string; body: unknown }[] = []; const unwires: string[] = [];
const template = { id: "tpl1", name: "voidbase-site", repo: "voidbase-cloud/voidbase-site", title: "voidbase site", description: "", url: "", kind: "site", variables: [{ name: "PB_VB_URL", source: "instance_url" }, { name: "PAGES_CNAME", source: "input:domain" }] };
const instanceJSON = (id: string, r: Record<string, unknown>) => ({ id, name: r.name, url: r.url ?? "", status: r.status, error: r.error ?? "", release: r.release ?? "", plugins: [], account: { id: r.account_id, name: r.account_name ?? "" }, owner: r.owner, system: false, superuserEmail: r.superuser_email ?? "", canDelete: true, canLink: true, self: false });
const repoJSON = (id: string, r: Record<string, unknown>) => { const inst = instRows.get(String(r.instance)); return { id, system: false, canUnlink: true, fullName: r.full_name, htmlUrl: r.html_url, defaultBranch: r.default_branch, private: !!r.private, status: r.status, error: "", template: r.template, instance: r.instance, instanceName: inst?.name ?? "", instanceUrl: inst?.url ?? "", templateName: r.template === template.id ? template.name : "", templateTitle: r.template === template.id ? template.title : "" }; };
// GitHub, inline: the user, template generation, repositories, Actions variables
const ghRepos = new Map<string, Record<string, unknown>>([["octo-tester/existing", { full_name: "octo-tester/existing", html_url: "https://github.com/octo-tester/existing", default_branch: "master", private: false, permissions: { push: true } }]]);
const ghVars = new Map<string, Record<string, string>>(); const ghCalls: string[] = [];
async function githubMock(method: string, p: string, req: Request): Promise<Response> {
  ghCalls.push(`${method} ${p}`);
  if (p === "/user") return Response.json({ id: 4242, login: "octo-tester", name: "Octo Tester" });
  const gen = p.match(/^\/repos\/([^/]+)\/([^/]+)\/generate$/);
  if (gen && method === "POST") { const b = (await req.json()) as Record<string, unknown>; const full = `${b.owner}/${b.name}`; if (ghRepos.has(full)) return Response.json({ message: "Name already exists on this account" }, { status: 422 }); const repo = { full_name: full, html_url: `https://github.com/${full}`, default_branch: "main", private: !!b.private, description: b.description, template: `${gen[1]}/${gen[2]}` }; ghRepos.set(full, repo); return Response.json(repo, { status: 201 }); }
  const vars = p.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/variables(?:\/([^/]+))?$/);
  if (vars) { const full = `${vars[1]}/${vars[2]}`; if (!ghRepos.has(full)) return Response.json({ message: "Not Found" }, { status: 404 }); const bag = ghVars.get(full) ?? ghVars.set(full, {}).get(full)!;
    if (method === "POST") { const b = (await req.json()) as { name: string; value: string }; if (b.name in bag) return Response.json({ message: "already exists" }, { status: 409 }); bag[b.name] = b.value; return Response.json({}, { status: 201 }); }
    if (method === "PATCH" && vars[3]) { const b = (await req.json()) as { value: string }; bag[vars[3]] = b.value; return new Response(null, { status: 204 }); }
    if (method === "GET" && vars[3]) return vars[3] in bag ? Response.json({ name: vars[3], value: bag[vars[3]] }) : Response.json({ message: "Not Found" }, { status: 404 }); }
  const one = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (one && method === "GET") { const full = `${one[1]}/${one[2]}`; return ghRepos.has(full) ? Response.json(ghRepos.get(full)) : Response.json({ message: "Not Found" }, { status: 404 }); }
  return Response.json({ message: `no GitHub route for ${method} ${p}` }, { status: 404 });
}
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", maxRequestBodySize: 200 * 1024 * 1024, async fetch(req) {
  const url = new URL(req.url); const p = url.pathname; const method = req.method;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, ""); // the site takes both forms
  if (bearer !== TOKEN) return Response.json({ message: "The request requires valid record authorization token." }, { status: 401 });
  if (p === "/api/vbcloud/me") return Response.json({ user: { id: UID, email: "owner@example.com", name: "Test Owner", superuser: false }, admin: false, connected: true, connection: { email: "owner@example.com", name: "Test Owner", cfUserId: "cfuser1", scopes: "account:read workers-scripts:write", expiry: "2027-01-01T00:00:00Z", accounts: [{ id: "acc123", name: "Test Account" }] }, self: { worker: null, account: null }, prefix: "vb-", maxInstances: 2, providerConfigured: true });
  if (p === "/api/vbcloud/github") return Response.json({ configured: true, connected: true, connection: { login: "octo-tester", name: "Octo Tester" }, scopes: "repo read:user" });
  if (p === "/api/vbcloud/instances") return Response.json({ instances: [...instRows].filter(([, r]) => r.status !== "deleted").map(([id, r]) => instanceJSON(id, r)) });
  if (p === "/api/vbcloud/templates") return Response.json({ templates: [template] });
  if (p === "/api/vbcloud/repos") return Response.json({ repos: [...repoRows].map(([id, r]) => repoJSON(id, r)) });
  if (p === "/api/vbcloud/release") return Response.json({ current });
  { const m = p.match(/^\/api\/vbcloud\/releases\/([^/]+)\/files$/); if (m) { const f = releases.get(m[1]!)?.get(url.searchParams.get("path") ?? ""); return f ? new Response(f as BodyInit) : Response.json({ message: "not found" }, { status: 404 }); } }
  { const m = p.match(/^\/api\/vbcloud\/instances\/([^/]+)\/wire$/); if (m) { if (!instRows.has(m[1]!)) return Response.json({ message: "not found" }, { status: 404 }); if (method === "POST") { wires.push({ id: m[1]!, body: await req.json() }); return Response.json({ wired: ["VOIDBASE_PROJECT_REPO", "VOIDBASE_PROJECT_BRANCH", "VOIDBASE_GH_TOKEN"] }); } if (method === "DELETE") { unwires.push(m[1]!); return Response.json({ unwired: ["VOIDBASE_PROJECT_REPO", "VOIDBASE_PROJECT_BRANCH", "VOIDBASE_GH_TOKEN"] }); } } }
  { const m = p.match(/^\/api\/collections\/(vb_instances|vb_repos)\/records(?:\/([^/]+))?$/); if (m) { const rows = m[1] === "vb_instances" ? instRows : repoRows;
    if (!m[2] && method === "POST") { const b = (await req.json()) as Record<string, unknown>; const id = `${m[1] === "vb_instances" ? "inst" : "repo"}${++ids}`; rows.set(id, b); return Response.json({ id, ...b }); }
    if (m[2] && method === "PATCH") { const r = rows.get(m[2]); if (!r) return Response.json({ message: "not found" }, { status: 404 }); Object.assign(r, (await req.json()) as Record<string, unknown>); return Response.json({ id: m[2], ...r }); }
    if (m[2] && method === "DELETE") { if (!rows.delete(m[2])) return Response.json({ message: "not found" }, { status: 404 }); return new Response(null, { status: 204 }); } } }
  if (p.startsWith("/api/vbcloud/cf/")) { // Cloudflare's API with the user's token, or the upload token the call carries
    const path = p.slice("/api/vbcloud/cf".length); if (!/^\/(accounts|zones|user|memberships)(\/|$)/.test(path)) return Response.json({ message: "Only Cloudflare's account, zone and user resources go through here." }, { status: 400 });
    const headers: Record<string, string> = { authorization: `Bearer ${req.headers.get("x-cf-token") || "cf-test-token"}` }; const ct = req.headers.get("content-type"); if (ct) headers["content-type"] = ct;
    const r = await fetch(`${CF}${path}${url.search}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer() });
    return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
  }
  if (p.startsWith("/api/vbcloud/gh/")) return githubMock(method, p.slice("/api/vbcloud/gh".length), req);
  return Response.json({ message: `no site route for ${method} ${p}` }, { status: 404 });
} });
const SITE = `http://127.0.0.1:${site.port}`;

// ---- an instance of its own: the sign-in and the installer's API -----------------------------------------------
let instancePassword = ""; const instanceCalls: { path: string; auth: string; body: unknown }[] = [];
const instance = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const p = new URL(req.url).pathname; const auth = req.headers.get("authorization") ?? "";
  if (p === "/api/collections/_superusers/auth-with-password") { const b = (await req.json()) as { identity: string; password: string }; return b.identity === "owner@example.com" && b.password === instancePassword ? Response.json({ token: "inst-session" }) : Response.json({ message: "Failed to authenticate." }, { status: 400 }); }
  if (auth !== "inst-session") return Response.json({ message: "The request requires valid record authorization token." }, { status: 401 });
  if (p === "/api/plugins") return Response.json({ names: ["auth", "realtime", "installer", "echo"], origins: { auth: "shipped", realtime: "shipped", installer: "shipped", echo: "http://market.test 0.1.0" }, disabled: ["backups"], installer: { mode: "repository", repository: "octo-tester/existing", branch: "master" } });
  const body = await req.json().catch(() => null); instanceCalls.push({ path: p, auth, body });
  if (p === "/api/plugins/install") return Response.json({ applied: "repository", committed: { sha: "abc", url: "https://github.com/octo-tester/existing/commit/abc" }, message: "Committed." });
  if (p === "/api/plugins/remove" || p === "/api/plugins/update") return Response.json({ applied: "repository", message: "Committed." });
  return Response.json({ message: "no" }, { status: 404 });
} });
const INSTANCE = `http://127.0.0.1:${instance.port}`;

// ---- the CLI, as a child process with its own config directory --------------------------------------------------
const home = mkdtempSync(join(tmpdir(), "vb-cloud-cli-")); const CONFIG = join(home, "voidbase", "cloud.json");
// Bun loads the cwd's .env into the child on its own; a checkout's superuser there must not sign the CLI in
const noEnv = join(home, "empty.env"); writeFileSync(noEnv, "");
const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: home, VOIDBASE_CLOUD_TOKEN: undefined, VOIDBASE_SUPERUSER_EMAIL: undefined, VOIDBASE_SUPERUSER_PASSWORD: undefined };
async function cli(...args: string[]): Promise<{ code: number; out: string; err: string; all: string }> {
  const p = Bun.spawn(["bun", `--env-file=${noEnv}`, resolve(ROOT, "bin/voidbase.ts"), "cloud", ...args], { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); const code = await p.exited;
  return { code, out, err, all: out + err };
}
const json = <T>(s: string): T => JSON.parse(s) as T;

try {
  // ---- the session
  const noToken = await cli("login");
  check("login without --token says where a token comes from and exits 2", noToken.code === 2 && /CLI token/.test(noToken.err) && /voidbase.cloud\/cloud/.test(noToken.err) && !existsSync(CONFIG), `${noToken.code} ${noToken.err}`);
  const early = await cli("whoami");
  check("a verb before login exits 2 and points at login", early.code === 2 && /not signed in/.test(early.err) && /cloud login --token/.test(early.err), `${early.code} ${early.err}`);
  const bad = await cli("login", "--token", "wrong-token", "--url", SITE);
  check("a token the site refuses is not stored", bad.code !== 0 && /refused the token/.test(bad.err) && !existsSync(CONFIG), `${bad.code} ${bad.err}`);
  const login = await cli("login", "--token", TOKEN, "--url", `${SITE}/`);
  const stored = existsSync(CONFIG) ? json<{ url: string; token: string }>(readFileSync(CONFIG, "utf8")) : null;
  check("login stores {url, token} under XDG_CONFIG_HOME/voidbase/cloud.json, mode 600", login.code === 0 && /signed in to .* as owner@example.com \(Test Owner\)/.test(login.out) && stored?.url === SITE && stored?.token === TOKEN && (statSync(CONFIG).mode & 0o777) === 0o600, `${login.code} ${login.all} ${JSON.stringify(stored)} ${existsSync(CONFIG) ? (statSync(CONFIG).mode & 0o777).toString(8) : "-"}`);
  const who = await cli("whoami");
  check("whoami: the user, the Cloudflare connection with its accounts, the GitHub connection", who.code === 0 && /user:\s+owner@example.com \(Test Owner\)\s+id u1/.test(who.out) && /cloudflare:\s+connected as owner@example.com/.test(who.out) && /accounts:\s+Test Account \(acc123\)/.test(who.out) && /github:\s+connected as octo-tester/.test(who.out) && /named vb-<name>, up to 2/.test(who.out), who.all);
  const whoJson = await cli("whoami", "--json");
  const wj = whoJson.code === 0 ? json<{ me: { user: { id: string } }; github: { connection: { login: string } } }>(whoJson.out) : null;
  check("--json prints the raw result", wj?.me.user.id === UID && wj?.github.connection.login === "octo-tester", whoJson.all.slice(0, 200));

  // ---- instances
  const none = await cli("instances");
  check("instances: none yet", none.code === 0 && /no instances on .* yet/.test(none.out), none.all);
  const created = await cli("instances", "create", "My Shop", "--email", "owner@example.com");
  const password = created.out.match(/password:\s+(\S+)/)?.[1] ?? "";
  const st = await cfState(); const script = st.scripts["vb-my-shop"];
  const row = [...instRows.values()].find((r) => r.name === "vb-my-shop");
  check("instances create: the name is normalised and prefixed, the Worker is provisioned in the account, the row goes live", created.code === 0 && /created vb-my-shop on Test Account \(acc123\), release 0.1.0-cli/.test(created.out) && !!script && script.modules.length === 2 && row?.status === "live" && row?.url === "https://vb-my-shop.testsub.workers.dev" && row?.release === V1, `${created.code} ${created.all}`);
  check("instances create: the credentials are printed once, the password is the Worker's secret", /url:\s+https:\/\/vb-my-shop\.testsub\.workers\.dev/.test(created.out) && /panel:\s+https:\/\/vb-my-shop\.testsub\.workers\.dev\/_\//.test(created.out) && /superuser:\s+owner@example.com/.test(created.out) && password.length === 24 && (script?.metadata.bindings as { name: string; text?: string }[]).find((b) => b.name === "VOIDBASE_SUPERUSER_PASSWORD")?.text === password, created.out);
  check("instances create: the provisioning steps are narrated", /D1 vb-my-shop-db created/.test(created.out) && /worker vb-my-shop uploaded/.test(created.out), created.out);
  const dup = await cli("instances", "create", "my-shop");
  check("a Worker that exists on the account is not created twice", dup.code === 1 && /A Worker named vb-my-shop already exists/.test(dup.err), `${dup.code} ${dup.all}`);
  const list = await cli("instances", "ls");
  check("instances ls: the row with its status, release and url", list.code === 0 && /1 instance\(s\)/.test(list.out) && /vb-my-shop\s+live\s+release 0.1.0-cli\s+https:\/\/vb-my-shop\.testsub\.workers\.dev/.test(list.out), list.all);
  const listJson = await cli("instances", "--json");
  check("instances --json: the raw listing", listJson.code === 0 && json<{ instances: { name: string }[] }>(listJson.out).instances[0]?.name === "vb-my-shop", listJson.all.slice(0, 200));
  const wrongAccount = await cli("instances", "create", "other", "--account", "nope");
  check("--account must be one the connection reaches", wrongAccount.code === 1 && /account "nope" is not one the connection reaches \(Test Account acc123\)/.test(wrongAccount.err), `${wrongAccount.code} ${wrongAccount.all}`);
  const unknown = await cli("instances", "upgrade", "ghost");
  check("an unknown instance is named, with what there is", unknown.code === 1 && /no instance called "ghost" \(you have: vb-my-shop\)/.test(unknown.err), `${unknown.code} ${unknown.all}`);

  // upgrade: the site moves to a second release; the instance is named without its prefix
  current = V2;
  const puts = async () => (await cfCalls()).filter((c) => /^PUT \/accounts\/acc123\/workers\/scripts\/vb-my-shop$/.test(c)).length;
  const before = await puts();
  const up = await cli("instances", "upgrade", "my-shop");
  check("instances upgrade: the same Worker uploaded from the new release, the row moved", up.code === 0 && /upgraded vb-my-shop from 0.1.0-cli to 0.1.0-cli-next/.test(up.out) && (await puts()) === before + 1 && row?.release === V2 && row?.status === "live", `${up.code} ${up.all}`);
  const upAgain = await cli("instances", "upgrade", "vb-my-shop");
  check("already on the release: nothing uploaded", upAgain.code === 0 && /vb-my-shop is already on 0.1.0-cli-next/.test(upAgain.out) && (await puts()) === before + 1, upAgain.all);

  // ---- repositories
  const noRepos = await cli("repos");
  check("repos: none yet", noRepos.code === 0 && /no repositories linked/.test(noRepos.out), noRepos.all);
  const mk = await cli("repos", "create", "vb-my-shop", "--template", "voidbase-site", "--name", "My Site!", "--inputs", "domain=site.example.com", "--private");
  const made = ghRepos.get("octo-tester/my-site"); const vars = ghVars.get("octo-tester/my-site");
  check("repos create: generated from the template, private, variables set to the instance and the input, wired", mk.code === 0 && /created octo-tester\/my-site from voidbase-site \(private\), linked to vb-my-shop/.test(mk.out) && made?.template === "voidbase-cloud/voidbase-site" && made?.private === true && vars?.PB_VB_URL === row?.url && vars?.PAGES_CNAME === "site.example.com" && /wired on the instance: VOIDBASE_PROJECT_REPO, VOIDBASE_PROJECT_BRANCH, VOIDBASE_GH_TOKEN/.test(mk.out) && wires.length === 1 && [...repoRows.values()].some((r) => r.full_name === "octo-tester/my-site" && r.template === "tpl1"), `${mk.code} ${mk.all} ${JSON.stringify(vars)}`);
  const badTpl = await cli("repos", "create", "vb-my-shop", "--template", "nope", "--name", "x");
  check("an unknown template is named, with what the site offers", badTpl.code === 1 && /no template called "nope" \(the site offers: voidbase-site\)/.test(badTpl.err), `${badTpl.code} ${badTpl.all}`);
  const link = await cli("repos", "link", "vb-my-shop", "https://github.com/octo-tester/existing");
  check("repos link: an existing repository, PB_VB_URL set, the row written, wired", link.code === 0 && /linked octo-tester\/existing to vb-my-shop/.test(link.out) && ghVars.get("octo-tester/existing")?.PB_VB_URL === row?.url && wires.length === 2 && [...repoRows.values()].some((r) => r.full_name === "octo-tester/existing"), `${link.code} ${link.all}`);
  const missing = await cli("repos", "link", "vb-my-shop", "octo-tester/nothing");
  check("a repository GitHub does not know is refused", missing.code === 1 && /octo-tester\/nothing was not found on GitHub/.test(missing.err), `${missing.code} ${missing.all}`);
  const repos = await cli("repos", "ls");
  check("repos ls: both, with the instance and the template", repos.code === 0 && /2 repositories/.test(repos.out) && /octo-tester\/my-site\s+-> vb-my-shop\s+ready\s+private\s+from voidbase-site/.test(repos.out) && /octo-tester\/existing\s+-> vb-my-shop\s+ready/.test(repos.out), repos.all);
  const unlink = await cli("repos", "unlink", "octo-tester/existing");
  const unlink2 = await cli("repos", "unlink", "https://github.com/Octo-Tester/My-Site");
  check("repos unlink: by name or URL, the rows go, the instance is unwired, the repositories stay on GitHub", unlink.code === 0 && /unlinked octo-tester\/existing from vb-my-shop; the repository stays on GitHub/.test(unlink.out) && unlink2.code === 0 && repoRows.size === 0 && unwires.length === 2 && ghRepos.has("octo-tester/existing") && ghRepos.has("octo-tester/my-site"), `${unlink.all} ${unlink2.all}`);
  const gone = await cli("repos", "unlink", "octo-tester/existing");
  check("unlinking what is not linked says so", gone.code === 1 && /no linked repository called "octo-tester\/existing": none are linked/.test(gone.err), `${gone.code} ${gone.all}`);

  // ---- plugins: the instance's own installer, with a session minted on the instance
  instancePassword = password; row!.url = INSTANCE;
  const noPw = await cli("plugins", "vb-my-shop");
  check("plugins needs the instance's superuser", noPw.code === 2 && /--email and --password/.test(noPw.err), `${noPw.code} ${noPw.all}`);
  const wrongPw = await cli("plugins", "vb-my-shop", "ls", "--email", "owner@example.com", "--password", "wrong");
  check("a wrong password is the instance's refusal", wrongPw.code === 1 && /Failed to authenticate/.test(wrongPw.err), `${wrongPw.code} ${wrongPw.all}`);
  const ls = await cli("plugins", "vb-my-shop", "--password", password); // the email defaults to the instance's superuser
  check("plugins ls: what runs, where an installed one came from, what is off, the installer's mode", ls.code === 0 && /running:\s+auth, realtime, installer, echo \(http:\/\/market.test 0.1.0\)/.test(ls.out) && /disabled:\s+backups/.test(ls.out) && /installer:\s+repository octo-tester\/existing \(master\)/.test(ls.out), `${ls.code} ${ls.all}`);
  const lsJson = await cli("plugins", "vb-my-shop", "ls", "--password", password, "--json");
  check("plugins ls --json: the instance's answer", lsJson.code === 0 && json<{ names: string[] }>(lsJson.out).names.includes("echo"), lsJson.all.slice(0, 200));
  const inst = await cli("plugins", "vb-my-shop", "install", "echo@0.2.0", "--marketplace", "https://marketplace.voidbase.cloud", "--password", password);
  const rm = await cli("plugins", "vb-my-shop", "remove", "echo", "--password", password);
  const upd = await cli("plugins", "vb-my-shop", "update", "--password", password);
  check("plugins install/remove/update reach the instance with its session; name@version and the marketplace travel", inst.code === 0 && /installed echo 0.2.0 on vb-my-shop: Committed\./.test(inst.out) && /commit: https:\/\/github.com\/octo-tester\/existing\/commit\/abc/.test(inst.out) && rm.code === 0 && /removed echo from vb-my-shop/.test(rm.out) && upd.code === 0 && /updated the installed plugins on vb-my-shop/.test(upd.out) && instanceCalls.length === 3 && instanceCalls.every((c) => c.auth === "inst-session") && JSON.stringify(instanceCalls[0]!.body) === JSON.stringify({ name: "echo", version: "0.2.0", marketplace: "https://marketplace.voidbase.cloud" }) && JSON.stringify(instanceCalls[1]!.body) === JSON.stringify({ name: "echo" }) && JSON.stringify(instanceCalls[2]!.body) === "{}", `${inst.all} ${rm.all} ${upd.all} ${JSON.stringify(instanceCalls)}`);
  row!.url = "https://vb-my-shop.testsub.workers.dev";

  // ---- delete
  const noYes = await cli("instances", "delete", "vb-my-shop");
  check("instances delete says what goes and, without a terminal, refuses without --yes", noYes.code === 1 && /There is no undo/.test(noYes.out) && /rerun with --yes/.test(noYes.err) && instRows.size === 1 && (await cfState()).scripts["vb-my-shop"], `${noYes.code} ${noYes.all}`);
  const del = await cli("instances", "delete", "my-shop", "--yes");
  const after = await cfState();
  check("instances delete --yes: the Worker, D1, R2, queue and consumer are gone, the row too", del.code === 0 && /deleted vb-my-shop: 5 removed, 1 not there/.test(del.out) && !after.scripts["vb-my-shop"] && after.d1.length === 0 && after.queues.length === 0 && Object.keys(after.r2).length === 0 && instRows.size === 0, `${del.code} ${del.all}`);

  // ---- the end of the session
  const bogus = await cli("bogus");
  check("an unknown verb prints the usage and exits 2", bogus.code === 2 && /unknown cloud verb "bogus"/.test(bogus.err) && /usage: voidbase cloud <verb>/.test(bogus.err), `${bogus.code} ${bogus.all}`);
  const logout = await cli("logout");
  const afterLogout = await cli("instances");
  check("logout removes the session file; the next verb asks for a login", logout.code === 0 && /signed out/.test(logout.out) && !existsSync(CONFIG) && afterLogout.code === 2 && /not signed in/.test(afterLogout.err), `${logout.all} ${afterLogout.all}`);
  const logoutAgain = await cli("logout");
  check("logout twice is fine", logoutAgain.code === 0 && /not signed in/.test(logoutAgain.out), logoutAgain.all);
  const viaEnv = await cli("whoami", "--url", SITE, "--token", TOKEN);
  check("a verb takes --token and --url without a stored session", viaEnv.code === 0 && /user:\s+owner@example.com/.test(viaEnv.out) && !existsSync(CONFIG), viaEnv.all);
} finally { cfMock.kill(); site.stop(true); instance.stop(true); rmSync(home, { recursive: true, force: true }); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
