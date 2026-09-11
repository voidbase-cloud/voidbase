// The pure parts of the voidbase.cloud client (src/cloud/client.ts), against a fake fetch: what it normalises,
// what it refuses before any request, and what it asks the site for. test/cloud-cli.ts drives the whole thing.
import { expect, test } from "bun:test";
import { CloudClient, CloudError, type Instance, type Repo, type Template } from "../../src/cloud/client";

interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }
type Route = (call: Call) => Response | undefined;
/** a client on https://site.test whose fetch answers from `route`, recording every call */
function fake(route: Route = () => undefined) {
  const calls: Call[] = [];
  const client = new CloudClient("https://site.test/", () => "session-token", async (input, init) => {
    const u = new URL(input); const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
    const call: Call = { method: init?.method ?? "GET", path: u.pathname + u.search, body, headers }; calls.push(call);
    return route(call) ?? Response.json({ message: `no route for ${call.method} ${call.path}` }, { status: 404 });
  });
  return { client, calls };
}
const cfOk = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
const cfMissing = () => Response.json({ success: false, errors: [{ code: 10007, message: "script not found" }], messages: [], result: null }, { status: 404 });
const message = (p: Promise<unknown>) => p.then(() => "resolved", (e) => (e instanceof Error ? e.message : String(e)));
const account = { id: "acc123", name: "Test Account" };
const inst: Instance = { id: "i1", name: "vb-shop", url: "https://vb-shop.testsub.workers.dev", status: "live", release: "0.1.0", account, owner: "u1", superuserEmail: "owner@example.com" };
const tpl: Template = { id: "t1", name: "site", repo: "voidbase-cloud/voidbase-site", title: "Site", kind: "site", variables: [{ name: "PB_VB_URL", source: "instance_url" }, { name: "PAGES_CNAME", source: "input:domain" }] };

// ---- createInstance: the name --------------------------------------------------------------------------------
// the name is settled before anything is asked: a bad one never reaches the site
test("createInstance refuses an empty name and one too long, before any request", async () => {
  const { client, calls } = fake();
  expect(await message(client.createInstance({ name: "  ", account, owner: "u1", superuserEmail: "a@b.c" }))).toMatch(/Give the instance a name/);
  expect(await message(client.createInstance({ name: "!!!", account, owner: "u1", superuserEmail: "a@b.c" }))).toMatch(/Give the instance a name/);
  expect(await message(client.createInstance({ name: "x".repeat(70), account, owner: "u1", superuserEmail: "a@b.c" }))).toMatch(/not a valid worker name/);
  expect(calls).toHaveLength(0);
});

test("createInstance normalises the name and adds the prefix once, then asks Cloudflare whether the Worker exists", async () => {
  const seen = async (name: string, prefix?: string) => {
    const { client, calls } = fake((c) => (/\/workers\/scripts\/[^/]+\/settings$/.test(c.path) ? cfMissing() : c.path === "/api/vbcloud/release" ? Response.json({ current: null }) : undefined));
    const err = await message(client.createInstance({ name, account, owner: "u1", superuserEmail: "a@b.c", prefix }));
    // the release comes after the name check, and the fake has none: the walk stops there, with the name already chosen
    expect(err).toMatch(/No voidbase release is available/);
    const settings = calls.find((c) => c.path.includes("/settings"))!;
    expect(settings.path.startsWith("/api/vbcloud/cf/accounts/acc123/workers/scripts/")).toBe(true);
    return settings.path.slice("/api/vbcloud/cf/accounts/acc123/workers/scripts/".length, -"/settings".length);
  };
  expect(await seen("My Shop")).toBe("vb-my-shop");
  expect(await seen("  Shop Two!  ")).toBe("vb-shop-two");
  expect(await seen("shop--two")).toBe("vb-shop--two"); // dashes are kept as given, a Worker name allows them
  expect(await seen("vb-shop")).toBe("vb-shop"); // the prefix is not doubled
  expect(await seen("shop", "acme-")).toBe("acme-shop");
  expect(await seen("-dashes-")).toBe("vb-dashes");
});

test("createInstance refuses a name whose Worker exists on the account, and writes no row", async () => {
  const { client, calls } = fake((c) => (c.path.endsWith("/settings") ? cfOk({ bindings: [] }) : undefined));
  expect(await message(client.createInstance({ name: "shop", account, owner: "u1", superuserEmail: "a@b.c" }))).toMatch(/A Worker named vb-shop already exists/);
  expect(calls.some((c) => c.path.startsWith("/api/collections/"))).toBe(false);
});

