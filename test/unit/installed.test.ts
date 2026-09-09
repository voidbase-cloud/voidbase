// Installing from a marketplace, measured against the fixture marketplace and a temporary project: what the lockfile
// records, what the bytes have to be, what two marketplaces serving one name do, and that an installed bundle loads
// through the kernel with the instance's own modules behind its imports.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addPlugin, enablePlugin, listPlugins, locate, outsideRange, pluginsModuleSource, providedImport, readLock, removePlugin, updatePlugins, verifyInstalled } from "../../src/node/installed";
import { integrityOf } from "../../src/node/registry";
import { loadInstalled } from "../../src/platform/node/plugins";
import { createKernel, load, whatLoaded } from "../../src/server/kernel";

const fixture = resolve(import.meta.dir, "../fixtures/registry");
const serveFixture = (rewrite?: (path: string, text: string) => string) => Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    const file = Bun.file(resolve(fixture, `.${path}`));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return rewrite && path.endsWith(".json") ? new Response(rewrite(path, await file.text()), { headers: { "content-type": "application/json" } }) : new Response(file);
  },
});
const one = serveFixture();
const two = serveFixture();
// a marketplace where echo has a newer version: the same bytes, a later record, which is enough for update's mechanics
const newer = serveFixture((path, text) => {
  if (path.endsWith("index.json")) { const i = JSON.parse(text); const v = { ...i.plugins[0].versions[0], version: "0.2.0", manifest: { ...i.plugins[0].versions[0].manifest, version: "0.2.0" }, bundle: "plugins/echo/0.1.0/bundle.js" }; i.plugins[0].versions.push(v); i.plugins[0].latest = "0.2.0"; return JSON.stringify(i); }
  return text;
});
const url = (s: ReturnType<typeof Bun.serve>) => `http://127.0.0.1:${s.port}`;
afterAll(() => { one.stop(true); two.stop(true); newer.stop(true); });

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "voidbase-project-")); });
const opts = (marketplaces: string) => ({ voidbaseVersion: "0.9.0", env: { VOIDBASE_PLUGIN_MARKETPLACES: marketplaces } });

