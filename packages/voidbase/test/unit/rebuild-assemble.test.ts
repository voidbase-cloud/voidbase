// A version of a vanilla instance put together inside the instance (src/server/rebuild/assemble.ts): a commit's tarball
// read the way GitHub serves it, the plugin's files hashed the way an install hashes them, its imports pointed at the
// release's provided modules, and the plugins chunk replaced under the names the core imports it by.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble, integrityOfFiles, pluginFilesFrom, pluginsChunkOf, rewriteImports, untarGz, type ModuleFile } from "../../src/server/rebuild/assemble";
import { integrityOfDir } from "../../src/node/installed";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const enc = new TextEncoder(); const dec = new TextDecoder();
const esm = (s: string): ModuleFile => ({ type: "esm", bytes: enc.encode(s) });

/** a repository at a commit, packed by tar the way GitHub packs one: one top-level directory, a path past 100 characters */
function tarball(files: Record<string, string>): { bytes: Uint8Array; dir: string } {
  const d = mkdtempSync(join(tmpdir(), "vb-assemble-")); dirs.push(d);
  const top = join(d, "voidbase-plugin-hello-0123456789abcdef0123456789abcdef01234567");
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(top, path, ".."), { recursive: true }); writeFileSync(join(top, path), body); }
  Bun.spawnSync(["tar", "--format=pax", "-czf", join(d, "repo.tgz"), "-C", d, "voidbase-plugin-hello-0123456789abcdef0123456789abcdef01234567"]);
  return { bytes: new Uint8Array(Bun.file(join(d, "repo.tgz")).size ? require("node:fs").readFileSync(join(d, "repo.tgz")) : []), dir: top };
}

const deep = `lib/${"nested/".repeat(14)}deep.js`;
const HELLO = {
  "manifest.json": JSON.stringify({ name: "hello", version: "0.1.0", tier: "community", voidbase: "*" }),
  "main.js": 'import { serve } from "@voidbase-cloud/voidbase/kernel";\nimport { Hono } from "hono";\nimport { greeting } from "./lib/greeting.js";\nexport default { apply(ctx) { serve(ctx, "hello@1", { greeting, Hono }); } };\n',
  "lib/greeting.js": `export { deep } from "./${deep.slice(4)}";\nexport const greeting = () => "hello";\n`,
  [deep]: 'export const deep = async () => (await import("@voidbase-cloud/voidbase/sdk")).VERSION;\n',
  "README.md": "not part of the plugin\n",
};

describe("a commit, as GitHub serves it", () => {
  test("every file comes out under its path without the top-level directory, a long one included", async () => {
    const { bytes } = tarball(HELLO);
    const files = await untarGz(bytes);
    expect([...files.keys()].sort()).toEqual(Object.keys(HELLO).sort());
    expect(dec.decode(files.get(deep)!)).toBe(HELLO[deep]);
  });

  test("the plugin's files are the ones an install keeps, and hash to what an install on Bun records", async () => {
    const { bytes, dir } = tarball(HELLO);
    const files = pluginFilesFrom(await untarGz(bytes));
    expect(files.has("README.md")).toBe(false);
    expect(await integrityOfFiles(files)).toBe(await integrityOfDir(dir));
    // under a directory, for a repository that holds more than one plugin
    const mono = new Map([...files].map(([p, b]) => [`packages/plugin-hello/${p}`, b] as const));
    expect([...pluginFilesFrom(mono, "packages/plugin-hello").keys()].sort()).toEqual([...files.keys()].sort());
  });
});

describe("a plugin's imports", () => {
  const release = new Set(["provided/voidbase/kernel.js", "provided/voidbase/sdk.js", "provided/hono.js"]);
  const has = (p: string) => release.has(p);

  test("a provided name becomes the relative path to its provided module; the plugin's own imports stay", () => {
    const out = rewriteImports(HELLO["main.js"], "plugins/hello/main.js", has);
    expect(out).toContain('from "../../provided/voidbase/kernel.js"');
    expect(out).toContain('from "../../provided/hono.js"');
    expect(out).toContain('from "./lib/greeting.js"');
    const dynamic = rewriteImports(HELLO[deep], `plugins/hello/${deep}`, has);
    expect(dynamic).toContain(`import("${"../".repeat(17)}provided/voidbase/sdk.js")`);
  });

  test("a name the release does not provide is refused, with the module and the name", () => {
    expect(() => rewriteImports('import _ from "lodash";\n', "plugins/hello/main.js", has, "hello 0.1.0")).toThrow("hello 0.1.0: plugins/hello/main.js imports lodash, which this instance's release does not provide to a plugin");
    expect(() => rewriteImports('import { cors } from "hono/cors";\n', "plugins/hello/main.js", has)).toThrow("imports hono/cors");
  });
});