test("the Cloudflare pass-through carries the site session as the bearer and an upload token as x-cf-token", async () => {
  const { client, calls } = fake(() => cfOk([]));
  const cf = client.cf();
  await cf.json("GET", "/accounts/acc123/workers/scripts");
  await cf.form("POST", "/accounts/acc123/workers/assets/upload", new FormData(), { token: "upload-jwt" });
  expect(calls[0]!.path).toBe("/api/vbcloud/cf/accounts/acc123/workers/scripts");
  expect(calls[0]!.headers.authorization).toBe("Bearer session-token");
  expect(calls[0]!.headers["x-cf-token"]).toBeUndefined();
  expect(calls[1]!.headers.authorization).toBe("Bearer session-token");
  expect(calls[1]!.headers["x-cf-token"]).toBe("upload-jwt");
});

// ---- the refusals that need no request ---------------------------------------------------------------------
test("a system instance is neither deleted nor upgraded from the client", async () => {
  const { client, calls } = fake();
  expect(await message(client.deleteInstance({ ...inst, system: true }))).toMatch(/A system instance is not deleted from here/);
  expect(await message(client.upgradeInstance({ ...inst, system: true }))).toMatch(/deployed from its repository/);
  expect(calls).toHaveLength(0);
});

test("upgradeInstance does nothing when the instance is already on the current release", async () => {
  const { client, calls } = fake((c) => (c.path === "/api/vbcloud/release" ? Response.json({ current: "0.1.0" }) : c.path.endsWith("path=manifest.json") ? new Response(JSON.stringify({ version: "0.1.0", modules: [], assets: [], migrations: [], crons: [], durableObjects: [] })) : undefined));
  const r = await client.upgradeInstance(inst);
  expect(r).toEqual({ upgraded: false, from: "0.1.0", to: "0.1.0", log: [] });
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
});

test("a system repository stays linked; unlinking another deletes its row and unwires the instance", async () => {
  const { client, calls } = fake(() => new Response(null, { status: 204 }));
  const repo: Repo = { id: "r1", instance: "i1", fullName: "octo/site", htmlUrl: "https://github.com/octo/site", status: "ready" };
  expect(await message(client.unlinkRepo({ ...repo, system: true }, inst))).toMatch(/A system repository stays linked/);
  expect(calls).toHaveLength(0);
  await client.unlinkRepo(repo, inst);
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /api/collections/vb_repos/records/r1", "DELETE /api/vbcloud/instances/i1/wire"]);
  calls.length = 0;
  await client.unlinkRepo(repo, { ...inst, system: true }); // a system instance is not unwired from here
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /api/collections/vb_repos/records/r1"]);
});

test("superusers: a bad email or a short password is refused before the instance is asked", async () => {
  const { client, calls } = fake();
  const su = client.superusers(inst, "s");
  expect(await message(su.add("nope", "long-enough-1"))).toMatch(/email address/);
  expect(await message(su.add("a@b.co", "short"))).toMatch(/8 characters/);
  expect(calls).toHaveLength(0);
});

test("domains: a hostname is lowercased and stripped of a scheme and path; a malformed one is refused", async () => {
  const { client, calls } = fake((c) => (c.path.startsWith("/api/vbcloud/cf/accounts/acc123/workers/domains") ? cfOk([]) : c.path.startsWith("/api/vbcloud/cf/zones") ? cfOk([]) : undefined));
  const d = client.domains(inst);
  expect(await message(d.attach("not a host"))).toMatch(/hostname like api.example.com/);
  expect(await message(d.attach("localhost"))).toMatch(/hostname like/);
  expect(calls).toHaveLength(0);
  // a well-formed one goes to Cloudflare; without a zone on the account it stops there, with the normalised name
  expect(await message(d.attach("https://API.Example.com/path"))).toMatch(/no zone on account acc123 covers api.example.com/);
  expect(calls[0]!.path).toBe("/api/vbcloud/cf/accounts/acc123/workers/domains?hostname=api.example.com");
});

test("secrets: names are validated, the managed ones are left alone, an empty value is refused", async () => {
  const { client, calls } = fake(() => cfOk(null));
  const s = client.secrets(inst);
  expect(await message(s.set("1BAD", "x"))).toMatch(/letters, digits and underscores/);
  expect(await message(s.set("VOIDBASE_SUPERUSER_EMAIL", "x"))).toMatch(/managed by voidbase.cloud/);
  expect(await message(s.set("VOIDBASE_GH_TOKEN", "x"))).toMatch(/managed by voidbase.cloud/);
  expect(await message(s.remove("VOIDBASE_PROJECT_REPO"))).toMatch(/managed by voidbase.cloud/);
  expect(await message(s.set("MY_KEY", ""))).toMatch(/Give the secret a value/);
  expect(calls).toHaveLength(0);
  await s.set(" MY_KEY ", "v");
  expect(calls[0]!.method).toBe("PUT");
  expect(calls[0]!.body).toEqual({ name: "MY_KEY", text: "v", type: "secret_text" });
});

