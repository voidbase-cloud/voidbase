// The deploy-time plugin surface: who is discovered, in what order, and how the hooks run, with fake plugins.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployContext, DeployPlugin } from "../../src/node/deploy-plugin";
import { discoverDeployPlugins, runDeployHooks, type DeployRegistry } from "../../src/node/deploy-plugins";
import { writeLock, emptyLock } from "../../src/node/installed";
import { integrityOf } from "../../src/node/registry";

const fake = (name: string, calls: string[] = []): DeployPlugin => ({
  name, manifest: { name, version: "0.1.0", tier: "official", voidbase: "*" },
  deploy: {
    async before(ctx) { calls.push(`${name}:before:${ctx.dryRun ? "dry" : "real"}`); ctx.vars[`${name.toUpperCase()}_VAR`] = "1"; },
    async after(ctx) { calls.push(`${name}:after:${ctx.url ?? "-"}`); },
    async remove() { calls.push(`${name}:remove`); },
  },
});
const ctxOf = (over: Partial<DeployContext> = {}): DeployContext => ({ name: "w", account: { id: "acc" }, api: null, env: {}, config: {}, vars: {}, url: null, log: () => undefined, local: false, dryRun: false, ...over });

let root = ""; let pluginsDir = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "vb-deploy-plugins-")); pluginsDir = join(root, "pb_plugins"); mkdirSync(pluginsDir); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** an installed plugin as `voidbase plugins add` leaves it: bundle.js, the lock pinning its bytes, and maybe a deploy.js */
async function install(name: string, deployJs?: string): Promise<void> {
  const dir = join(pluginsDir, name); mkdirSync(dir, { recursive: true });
  const bundle = `export default { manifest: { name: ${JSON.stringify(name)}, version: "0.1.0", tier: "community", voidbase: "*" } };\n`;
  writeFileSync(join(dir, "bundle.js"), bundle);
  if (deployJs !== undefined) writeFileSync(join(dir, "deploy.js"), deployJs);
  const { readLock } = await import("../../src/node/installed");
  const lock = readLock(root);
  lock.plugins[name] = { version: "0.1.0", integrity: await integrityOf(new TextEncoder().encode(bundle)), marketplace: "https://m.example", source: { repository: "x/y", commit: "0" }, installedOn: "2026-09-11" };
  writeLock(root, lock);
}
const deployJs = (name: string, extra = "") => `export default { name: ${JSON.stringify(name)}, manifest: { name: ${JSON.stringify(name)}, version: "0.1.0", tier: "community", voidbase: "*" }, deploy: { async before(ctx) { ctx.vars.FROM_${name.toUpperCase()} = "yes"; ${extra} }, async after(ctx) { ctx.log("${name} after"); } } };\n`;