describe("voidbase plugins add", () => {
  test("downloads the bundle, verifies it, and pins it in voidbase.lock", async () => {
    const a = await addPlugin(root, "echo", opts(url(one)));
    expect(a).toMatchObject({ name: "echo", version: "0.1.0", marketplace: url(one), shadows: false });
    expect(existsSync(join(root, "pb_plugins/echo/bundle.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "pb_plugins/echo/release.json"), "utf8")).manifest.name).toBe("echo");
    const lock = readLock(root);
    expect(lock.plugins.echo).toMatchObject({ version: "0.1.0", marketplace: url(one), source: { repository: "example/voidbase-plugin-echo" } });
    expect(lock.plugins.echo!.integrity).toBe(await integrityOf(new Uint8Array(readFileSync(join(root, "pb_plugins/echo/bundle.js")))));
    expect((await addPlugin(root, "echo", opts(url(one)))).unchanged).toBe(true);
  });

  test("a name nobody serves, and a version that does not exist, are refused with the marketplaces named", async () => {
    await expect(addPlugin(root, "nothing", opts(url(one)))).rejects.toThrow(`nothing is not served by ${url(one)}`);
    await expect(addPlugin(root, "echo@9.9.9", opts(url(one)))).rejects.toThrow("echo@9.9.9 is not served");
  });

  test("a plugin outside this voidbase's range is refused before anything is written", async () => {
    const strict = serveFixture((path, text) => text.replaceAll('"voidbase": "*"', '"voidbase": "^2.0.0"'));
    try {
      await expect(addPlugin(root, "echo", opts(url(strict)))).rejects.toThrow("works against voidbase ^2.0.0, and this is 0.9.0");
      expect(existsSync(join(root, "pb_plugins"))).toBe(false);
    } finally { strict.stop(true); }
  });

  test("one name from two marketplaces is ambiguous, and --marketplace settles it", async () => {
    const both = `${url(one)},${url(two)}`;
    await expect(addPlugin(root, "echo", opts(both))).rejects.toThrow(`echo is served by ${url(one)} and ${url(two)}; say which`);
    const a = await addPlugin(root, "echo", { ...opts(both), marketplace: url(two) });
    expect(a.marketplace).toBe(url(two));
    expect(readLock(root).plugins.echo!.marketplace).toBe(url(two));
  });

  test("the lockfile's marketplaces are the default, and the environment outranks them", async () => {
    const found = await locate([url(one)], "echo", undefined);
    expect(found.version.version).toBe("0.1.0");
    expect(listPlugins(root, {}).marketplaces).toEqual(["https://marketplace.voidbase.cloud"]);
    expect(listPlugins(root, { VOIDBASE_PLUGIN_MARKETPLACES: `${url(one)}/` }).marketplaces).toEqual([url(one)]);
  });
});

describe("what an instance checks before it loads anything", () => {
  test("a changed byte in pb_plugins is refused by name", async () => {
    await addPlugin(root, "echo", opts(url(one)));
    expect((await verifyInstalled(root)).installed.map((p) => p.name)).toEqual(["echo"]);
    const file = join(root, "pb_plugins/echo/bundle.js");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n// tampered\n`);
    await expect(verifyInstalled(root)).rejects.toThrow("pb_plugins/echo/bundle.js is not the bytes voidbase.lock promises for echo 0.1.0");
    await expect(loadInstalled(join(root, "pb_plugins"))).rejects.toThrow("not the bytes");
  });

  test("a missing bundle is refused, with the way out named", async () => {
    await addPlugin(root, "echo", opts(url(one)));
    rmSync(join(root, "pb_plugins/echo"), { recursive: true });
    await expect(verifyInstalled(root)).rejects.toThrow("voidbase plugins update echo, or voidbase plugins remove echo");
  });

  test("the installed bundle loads through the kernel, and its route answers", async () => {
    await addPlugin(root, "echo", opts(url(one)));
    const { installed, disabled } = await loadInstalled(join(root, "pb_plugins"));
    expect(installed.map((p) => `${p.name}@${p.version}`)).toEqual(["echo@0.1.0"]);
    expect(disabled).toEqual([]);
    const app = new Hono();
    const kernel = createKernel(app as never);
    await load(kernel, installed.map((p) => p.plugin), "0.9.0", { origins: { echo: `${url(one)} 0.1.0` } });
    expect(whatLoaded(kernel).origins.echo).toBe(`${url(one)} 0.1.0`);
    const res = await app.request("/api/echo");
    expect(await res.text()).toBe("echo");
  });

  test("a bundle's imports resolve to the instance's own modules, not to node_modules", async () => {
    // written by hand, the way a marketplace would serve it: it imports the kernel entry point and uses it
    const dir = join(root, "pb_plugins/uses-kernel"); mkdirSync(dir, { recursive: true });
    const code = `import { using } from "@voidbase-cloud/voidbase/kernel";\nimport { Hono } from "hono";\nexport default { manifest: { name: "uses-kernel", version: "1.0.0", tier: "community", voidbase: "*" }, apply(ctx) { ctx.app.get("/api/uses-kernel", (c) => c.text(\`\${typeof using} \${typeof Hono}\`)); } };\n`;
    writeFileSync(join(dir, "bundle.js"), code);
    writeFileSync(join(root, "voidbase.lock"), JSON.stringify({ lockfileVersion: 1, marketplaces: [], plugins: { "uses-kernel": { version: "1.0.0", integrity: await integrityOf(new TextEncoder().encode(code)), marketplace: "http://x", source: { repository: "x/y", commit: "0123456" }, installedOn: "2026-09-09" } }, disabled: [] }));
    const { installed } = await loadInstalled(join(root, "pb_plugins"));
    const app = new Hono();
    await load(createKernel(app as never), installed.map((p) => p.plugin), "0.9.0");
    expect(await (await app.request("/api/uses-kernel")).text()).toBe("function function");
  });

  test("a bundle that says it is something else than the lockfile is refused", async () => {
    await addPlugin(root, "echo", opts(url(one)));
    const lock = readLock(root); lock.plugins.echo!.version = "0.9.9";
    writeFileSync(join(root, "voidbase.lock"), JSON.stringify(lock));
    await expect(loadInstalled(join(root, "pb_plugins"))).rejects.toThrow("says it is echo 0.1.0, and voidbase.lock says echo 0.9.9");
  });

  test("the Worker's module imports every verified bundle by path", async () => {
    await addPlugin(root, "echo", opts(url(one)));
    removePlugin(root, "backups");
    const src = await pluginsModuleSource(join(root, "pb_plugins"));
    expect(src).toContain(`import p0 from ${JSON.stringify(join(root, "pb_plugins/echo/bundle.js"))};`);
    expect(src).toContain('export const installed = [{ plugin: p0, name: "echo", version: "0.1.0"');
    expect(src).toContain('export const disabled = ["backups"];');
    expect(await pluginsModuleSource(join(mkdtempSync(join(tmpdir(), "empty-")), "pb_plugins"))).toContain("export const installed = [];");
  });
});

describe("remove, enable, update", () => {
  test("removing an installed plugin deletes it; removing a shipped one turns it off, and enable turns it back on", async () => {
    await addPlugin(root, "echo", opts(url(one)));
    expect(removePlugin(root, "echo")).toBe("removed");
    expect(existsSync(join(root, "pb_plugins/echo"))).toBe(false);
    expect(readLock(root).plugins.echo).toBeUndefined();
    expect(removePlugin(root, "hardening")).toBe("disabled");
    expect(removePlugin(root, "hardening")).toBe("already-disabled");
    expect(listPlugins(root).shipped.find((p) => p.name === "hardening")?.state).toBe("disabled");
    expect(enablePlugin(root, "hardening")).toBe("enabled");
    expect(enablePlugin(root, "hardening")).toBe("not-disabled");
    expect(() => removePlugin(root, "nothing")).toThrow("nothing is not installed and does not ship with voidbase");
    expect(() => enablePlugin(root, "echo")).toThrow("echo does not ship with voidbase");
  });

  test("an installed plugin with a shipped plugin's name shadows it, which the listing says", async () => {
    const shadow = serveFixture((path, text) => text.replaceAll('"echo"', '"backups"').replaceAll("plugins/echo/", "plugins/echo/"));
    try {
      const a = await addPlugin(root, "backups", opts(url(shadow)));
      expect(a.shadows).toBe(true);
      expect(listPlugins(root).shipped.find((p) => p.name === "backups")?.state).toBe("shadowed");
    } finally { shadow.stop(true); }
  });

  test("update brings a plugin to the latest its own marketplace serves, and leaves the rest alone", async () => {
    await addPlugin(root, "echo", opts(url(newer)));
    expect(readLock(root).plugins.echo!.version).toBe("0.2.0");
    // pin it back to 0.1.0 and ask for an update: it goes to its own marketplace, not to whatever the environment says
    await addPlugin(root, "echo@0.1.0", { ...opts(url(newer)), force: true });
    expect(readLock(root).plugins.echo!.version).toBe("0.1.0");
    const u = await updatePlugins(root, undefined, opts(url(one)));
    expect(u.updated).toEqual([{ name: "echo", from: "0.1.0", to: "0.2.0", marketplace: url(newer) }]);
    expect((await updatePlugins(root, "echo", opts(url(one)))).current).toEqual(["echo"]);
    await expect(updatePlugins(root, "nothing", opts(url(one)))).rejects.toThrow("nothing is not installed");
  });

  test("before a version jump, the plugins whose range excludes the target are named", async () => {
    await addPlugin(root, "echo", opts(url(one)));
    expect(outsideRange(root, "1.0.0")).toEqual([]);
    const rec = join(root, "pb_plugins/echo/release.json"); const r = JSON.parse(readFileSync(rec, "utf8")); r.manifest.voidbase = "^0.9.0"; writeFileSync(rec, JSON.stringify(r));
    expect(outsideRange(root, "1.0.0")).toEqual([{ name: "echo", range: "^0.9.0" }]);
    expect(outsideRange(root, "0.9.5")).toEqual([]);
  });
});

describe("what an installed bundle's bare imports mean when the Worker is built", () => {
  const exportsMap = { ".": "./src/node/index.ts", "./kernel": "./src/server/kernel.ts", "./plugins/collections": "./src/server/plugins/collections.ts" };
  test("voidbase's own name and subpaths map to its files through the package's exports map", () => {
    expect(providedImport("@voidbase-cloud/voidbase/kernel", "/pkg", exportsMap)).toEqual({ file: "/pkg/src/server/kernel.ts" });
    expect(providedImport("@voidbase-cloud/voidbase", "/pkg", exportsMap)).toEqual({ file: "/pkg/src/node/index.ts" });
    expect(providedImport("@voidbase-cloud/voidbase/plugins/collections", "/pkg", exportsMap)).toEqual({ file: "/pkg/src/server/plugins/collections.ts" });
  });
  test("a subpath the map does not export is nothing, and so is anything that is not voidbase or hono", () => {
    expect(providedImport("@voidbase-cloud/voidbase/secret", "/pkg", exportsMap)).toBeNull();
    expect(providedImport("left-pad", "/pkg", exportsMap)).toBeNull();
    expect(providedImport("@voidbase-cloud/voidbase-site", "/pkg", exportsMap)).toBeNull();
  });
  test("hono resolves from the package's own copy", () => {
    expect(providedImport("hono", "/pkg", exportsMap)).toEqual({ from: "/pkg/package.json" });
    expect(providedImport("hono/cors", "/pkg", exportsMap)).toEqual({ from: "/pkg/package.json" });
  });
});
