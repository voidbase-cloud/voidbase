// `voidbase cloud plugins <instance> ls` against the answer an instance actually gives.
//
// The CLI prints the instance's own /api/plugins, and every field of it is the instance's rather than this
// package's: the CLI talks over HTTP to an instance of whatever version, running whatever plugins. `installer` is
// answered by the core itself (src/server/plugins/report.ts), so a voidbase instance always has one — but reading
// into a field of another program's JSON without looking first is how `ls` threw on an answer it was handed.
import { expect, test } from "bun:test";
import { runCloud, type Io } from "../../src/node/cloud-cli";

const SITE = "https://site.test";
const INSTANCE = { id: "i1", name: "vb-shop", url: "https://vb-shop.workers.dev", status: "live", release: "0.9.0", account: { id: "acc1" }, owner: "u1", superuserEmail: "owner@example.com" };
const GRAPH = { names: ["auth", "commerce"], origins: { auth: "shipped", commerce: "shipped" }, disabled: ["realtime"] };

/** the site and the instance, as the CLI reaches them: one session on the site, one minted on the instance */
async function ls(answer: Record<string, unknown>): Promise<{ code: number; out: string[]; err: string[] }> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    if (url.origin === SITE && path === "/api/vbcloud/instances") return Response.json({ instances: [INSTANCE] });
    if (url.origin === INSTANCE.url && path === "/api/collections/_superusers/auth-with-password") return Response.json({ token: "instance-session" });
    if (url.origin === INSTANCE.url && path === "/api/plugins") return Response.json(answer);
    return Response.json({ message: `no route for ${init?.method ?? "GET"} ${url.href}` }, { status: 404 });
  }) as typeof fetch;
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
  try {
    const code = await runCloud("plugins", ["vb-shop", "ls"], { url: SITE, token: "cli-token", email: "owner@example.com", password: "pw" }, io);
    return { code, out, err };
  } finally { globalThis.fetch = real; }
}

test("an instance that reports its installer: the line says where its plugins live", async () => {
  const r = await ls({ ...GRAPH, installer: { mode: "repository", repository: "acme/shop", branch: "master" } });
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toContain("installer:    repository acme/shop (master)");
  expect(r.out.join("\n")).toContain("running:      auth, commerce");
});

test("an instance that reports none: ls says so and still lists what is running, rather than throwing", async () => {
  const r = await ls(GRAPH);
  expect(r.err).toEqual([]);
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toContain("installer:    not reported by this instance");
  expect(r.out.join("\n")).toContain("disabled:     realtime");
});