// ---- repositories: the names --------------------------------------------------------------------------------
test("createRepo normalises the repository name and refuses an empty or over-long one", async () => {
  const { client, calls } = fake((c) => (c.path === "/api/vbcloud/gh/user" ? Response.json({ login: "octo" }) : c.path.endsWith("/generate") ? Response.json({ message: "Name already exists on this account" }, { status: 422 }) : undefined));
  const base = { template: tpl, instance: inst, user: "u1" };
  expect(await message(client.createRepo({ ...base, name: "  " }))).toMatch(/Give the repository a name/);
  expect(await message(client.createRepo({ ...base, name: "---" }))).toMatch(/Give the repository a name/);
  expect(await message(client.createRepo({ ...base, name: "x".repeat(101) }))).toMatch(/Give the repository a name/);
  expect(calls).toHaveLength(0);
  await message(client.createRepo({ ...base, name: "  My Site!  ", private: true }));
  const gen = calls.find((c) => c.path.endsWith("/generate"))!;
  expect(gen.path).toBe("/api/vbcloud/gh/repos/voidbase-cloud/voidbase-site/generate");
  expect(gen.body).toMatchObject({ owner: "octo", name: "my-site", private: true });
  expect((gen.body as { description: string }).description).toMatch(/Site on voidbase \(vb-shop\)/);
  calls.length = 0;
  await message(client.createRepo({ ...base, name: "..dots.and_under--", owner: "acme" }));
  expect(calls.find((c) => c.path.endsWith("/generate"))!.body).toMatchObject({ owner: "acme", name: "dots.and_under" });
  expect(calls.some((c) => c.path === "/api/vbcloud/gh/user")).toBe(false); // an explicit owner is not looked up
});

test("linkRepo takes owner/name or a GitHub URL, and refuses anything else before asking GitHub", async () => {
  const { client, calls } = fake((c) => (c.path.startsWith("/api/vbcloud/gh/repos/") ? Response.json({ message: "Not Found" }, { status: 404 }) : undefined));
  const base = { instance: inst, user: "u1" };
  for (const bad of ["nope", "owner/", "/name", "owner/name/extra", "-owner/name", "owner/na me"]) expect(await message(client.linkRepo({ ...base, fullName: bad }))).toMatch(/owner\/name/);
  expect(calls).toHaveLength(0);
  expect(await message(client.linkRepo({ ...base, fullName: "https://github.com/Octo/My.Site.git" }))).toMatch(/octo\/my.site was not found on GitHub/);
  expect(calls[0]!.path).toBe("/api/vbcloud/gh/repos/octo/my.site");
  expect(calls[0]!.headers.accept).toBe("application/vnd.github+json");
  expect(await message(client.linkRepo({ ...base, fullName: " https://github.com/Octo/Site/ " }))).toMatch(/octo\/site was not found/);
  expect(calls[1]!.path).toBe("/api/vbcloud/gh/repos/octo/site");
});

