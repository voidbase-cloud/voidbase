// Connecting a repository to Workers Builds without the dashboard: the GitHub App covering it (src/cloud/github-app.ts)
// and the build token builds run with (ensureBuildToken in src/cloud/builds.ts), against a fake GitHub and a fake
// Cloudflare that answer the way the real ones are documented to.
import { afterAll, describe, expect, test } from "bun:test";
import { BUILD_TOKEN_PERMISSIONS, ensureBuildToken, type GithubRepo } from "../../src/cloud/builds";
import { appInstallLink, coverRepo } from "../../src/cloud/github-app";
import { CfApi } from "../../src/cloud/rest";

const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => { for (const s of servers) s.stop(true); });

/** a GitHub with one organisation installation, answering installations to a token with read:org */
function github(selection: "all" | "selected" | "none") {
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const u = new URL(req.url); calls.push(`${req.method} ${u.pathname} ${req.headers.get("authorization") ?? ""}`);
    if (u.pathname === "/orgs/acme/installations") return Response.json({ installations: selection === "none" ? [{ id: 7, app_slug: "someone-else", repository_selection: "all" }] : [{ id: 42, app_slug: "cloudflare-workers-and-pages", repository_selection: selection }] });
    if (u.pathname === "/user/installations/42/repositories/1001" && req.method === "PUT") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  } });
  servers.push(server);
  return { api: `http://127.0.0.1:${server.port}`, calls };
}

const orgRepo: GithubRepo = { id: 1001, name: "shop", owner: { id: 555, login: "acme", type: "Organization" } };

describe("the GitHub App covering a repository", () => {
  test("an installation covering selected repositories gets this one added, with the login's token", async () => {
    const gh = github("selected");
    expect(await coverRepo(orgRepo, { token: "gho_login", api: gh.api })).toEqual({ state: "added", installation: 42 });
    expect(gh.calls).toEqual(["GET /orgs/acme/installations Bearer gho_login", "PUT /user/installations/42/repositories/1001 Bearer gho_login"]);
  });

  test("one covering every repository needs nothing, and no installation is the one click, named", async () => {
    const all = github("all");
    expect(await coverRepo(orgRepo, { token: "gho_login", api: all.api })).toEqual({ state: "covered", installation: 42 });
    expect(all.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
    const none = github("none");
    expect(await coverRepo(orgRepo, { token: "gho_login", api: none.api })).toEqual({ state: "missing", link: "https://github.com/apps/cloudflare-workers-and-pages/installations/new/permissions?target_id=555", why: "the App is not installed on acme" });
  });

  test("a personal account, or no login, cannot be looked at from here and says where the click is", async () => {
    const gh = github("selected");
    const mine: GithubRepo = { id: 9, name: "site", owner: { id: 77, login: "someone", type: "User" } };
    const personal = await coverRepo(mine, { token: "gho_login", api: gh.api });
    expect(personal).toMatchObject({ state: "unknown", link: appInstallLink({ id: 77 }) });
    expect(gh.calls).toEqual([]);
    expect(await coverRepo(orgRepo, { token: "", api: gh.api })).toMatchObject({ state: "unknown", why: expect.stringContaining("gh auth login") });
  });
});

describe("the build token builds run with", () => {
  /** a Cloudflare with no build token yet, whose token API hands out tokens to the creator */
  function cloudflare(existing: boolean) {
    const calls: { method: string; path: string; auth: string; body: unknown }[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const u = new URL(req.url); const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      calls.push({ method: req.method, path: u.pathname, auth: req.headers.get("authorization") ?? "", body });
      const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
      if (u.pathname === "/accounts/acc/builds/tokens" && req.method === "GET") return ok(existing ? [{ build_token_uuid: "bt-old", build_token_name: "dashboard" }] : []);
      if (/^\/accounts\/[^/]+\/tokens\/permission_groups$/.test(u.pathname)) return ok([...BUILD_TOKEN_PERMISSIONS.map((name, i) => ({ id: `pg-${i}`, name })), { id: "pg-x", name: "Zone Read" }]);
      if (/^\/accounts\/[^/]+\/tokens$/.test(u.pathname) && req.method === "POST") return ok({ id: "tok-1", value: "secret-value" });
      if (u.pathname === "/accounts/acc/builds/tokens" && req.method === "POST") return ok({ build_token_uuid: "bt-new", build_token_name: "voidbase builds", cloudflare_token_id: "tok-1", owner_type: "user" });
      return Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 });
    } });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    return { builds: new CfApi("builds-token", base), creator: new CfApi("creator-token", base), calls };
  }

  test("the account's own is used when it has one, and nothing is created", async () => {
    const cf = cloudflare(true);
    expect(await ensureBuildToken(cf.builds, "acc", cf.creator)).toEqual({ uuid: "bt-old", created: false });
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /accounts/acc/builds/tokens"]);
  });

  test("without one, an account-scoped API token is created by the creator and registered with Workers Builds", async () => {
    const cf = cloudflare(false);
    expect(await ensureBuildToken(cf.builds, "acc", cf.creator)).toEqual({ uuid: "bt-new", created: true });
    const created = cf.calls.find((c) => /^\/accounts\/[^/]+\/tokens$/.test(c.path))!;
    expect(created.auth).toBe("Bearer creator-token");
    expect(created.body).toEqual({ name: "voidbase builds", policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.acc": "*" }, permission_groups: BUILD_TOKEN_PERMISSIONS.map((_, i) => ({ id: `pg-${i}` })) }] });
    const registered = cf.calls.find((c) => c.path === "/accounts/acc/builds/tokens" && c.method === "POST")!;
    expect(registered.auth).toBe("Bearer builds-token");
    expect(registered.body).toEqual({ build_token_name: "voidbase builds", build_token_secret: "secret-value", cloudflare_token_id: "tok-1" });
  });

  test("without one and without a creator, nothing is made and the caller is told so", async () => {
    const cf = cloudflare(false);
    expect(await ensureBuildToken(cf.builds, "acc", null)).toBeNull();
  });
});
