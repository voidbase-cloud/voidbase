// The previews plugin's pure and near-pure parts: the naming rule (slug and hash), the seed knob, what `before`
// bakes and refuses, the domains plugin standing down for a preview, the pull request comment (its body, and that
// it is posted once and updated after) against a fake GitHub, the prune decision against fake pull request states,
// and the seeding sequence against two fake instances. The account side runs in test/deploy-cf.ts against the mock.
import { afterEach, describe, expect, test } from "bun:test";
import type { DeployContext } from "../../src/node/deploy-plugin";
import { domainsDeploy } from "../../src/node/plugins/domains";
import { commentOnPullRequest, GH_TOKEN_KNOB, githubOf, MARKER, previewComment, previewsDeploy, pruneDecision, pruneMerged, PRUNE_KNOB, REPO_KNOB, SEED_KNOB, seedKindOf, seedPreview, upsertPreviewComment, type GitHubTarget } from "../../src/node/plugins/previews";
import { DOMAINS_VAR } from "../../src/server/plugins/domains";
import { branchHash, branchSlug, PREVIEW_OF_VAR, PREVIEW_VAR, previewPrefix, previews, previewsInfo, previewWorkerName } from "../../src/server/plugins/previews";
import { VERSION } from "../../src/server/version";

const ctxOf = (env: Record<string, string>, over: Partial<DeployContext> = {}): DeployContext => ({ name: "shop", account: { id: "acc" }, api: null, env, config: {}, vars: {}, url: null, log: () => undefined, local: false, dryRun: false, ...over });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
/** a fake fetch: every call recorded as "METHOD url", answered by the handler */
function fakeFetch(handle: (method: string, url: URL, init: RequestInit | undefined) => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); const method = (init?.method ?? "GET").toUpperCase(); calls.push(`${method} ${url.pathname}${url.search}`); return handle(method, url, init); }) as typeof fetch;
  return calls;
}
const bodyOf = async (init: RequestInit | undefined) => (typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {});

describe("the naming rule", () => {
  test("lowercase, [^a-z0-9] to a dash, at most 20 characters of branch, then a 4-character hash of the whole branch", () => {
    expect(branchSlug("feature/Login-Flow")).toBe(`feature-login-flow-${branchHash("feature/Login-Flow")}`);
    expect(branchHash("feature/Login-Flow")).toMatch(/^[a-z0-9]{4}$/);
    expect(branchSlug("renovate/some-very-long-dependency-name-bump")).toMatch(/^renovate-some-very-l-[a-z0-9]{4}$/);
    expect(branchSlug("---")).toMatch(/^branch-[a-z0-9]{4}$/);
    expect(branchSlug("Fix Bug #12")).toMatch(/^fix-bug-12-[a-z0-9]{4}$/);
  });
  test("two branches with one slug never collide; the same branch always names the same Worker", () => {
    const a = previewWorkerName("shop", "feature/login"), b = previewWorkerName("shop", "feature-login"), c = previewWorkerName("shop", "Feature/Login");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a.startsWith("shop-pr-feature-login-")).toBe(true);
    expect(previewWorkerName("shop", "feature/login")).toBe(a);
    expect(previewPrefix("shop")).toBe("shop-pr-");
  });
  test("the whole name is a Worker name: 63 characters at most, [a-z0-9-] only, the hash kept when the slug is cut", () => {
    const long = "x".repeat(54);
    const name = previewWorkerName(long, "feature/a-branch-with-a-very-long-name");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name).toBe(`${long}-pr-${branchHash("feature/a-branch-with-a-very-long-name")}`); // no room for words: the hash alone
    const mid = previewWorkerName("x".repeat(40), "feature/a-branch-with-a-very-long-name");
    expect(mid.length).toBe(63); expect(mid).toMatch(/^x{40}-pr-feature-a-bran-[a-z0-9]{4}$/);
  });
});