describe("the next version", () => {
  const release = () => new Map<string, ModuleFile>([
    ["index.js", esm('import "./assets/app-X.js";\n')],
    ["assets/app-X.js", esm('import { n as installed } from "./_virtual_voidbase-plugins-abc.js";\n')],
    ["voidbase-plugins.js", esm('import { n as installed, r as projectConfig, t as disabled } from "./assets/_virtual_voidbase-plugins-abc.js";\nexport { disabled, installed, projectConfig };\n')],
    ["assets/_virtual_voidbase-plugins-abc.js", esm("var installed = [];\nvar disabled = [];\nvar projectConfig = {};\nexport { installed as n, projectConfig as r, disabled as t };\n")],
    ["provided/voidbase/kernel.js", esm("export const serve = () => {};\n")],
    ["provided/voidbase/sdk.js", esm('export const VERSION = "0.9.0";\n')],
    ["provided/hono.js", esm("export class Hono {}\n")],
  ]);

  test("finds the plugins chunk the core imports, and the names it imports it by", () => {
    expect(pluginsChunkOf(release())).toEqual({ path: "assets/_virtual_voidbase-plugins-abc.js", exportsAs: { installed: "n", disabled: "t", projectConfig: "r" } });
  });

  test("is the release with the plugins chunk replaced and each plugin's modules beside it", async () => {
    const files = pluginFilesFrom(await untarGz(tarball(HELLO).bytes));
    const next = assemble({ release: release(), plugins: [{ name: "hello", version: "0.1.0", marketplace: "https://m.example", files }], disabled: ["mail"] });
    expect(dec.decode(next.get("index.js")!.bytes)).toBe('import "./assets/app-X.js";\n');
    expect([...next.keys()].filter((k) => k.startsWith("plugins/")).sort()).toEqual(["plugins/hello/lib/greeting.js", `plugins/hello/${deep}`, "plugins/hello/main.js"].sort());
    const chunk = dec.decode(next.get("assets/_virtual_voidbase-plugins-abc.js")!.bytes);
    expect(chunk).toContain('import m0 from "../plugins/hello/main.js";');
    expect(chunk).toContain('var disabled = ["mail"];');
    expect(chunk.trim().split("\n").at(-1)).toBe("export { installed as n, projectConfig as r, disabled as t };");
    // the chunk it wrote runs: evaluated here with the plugin module stubbed, the list is the plugin with its manifest
    const body = chunk.replace(/^import m0 from .*$/m, "const m0 = { apply() {} };").replace(/^export \{[^}]*\};$/m, "return { installed, disabled, projectConfig };");
    const list = new Function(body)() as { installed: { plugin: { manifest: { name: string }; apply: unknown }; name: string; hooks: { hooks: unknown[] } }[]; disabled: string[] };
    expect(list.installed[0]!.plugin.manifest.name).toBe("hello");
    expect(typeof list.installed[0]!.plugin.apply).toBe("function");
    expect(list.installed[0]!.hooks.hooks).toEqual([]);
  });

  test("a plugin with pb_hooks, one whose manifest disagrees, and a release not built to be rebuilt are refused", async () => {
    const withHooks = new Map([...pluginFilesFrom(await untarGz(tarball(HELLO).bytes)), ["pb_hooks/x.pb.js", enc.encode("routerAdd()")]]);
    expect(() => assemble({ release: release(), plugins: [{ name: "hello", version: "0.1.0", marketplace: "m", files: withHooks }] })).toThrow("hello 0.1.0 carries pb_hooks");
    const files = pluginFilesFrom(await untarGz(tarball(HELLO).bytes));
    expect(() => assemble({ release: release(), plugins: [{ name: "hello", version: "0.2.0", marketplace: "m", files }] })).toThrow("its manifest.json says hello 0.1.0");
    const plain = release(); plain.delete("voidbase-plugins.js");
    expect(() => assemble({ release: plain, plugins: [] })).toThrow("this release was not built to be rebuilt");
  });
});
