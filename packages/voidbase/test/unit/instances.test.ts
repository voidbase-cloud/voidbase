// Only the voidbase instances answer: a Worker is listed when its /api/health says it is voidbase, and never otherwise.
import { expect, test } from "bun:test";
import type { CfApi } from "../../src/cloud/rest";
import { probeWorkers, voidbaseOf } from "../../src/node/instances";

test("a health answer is voidbase only when it carries a version and a plugin list", () => {
  expect(voidbaseOf({ message: "API is healthy.", code: 200, data: { voidbase: { version: "0.9.0", plugins: ["auth", "realtime"] } } })).toEqual({ version: "0.9.0", plugins: ["auth", "realtime"] });
  expect(voidbaseOf({ message: "API is healthy.", code: 200, data: {} })).toBeNull();            // a plain PocketBase
  expect(voidbaseOf({ ok: true })).toBeNull();                                                   // some other Worker
  expect(voidbaseOf("hello")).toBeNull();
  expect(voidbaseOf({ data: { voidbase: { version: 1, plugins: [] } } })).toBeNull();
});

test("of three Workers on an account, only the one that answers as voidbase is listed, and it says it came from a release", async () => {
  const api = { json: async (_m: string, path: string) => path.endsWith("/workers/scripts") ? { result: [{ id: "shop" }, { id: "blog-proxy" }, { id: "gone" }] } : path.endsWith("/shop/settings") ? { result: { tags: ["voidbase", "voidbase-release:0.9.0-beta.60"] } } : { result: { subdomain: "acct" } } } as unknown as CfApi;
  const fetchImpl = (async (url: string) => {
    if (url.startsWith("https://shop.")) return Response.json({ message: "API is healthy.", code: 200, data: { voidbase: { version: "0.9.0-beta.60", plugins: ["auth"] } } });
    if (url.startsWith("https://blog-proxy.")) return new Response("<html>", { status: 200 });
    throw new Error("unreachable");
  }) as unknown as typeof fetch;
  const { instances, asked } = await probeWorkers(api, "acct-id", fetchImpl);
  expect(asked).toBe(3);
  expect(instances).toEqual([{ name: "shop", url: "https://shop.acct.workers.dev", version: "0.9.0-beta.60", plugins: ["auth"], kind: "vanilla" }]);
});

test("a voidbase Worker with no release tag was deployed from a project, and one whose tags cannot be read says so", async () => {
  const health = (async () => Response.json({ message: "API is healthy.", code: 200, data: { voidbase: { version: "0.9.0", plugins: [] } } })) as unknown as typeof fetch;
  const untagged = { json: async (_m: string, path: string) => path.endsWith("/workers/scripts") ? { result: [{ id: "blog" }] } : path.endsWith("/settings") ? { result: { tags: [] } } : { result: { subdomain: "acct" } } } as unknown as CfApi;
  expect((await probeWorkers(untagged, "acct-id", health)).instances[0]!.kind).toBe("extended");
  const unreadable = { json: async (_m: string, path: string) => { if (path.endsWith("/settings")) throw new Error("403"); return path.endsWith("/workers/scripts") ? { result: [{ id: "blog" }] } : { result: { subdomain: "acct" } }; } } as unknown as CfApi;
  expect((await probeWorkers(unreadable, "acct-id", health)).instances[0]!.kind).toBe("unknown");
});