describe("discovery", () => {
  test("shipped plugins come first in SHIPPED order, whatever order the registry lists them in; names without a deploy half are skipped", async () => {
    const registry: DeployRegistry = { seo: async () => fake("seo"), auth: async () => fake("auth"), mail: async () => fake("mail") };
    const found = await discoverDeployPlugins(pluginsDir, { registry, shipped: ["auth", "realtime", "mail", "seo"] });
    expect(found.map((p) => `${p.name}/${p.origin}`)).toEqual(["auth/shipped", "mail/shipped", "seo/shipped"]);
  });

  test("an installed plugin with a deploy.js beside its bundle follows the shipped ones; one without is not a deploy plugin", async () => {
    await install("zulu", deployJs("zulu")); await install("alpha"); await install("mike", deployJs("mike"));
    const found = await discoverDeployPlugins(pluginsDir, { registry: { seo: async () => fake("seo") }, shipped: ["seo"] });
    expect(found.map((p) => p.name)).toEqual(["seo", "mike", "zulu"]); // the lockfile is sorted by name
    expect(found[1]!.origin).toBe("https://m.example 0.1.0");
    expect(found[1]!.file).toBe(join(pluginsDir, "mike", "deploy.js"));
  });

  test("a shipped plugin the project turned off, or shadowed by an installed one, does not run at deploy time either", async () => {
    await install("seo", deployJs("seo"));
    writeLock(root, { ...(await import("../../src/node/installed")).readLock(root), disabled: ["mail"] });
    const found = await discoverDeployPlugins(pluginsDir, { registry: { seo: async () => fake("seo"), mail: async () => fake("mail"), ai: async () => fake("ai") }, shipped: ["seo", "mail", "ai"] });
    expect(found.map((p) => `${p.name}/${p.origin}`)).toEqual(["ai/shipped", "seo/https://m.example 0.1.0"]);
  });

  test("no lockfile: the shipped ones alone, and nothing is verified", async () => {
    const found = await discoverDeployPlugins(pluginsDir, { registry: { ai: async () => fake("ai") }, shipped: ["ai"] });
    expect(found.map((p) => p.name)).toEqual(["ai"]);
  });

  test("a deploy.js that names another plugin is refused by file", async () => {
    await install("odd", `export default { name: "other", manifest: {} };\n`);
    await expect(discoverDeployPlugins(pluginsDir, { registry: {}, shipped: [] })).rejects.toThrow(/odd\/deploy\.js calls itself "other", but it is odd's/);
  });

  test("a deploy.js that is not a deploy plugin is refused by file", async () => {
    await install("shapeless", `export default 42;\n`);
    await expect(discoverDeployPlugins(pluginsDir, { registry: {}, shipped: [] })).rejects.toThrow(/shapeless\/deploy\.js does not export a deploy plugin/);
  });

  test("a tampered bundle refuses the deploy the way it refuses the build", async () => {
    await install("echo", deployJs("echo"));
    writeFileSync(join(pluginsDir, "echo", "bundle.js"), "export default {};\n");
    await expect(discoverDeployPlugins(pluginsDir, { registry: {}, shipped: [] })).rejects.toThrow(/not the bytes voidbase\.lock promises/);
  });
});

describe("running the hooks", () => {
  test("each phase runs in discovery order, sees the shared context, and reports who ran", async () => {
    const calls: string[] = [];
    const registry: DeployRegistry = { mail: async () => fake("mail", calls), ai: async () => fake("ai", calls) };
    await install("zed", deployJs("zed"));
    const found = await discoverDeployPlugins(pluginsDir, { registry, shipped: ["mail", "ai"] });
    const ctx = ctxOf();
    expect(await runDeployHooks("before", found, ctx)).toEqual(["mail", "ai", "zed"]);
    expect(ctx.vars).toEqual({ MAIL_VAR: "1", AI_VAR: "1", FROM_ZED: "yes" });
    const lines: string[] = [];
    expect(await runDeployHooks("after", found, { ...ctx, url: "https://x.test", log: (l) => lines.push(l) })).toEqual(["mail", "ai", "zed"]);
    expect(await runDeployHooks("remove", found, ctx)).toEqual(["mail", "ai"]); // zed has no remove hook
    expect(calls).toEqual(["mail:before:real", "ai:before:real", "mail:after:https://x.test", "ai:after:https://x.test", "mail:remove", "ai:remove"]);
    expect(lines).toEqual(["zed after"]);
  });

  test("a plugin without hooks, or without that hook, is skipped", async () => {
    const bare: DeployPlugin = { name: "bare", manifest: { name: "bare", version: "1", tier: "official", voidbase: "*" } };
    const found = await discoverDeployPlugins(pluginsDir, { registry: { bare: async () => bare }, shipped: ["bare"] });
    expect(await runDeployHooks("before", found, ctxOf())).toEqual([]);
  });

  test("a hook that throws fails the deploy with the plugin and the phase named, and the ones after it do not run", async () => {
    const calls: string[] = [];
    const broken: DeployPlugin = { ...fake("broken"), deploy: { async before() { throw new Error("zone not on the account"); } } };
    const found = await discoverDeployPlugins(pluginsDir, { registry: { mail: async () => fake("mail", calls), broken: async () => broken, ai: async () => fake("ai", calls) }, shipped: ["mail", "broken", "ai"] });
    await expect(runDeployHooks("before", found, ctxOf())).rejects.toThrow("deploy plugin broken (shipped) failed in before: zone not on the account");
    expect(calls).toEqual(["mail:before:real"]);
  });

  test("dryRun reaches the hooks as it is", async () => {
    const calls: string[] = [];
    const found = await discoverDeployPlugins(pluginsDir, { registry: { mail: async () => fake("mail", calls) }, shipped: ["mail"] });
    await runDeployHooks("before", found, ctxOf({ dryRun: true }));
    expect(calls).toEqual(["mail:before:dry"]);
  });
});