describe("the knobs", () => {
  test("the seed kind: schema unless said otherwise, data, or none; anything else refused", () => {
    expect(seedKindOf({})).toBe("schema"); expect(seedKindOf({ [SEED_KNOB]: " Schema " })).toBe("schema");
    expect(seedKindOf({ [SEED_KNOB]: "data" })).toBe("data");
    for (const v of ["0", "none", "off", "no", "false"]) expect(seedKindOf({ [SEED_KNOB]: v })).toBe("none");
    expect(() => seedKindOf({ [SEED_KNOB]: "rows" })).toThrow("VOIDBASE_PREVIEW_SEED=rows is not one of schema, data, none");
  });
  test("GitHub: the token and the repository from the environment, the API base from GITHUB_API_URL; nothing without a token", () => {
    expect(githubOf({}, "/nonexistent")).toBeNull();
    expect(githubOf({ [GH_TOKEN_KNOB]: "t", [REPO_KNOB]: "o/r", GITHUB_API_URL: "http://127.0.0.1:1/" }, "/nonexistent")).toEqual({ token: "t", repo: "o/r", api: "http://127.0.0.1:1" });
    expect(githubOf({ [GH_TOKEN_KNOB]: "t", [REPO_KNOB]: "not a repo" }, "/nonexistent")).toBeNull();
  });
});

describe("before", () => {
  test("bakes the branch and the production name, keeps workers.dev on, and does nothing without the knob", async () => {
    const ctx = ctxOf({ [PREVIEW_VAR]: "feature/x", [PREVIEW_OF_VAR]: "shop" }, { name: previewWorkerName("shop", "feature/x") });
    const lines: string[] = []; ctx.log = (l) => lines.push(l);
    await previewsDeploy.deploy!.before!(ctx);
    expect(ctx.config.workers_dev).toBe(true);
    expect(ctx.vars).toEqual({ [PREVIEW_VAR]: "feature/x", [PREVIEW_OF_VAR]: "shop" });
    expect(ctx.url).toBeNull();
    expect(lines.join("\n")).toContain("preview of shop for branch feature/x");
    const none = ctxOf({});
    await previewsDeploy.deploy!.before!(none);
    expect(none.config).toEqual({}); expect(none.vars).toEqual({});
  });
  test("refuses a Worker that is not the branch's preview name, a missing production name, and a bad seed knob", async () => {
    await expect(previewsDeploy.deploy!.before!(ctxOf({ [PREVIEW_VAR]: "feature/x", [PREVIEW_OF_VAR]: "shop" }, { name: "shop" }))).rejects.toThrow(`the Worker is shop, but a preview of shop for feature/x is ${previewWorkerName("shop", "feature/x")}`);
    await expect(previewsDeploy.deploy!.before!(ctxOf({ [PREVIEW_VAR]: "feature/x" }))).rejects.toThrow("voidbase deploy --preview feature/x");
    await expect(previewsDeploy.deploy!.before!(ctxOf({ [PREVIEW_VAR]: "feature/x", [PREVIEW_OF_VAR]: "shop", [SEED_KNOB]: "rows" }, { name: previewWorkerName("shop", "feature/x") }))).rejects.toThrow("VOIDBASE_PREVIEW_SEED=rows");
  });
});

describe("the domains plugin stands down for a preview", () => {
  test("with VOIDBASE_PREVIEW baked, the production hostnames are neither validated, attached, claimed nor detached", async () => {
    const ctx = ctxOf({ [DOMAINS_VAR]: "example.com, not a host" }, { vars: { [PREVIEW_VAR]: "feature/x", [PREVIEW_OF_VAR]: "shop" } });
    const lines: string[] = []; ctx.log = (l) => lines.push(l);
    await domainsDeploy.deploy!.before!(ctx);
    expect(ctx.config).toEqual({}); expect(ctx.url).toBeNull(); expect(ctx.vars[DOMAINS_VAR]).toBeUndefined();
    expect(lines).toEqual(["custom domains example.com, not a host: skipped, a preview stays on workers.dev"]);
    const api = { json: async () => { throw new Error("must not be called"); }, raw: async () => { throw new Error("must not be called"); } } as unknown as NonNullable<DeployContext["api"]>;
    await domainsDeploy.deploy!.remove!({ ...ctx, api });
    await domainsDeploy.deploy!.after!({ ...ctx, api, url: "https://x.workers.dev" });
    // and without the var, the same environment is the production case
    await expect(domainsDeploy.deploy!.before!(ctxOf({ [DOMAINS_VAR]: "example.com, not a host" }))).rejects.toThrow('invalid custom domain "not a host"');
  });
});