test("linkRepo refuses a repository the connection cannot push to, sets PB_VB_URL first, writes the row and wires", async () => {
  const gh = { full_name: "Octo/Site", html_url: "https://github.com/Octo/Site", default_branch: "main", private: false, permissions: { push: true } };
  const { client, calls } = fake((c) => {
    if (c.path === "/api/vbcloud/gh/repos/octo/readonly") return Response.json({ ...gh, permissions: { push: false } });
    if (c.path === "/api/vbcloud/gh/repos/octo/site") return Response.json(gh);
    if (c.path.includes("/actions/variables")) return c.method === "POST" && c.path.endsWith("/variables") ? Response.json({ message: "already exists" }, { status: 409 }) : new Response(null, { status: 204 });
    if (c.path === "/api/collections/vb_repos/records") return Response.json({ id: "r9" });
    if (c.path === "/api/vbcloud/instances/i1/wire") return Response.json({ wired: ["VOIDBASE_PROJECT_REPO", "VOIDBASE_PROJECT_BRANCH", "VOIDBASE_GH_TOKEN"] });
    return undefined;
  });
  expect(await message(client.linkRepo({ instance: inst, user: "u1", fullName: "octo/readonly" }))).toMatch(/cannot write to octo\/readonly/);
  const r = await client.linkRepo({ instance: inst, user: "u1", fullName: "octo/site", template: tpl, inputs: { domain: "site.example.com" } });
  expect(r.variables).toEqual({ PB_VB_URL: inst.url!, PAGES_CNAME: "site.example.com" });
  // POST answered 409 (the variable exists), so each was PATCHed under its name
  expect(calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual(["/api/vbcloud/gh/repos/Octo/Site/actions/variables/PB_VB_URL", "/api/vbcloud/gh/repos/Octo/Site/actions/variables/PAGES_CNAME"]);
  expect(calls.find((c) => c.path === "/api/collections/vb_repos/records")!.body).toMatchObject({ user: "u1", instance: "i1", template: "t1", full_name: "octo/site", default_branch: "main", status: "ready" });
  expect(calls.find((c) => c.path.endsWith("/wire"))!.body).toEqual({ repository: "octo/site", branch: "main" });
  expect(r.repo).toMatchObject({ id: "r9", fullName: "octo/site", instanceName: "vb-shop", canUnlink: true, templateName: "site" });
  expect(r.wired).toHaveLength(3);
});

test("checkRepo says whether the repository still exists and points at the instance", async () => {
  const { client } = fake((c) => (c.path === "/api/vbcloud/gh/repos/octo/gone" ? Response.json({ message: "Not Found" }, { status: 404 }) : c.path === "/api/vbcloud/gh/repos/octo/site" ? Response.json({ default_branch: "main", private: true }) : c.path.endsWith("/actions/variables/PB_VB_URL") ? Response.json({ value: inst.url }) : undefined));
  const repo: Repo = { id: "r1", instance: "i1", fullName: "octo/site", htmlUrl: "", status: "ready" };
  expect(await client.checkRepo({ ...repo, fullName: "octo/gone" }, inst)).toEqual({ exists: false, connected: false, backendUrl: "" });
  expect(await client.checkRepo(repo, inst)).toEqual({ exists: true, connected: true, backendUrl: inst.url!, private: true, defaultBranch: "main" });
  expect((await client.checkRepo(repo, { ...inst, url: "https://elsewhere.test" })).connected).toBe(false);
});

// ---- pipelineOf: the dashboard link, and what the token can tell -----------------------------------------------
test("pipelineOf links to the Worker's settings on the dashboard, and reads the Builds trigger when it can", async () => {
  const link = "https://dash.cloudflare.com/acc123/workers/services/view/vb-shop/settings";
  const fails = fake(() => { throw new Error("network down"); });
  expect(await fails.client.pipelineOf(inst)).toEqual({ connected: null, link });
  const noTag = fake((c) => (c.path.endsWith("/workers/scripts") ? cfOk([{ id: "other", tag: "t-other" }]) : undefined));
  expect(await noTag.client.pipelineOf(inst)).toEqual({ connected: null, link });
  const none = fake((c) => (c.path.endsWith("/workers/scripts") ? cfOk([{ id: "vb-shop", tag: "t-shop" }]) : c.path.endsWith("/builds/workers/t-shop/triggers") ? cfOk([]) : undefined));
  expect(await none.client.pipelineOf(inst)).toEqual({ connected: false, link });
  const one = fake((c) => (c.path.endsWith("/workers/scripts") ? cfOk([{ id: "vb-shop", tag: "t-shop" }]) : c.path.endsWith("/builds/workers/t-shop/triggers") ? cfOk([{ trigger_uuid: "tr1" }]) : undefined));
  expect(await one.client.pipelineOf(inst)).toEqual({ connected: true, link });
});

test("credentials never carry a password; the panel is the instance's /_/", () => {
  const { client } = fake();
  expect(client.credentials(inst)).toEqual({ url: inst.url!, superuserEmail: "owner@example.com", panel: `${inst.url}/_/` });
  expect(client.credentials({ ...inst, url: "" })).toEqual({ url: "", superuserEmail: "owner@example.com", panel: "" });
});

test("the site's answer is the error: message, status and the provisioning log", async () => {
  const { client } = fake((c) => (c.path === "/api/vbcloud/release" ? Response.json({ message: "Sign in first." }, { status: 401 }) : undefined));
  const err = await client.release().catch((e) => e as CloudError);
  expect(err).toBeInstanceOf(CloudError);
  expect((err as CloudError).message).toBe("Sign in first.");
  expect((err as CloudError).status).toBe(401);
  expect((err as CloudError).log).toEqual([]);
});
