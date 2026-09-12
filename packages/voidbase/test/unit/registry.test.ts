// A marketplace is three GETs and a file, and this is the instance's side of the contract measured against the
// fixture marketplace under test/fixtures/registry: a directory, served here by Bun, which is also the point. Nothing
// about a marketplace needs a server of ours.
import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { resolve } from "node:path";
import { compareVersions, download, fetchIndex, integrityOf, pick, problemsWithIndex, verifyIntegrity } from "../../src/node/registry";
import { createKernel, load, whatLoaded } from "../../src/server/kernel";

const root = resolve(import.meta.dir, "../fixtures/registry");
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const file = Bun.file(resolve(root, `.${new URL(req.url).pathname}`));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

describe("a marketplace is three GETs and a file", () => {
  test("the fixture index is a registry an instance can read", async () => {
    const { url, index } = await fetchIndex(base);
    expect(url).toBe(`${base}/registry/v1/index.json`);
    expect(index.marketplace.name).toBe("fixture");
    expect(index.plugins.map((p) => p.name)).toEqual(["echo"]);
    expect(pick(index, "echo")?.version).toBe("0.1.0");
    expect(pick(index, "echo", "9.9.9")).toBeNull();
    expect(pick(index, "nothing")).toBeNull();
  });

  test("a version's bundle downloads, and its integrity holds", async () => {
    const { url, index } = await fetchIndex(base);
    const v = pick(index, "echo")!;
    const got = await download(url, v);
    expect(got.url).toBe(`${base}/registry/v1/plugins/echo/0.1.0/bundle.js`);
    expect(got.bytes.length).toBe(v.bytes);
    expect(got.verified).toBe(true);
    expect(await integrityOf(got.bytes)).toBe(v.integrity);
  });

  test("one changed byte fails the integrity check", async () => {
    const { url, index } = await fetchIndex(base);
    const v = pick(index, "echo")!;
    const { bytes } = await download(url, v);
    bytes[0] = bytes[0]! ^ 1;
    expect(await verifyIntegrity(bytes, v.integrity)).toBe(false);
  });

  test("the bundle is a plugin: it loads through the kernel and its route answers", async () => {
    const app = new Hono();
    const kernel = createKernel(app as never);
    const mod = (await import(resolve(root, "registry/v1/plugins/echo/0.1.0/bundle.js"))) as { default: { manifest: { name: string } } };
    await load(kernel, [mod.default as never], "0.9.0");
    expect(whatLoaded(kernel).names).toEqual(["echo"]);
    const res = await app.request("/api/echo");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo");
  });

  test("a marketplace that is not there is an error with the URL in it", async () => {
    const err = await fetchIndex(`${base}/nowhere`).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("/nowhere/registry/v1/index.json answered 404");
  });
});

describe("what an index has to say", () => {
  test("a good index has no problems", async () => {
    const { index } = await fetchIndex(base);
    expect(problemsWithIndex(index)).toEqual([]);
  });

  test("the reasons an index is refused are named, all at once", () => {
    const problems = problemsWithIndex({
      schemaVersion: 2,
      marketplace: { name: "x" },
      plugins: [{
        name: "Echo", repository: "Example/Repo", title: "", latest: "9.9.9",
        versions: [{ version: "0.1.0", manifest: { name: "other", version: "0.2.0", tier: "community", voidbase: "*" }, integrity: "md5-x", bundle: "", bytes: 0, source: { repository: "x", commit: "zz" } }],
      }],
    });
    const text = problems.join("\n");
    for (const needle of ["schemaVersion", "marketplace needs a name and a url", "generatedOn", "not a plugin name", "owner/name", "title is required", "summary is required", 'called "other"', 'says version "0.2.0"', "sha256-<base64>", "bundle's URL", "bundle's size", "source needs", "publishedOn", "latest has to be one of its versions"]) {
      expect(text).toContain(needle);
    }
  });

  test("a name served twice is refused: an instance qualifies collisions across marketplaces, not within one", async () => {
    const { index } = await fetchIndex(base);
    const twice = { ...index, plugins: [index.plugins[0]!, index.plugins[0]!] };
    expect(problemsWithIndex(twice).join()).toContain("echo is listed twice");
  });
});

describe("versions, compared the way latest and a pin need them", () => {
  test("numbers as numbers, prerelease before release, identifiers numeric before alphabetic", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0-beta.6", "0.9.0")).toBeLessThan(0);
    expect(compareVersions("0.9.0-beta.10", "0.9.0-beta.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0-beta", "0.9.0-beta.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});