describe("the pull request comment", () => {
  const at = "2026-09-11T10:00:00.000Z";
  test("the body: the marker first, the address, the API and the dashboard, what it was seeded with, the version", () => {
    const body = previewComment({ branch: "feature/x", url: "https://shop-pr-feature-x-ab12.sub.workers.dev", of: "shop", seed: "schema", seeded: true, at });
    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    expect(body).toContain("**voidbase preview** for `feature/x`: https://shop-pr-feature-x-ab12.sub.workers.dev");
    expect(body).toContain("- REST API: https://shop-pr-feature-x-ab12.sub.workers.dev/api/");
    expect(body).toContain("- Dashboard: https://shop-pr-feature-x-ab12.sub.workers.dev/_/");
    expect(body).toContain("- seeded from `shop` (schema)");
    expect(body).toContain(`- voidbase ${VERSION}, updated ${at}`);
    expect(body).toContain(`${PRUNE_KNOB}=1`);
    expect(previewComment({ branch: "b", url: "https://u", of: "shop", seed: "data", seeded: "sign in failed", at })).toContain("- seeding from `shop` (data) failed: sign in failed");
    expect(previewComment({ branch: "b", url: "https://u", of: "shop", seed: "none", seeded: false, at })).toContain("- not seeded");
    const gone = previewComment({ branch: "feature/x", url: null, of: "shop", seed: "none", seeded: false, removed: true, at });
    expect(gone).toBe(`${MARKER}\n**voidbase preview** for \`feature/x\`: removed ${at}. The Worker, its database, its bucket and its queue are gone; a push to the branch makes a new one.`);
  });

  test("posted once on the branch's open pull request, updated after, never a second one; a closed one is not commented", async () => {
    const gh: GitHubTarget = { token: "t", repo: "o/r", api: "https://gh.test" };
    const pulls = [{ number: 7, state: "open", merged_at: null, html_url: "https://github.com/o/r/pull/7", head: { ref: "feature/x" } }, { number: 3, state: "closed", merged_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/o/r/pull/3", head: { ref: "feature/x" } }];
    const comments: { id: number; body: string }[] = [{ id: 1, body: "someone else's comment" }];
    const calls = fakeFetch(async (method, url, init) => {
      if (url.pathname === "/repos/o/r/pulls") { expect(url.searchParams.get("head")).toBe("o:feature/x"); expect(url.searchParams.get("state")).toBe("all"); return Response.json(pulls); }
      if (url.pathname === "/repos/o/r/issues/7/comments" && method === "GET") return Response.json(comments);
      if (url.pathname === "/repos/o/r/issues/7/comments" && method === "POST") { const c = { id: 42, body: String((await bodyOf(init)).body) }; comments.push(c); return Response.json(c, { status: 201 }); }
      if (url.pathname === "/repos/o/r/issues/comments/42" && method === "PATCH") { comments[1]!.body = String((await bodyOf(init)).body); return Response.json(comments[1]); }
      return Response.json({ message: `unexpected ${method} ${url.pathname}` }, { status: 500 });
    });
    expect(await commentOnPullRequest(gh, "feature/x", `${MARKER}\nfirst`)).toBe("pull request #7: preview comment posted (https://github.com/o/r/pull/7)");
    expect(await commentOnPullRequest(gh, "feature/x", `${MARKER}\nsecond`)).toBe("pull request #7: preview comment updated (https://github.com/o/r/pull/7)");
    expect(await upsertPreviewComment(gh, 7, `${MARKER}\nthird`)).toEqual({ id: 42, created: false });
    expect(comments).toEqual([{ id: 1, body: "someone else's comment" }, { id: 42, body: `${MARKER}\nthird` }]);
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("PATCH")).length).toBe(2);
    // the open pull request is the one commented, whatever order GitHub lists them in
    pulls.reverse();
    expect(await commentOnPullRequest(gh, "feature/x", `${MARKER}\nfourth`)).toContain("#7");
    // a preview whose pull request is closed: only an existing comment is updated (the removal note), never a new one
    pulls.length = 0; pulls.push({ number: 3, state: "closed", merged_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/o/r/pull/3", head: { ref: "feature/x" } });
    globalThis.fetch = realFetch;
    const calls2 = fakeFetch(async (method, url) => { if (url.pathname === "/repos/o/r/pulls") return Response.json(pulls); if (url.pathname === "/repos/o/r/issues/3/comments" && method === "GET") return Response.json([]); return Response.json({ message: "unexpected" }, { status: 500 }); });
    expect(await commentOnPullRequest(gh, "feature/x", "gone", { onlyUpdate: true })).toBe("pull request #3: no preview comment to update");
    expect(calls2.some((c) => c.startsWith("POST"))).toBe(false);
    expect(await commentOnPullRequest(null, "feature/x", "x")).toContain("not commented (set VOIDBASE_GH_TOKEN");
    expect(await commentOnPullRequest(gh, "other", "x")).toBe("pull request: none for other in o/r yet; the next deploy of the branch comments once one is open");
  });
});

describe("prune --merged", () => {
  test("the decision: kept while a pull request is open, removed once every one is merged or closed, left alone without any", () => {
    expect(pruneDecision([])).toBe("no pull request");
    expect(pruneDecision([{ state: "open", merged: false }])).toBe("keep");
    expect(pruneDecision([{ state: "closed", merged: true }, { state: "open", merged: false }])).toBe("keep");
    expect(pruneDecision([{ state: "closed", merged: true }])).toBe("remove");
    expect(pruneDecision([{ state: "closed", merged: false }, { state: "closed", merged: true }])).toBe("remove");
  });
  test("against fake previews and pull requests (dry run): the merged and the closed go, the open and the unknown stay", async () => {
    const scripts = ["shop", "shop-pr-merged-aaaa", "shop-pr-open-bbbb", "shop-pr-closed-cccc", "shop-pr-none-dddd", "shop-pr-mystery-eeee", "other-pr-x-ffff"];
    const branchOf: Record<string, string> = { "shop-pr-merged-aaaa": "merged", "shop-pr-open-bbbb": "open", "shop-pr-closed-cccc": "closed", "shop-pr-none-dddd": "none" };
    const api = { json: async (_m: string, path: string) => {
      if (path === "/accounts/acc/workers/scripts") return { result: scripts.map((id) => ({ id, created_on: "2026-09-11T00:00:00Z" })) };
      if (path === "/accounts/acc/workers/subdomain") return { result: { subdomain: "sub" } };
      const m = /^\/accounts\/acc\/workers\/scripts\/([^/]+)\/settings$/.exec(path);
      if (m) return { result: { bindings: branchOf[m[1]!] ? [{ type: "plain_text", name: PREVIEW_VAR, text: branchOf[m[1]!] }, { type: "plain_text", name: PREVIEW_OF_VAR, text: "shop" }, { type: "d1", name: "DB" }] : [] } };
      throw new Error(`unexpected ${path}`);
    } } as unknown as NonNullable<DeployContext["api"]>;
    const prs: Record<string, { state: string; merged_at: string | null }[]> = { merged: [{ state: "closed", merged_at: "2026-01-01T00:00:00Z" }], open: [{ state: "open", merged_at: null }], closed: [{ state: "closed", merged_at: null }], none: [] };
    fakeFetch(async (_m, url) => { const head = url.searchParams.get("head") ?? ""; const branch = head.slice(head.indexOf(":") + 1); return Response.json((prs[branch] ?? []).map((p, i) => ({ number: i + 1, html_url: "u", head: { ref: branch }, ...p }))); });
    const lines: string[] = [];
    const r = await pruneMerged({ api, account: "acc", production: "shop", github: { token: "t", repo: "o/r", api: "https://gh.test" }, dryRun: true, log: (l) => lines.push(l) });
    expect(r.removed).toEqual(["shop-pr-closed-cccc", "shop-pr-merged-aaaa"]);
    expect(r.kept).toEqual(["shop-pr-mystery-eeee", "shop-pr-none-dddd", "shop-pr-open-bbbb"]);
    expect(lines).toContain("dry run: would remove the preview shop-pr-merged-aaaa (merged): pull request #1 is merged");
    expect(lines).toContain("dry run: would remove the preview shop-pr-closed-cccc (closed): pull request #1 is closed");
    expect(lines).toContain("preview shop-pr-open-bbbb (open): kept, pull request #1 is open");
    expect(lines).toContain("preview shop-pr-none-dddd (none): kept, no pull request yet");
    expect(lines).toContain("preview shop-pr-mystery-eeee: kept, its branch is not known (no VOIDBASE_PREVIEW var)");
    // without GitHub nothing is pruned, and the reason is said
    const r2 = await pruneMerged({ api, account: "acc", production: "shop", github: null, dryRun: true, log: (l) => lines.push(l) });
    expect(r2.removed).toEqual([]); expect(r2.kept.length).toBe(5);
    expect(lines.at(-1)).toContain("none pruned (set VOIDBASE_GH_TOKEN");
  });
});

describe("seeding", () => {
  test("a schema backup on production, downloaded, uploaded to the preview, restored with createMissing, deleted on both sides", async () => {
    const prod = "https://shop.sub.workers.dev", prev = "https://shop-pr-x-abcd.sub.workers.dev";
    const archive = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]);
    let created: Record<string, unknown> | null = null, uploaded = "", restoreBody: Record<string, unknown> | null = null; let restoring = 0; let prevSignIns = 0;
    const calls = fakeFetch(async (method, url, init) => {
      const side = url.origin === prod ? "prod" : url.origin === prev ? "prev" : "?"; const p = url.pathname;
      if (p === "/api/collections/_superusers/auth-with-password") { const b = await bodyOf(init); expect(b).toEqual({ identity: "admin@example.com", password: "pw" }); if (side === "prev" && prevSignIns++ === 0) return Response.json({ message: "not yet" }, { status: 503 }); return Response.json({ token: `tok-${side}` }); }
      if (p === "/api/health") { if (side === "prev" && restoring > 0) { restoring--; return Response.json({ code: 200, data: { canBackup: false } }); } return Response.json({ code: 200, data: { canBackup: true } }); }
      if (side === "prod" && p === "/api/backups" && method === "POST") { created = await bodyOf(init); return new Response(null, { status: 204 }); }
      if (side === "prod" && p === "/api/backups" && method === "GET") return Response.json(created ? [{ key: created.name }] : []);
      if (side === "prod" && p === "/api/files/token") return Response.json({ token: "ft" });
      if (side === "prod" && p === `/api/backups/${created?.name}` && method === "GET") { expect(url.searchParams.get("token")).toBe("ft"); return new Response(archive); }
      if (side === "prev" && p === "/api/backups/upload") { const fd = await new Request("http://x", { method: "POST", body: init?.body as BodyInit }).formData(); const f = fd.get("file") as File; uploaded = f.name; expect(new Uint8Array(await f.arrayBuffer())).toEqual(archive); return new Response(null, { status: 204 }); }
      if (side === "prev" && p === `/api/backups/${created?.name}/restore`) { restoreBody = await bodyOf(init); restoring = 2; return new Response(null, { status: 204 }); }
      if (side === "prev" && p === "/api/backups" && method === "GET") return Response.json([{ key: created?.name, restore: { restored: ["posts", "users"] } }]);
      if (p.startsWith("/api/backups/") && method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ message: `unexpected ${side} ${method} ${p}` }, { status: 500 });
    });
    const lines: string[] = [];
    const r = await seedPreview({ source: prod, target: prev, email: "admin@example.com", password: "pw", kind: "schema", log: (l) => lines.push(l), reachTimeoutMs: 5000 });
    expect(created).toMatchObject({ kind: "schema" });
    expect(String((created as unknown as { name: string }).name)).toMatch(/^preview_seed_\d{14}\.zip$/);
    expect(uploaded).toBe(r.name);
    expect(restoreBody).toEqual({ createMissing: true });
    expect(r.restored).toEqual(["posts", "users"]);
    expect(prevSignIns).toBe(2); // the preview was not up on the first try, and was waited for
    expect(calls.filter((c) => c.startsWith("DELETE")).length).toBe(2);
    expect(lines).toEqual([`seeded ${prev} from ${prod} (schema: posts, users)`]);
  }, 20_000);
});

describe("the runtime half", () => {
  test("is a shipped plugin that reports the baked vars and provides nothing else", () => {
    expect(previews.manifest.name).toBe("previews"); expect(previews.apply).toBeUndefined();
    expect(previewsInfo({ [PREVIEW_VAR]: "feature/x", [PREVIEW_OF_VAR]: "shop" })).toEqual({ of: "shop", branch: "feature/x" });
    expect(previewsInfo({})).toEqual({});
  });
});
