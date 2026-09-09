// A plugin creates what it owns, and only that; and bootstrap work runs once per isolate, in load order.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createKernel, load, onBootstrap, runBootstraps, type Kernel } from "../../src/server/kernel";
import { ensureCollections } from "../../src/server/plugins/collections";
import type { Plugin } from "../../src/server/plugins/manifest";
import type { Bindings } from "../../src/server/types";

const untouched = new Proxy({}, { get() { throw new Error("the database was touched"); } }) as unknown as D1Database;

describe("owning a collection", () => {
  test("a plugin may only create collections its manifest owns, and is refused before the database is touched", async () => {
    const plugin: Plugin = { manifest: { name: "shop", version: "1.0.0", tier: "community", voidbase: "*", collections: ["orders"] } };
    const err = await ensureCollections(plugin, untouched, [{ name: "orders", type: "base", fields: [] }, { name: "customers", type: "base", fields: [] }]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('creates the collection "customers" without owning it');
  });
});

describe("bootstrap work", () => {
  const plugin = (name: string, ran: string[], requires: ("payments@1")[] = []): Plugin => ({
    manifest: { name, version: "1.0.0", tier: "community", voidbase: "*", requires, ...(name === "stripe" ? { provides: ["payments@1"] } : {}) },
    apply(ctx: Kernel) { onBootstrap(ctx, async (env) => { ran.push(`${name}:${(env as unknown as { tag: string }).tag}`); }); if (name === "stripe") (ctx as unknown as { provide(n: string, v: unknown): void }).provide("payments@1", {}); },
  });

  test("runs once per isolate with the bindings, in load order, and is recorded under the plugin's name", async () => {
    const ran: string[] = [];
    const kernel = createKernel(new Hono() as never);
    await load(kernel, [plugin("checkout", ran, ["payments@1"]), plugin("stripe", ran)], "0.9.0");
    expect(kernel.bootstraps.map((b) => b.plugin)).toEqual(["stripe", "checkout"]);
    const env = { tag: "one" } as unknown as Bindings;
    await Promise.all([runBootstraps(kernel, env), runBootstraps(kernel, env)]);
    await runBootstraps(kernel, { tag: "two" } as unknown as Bindings);
    expect(ran).toEqual(["stripe:one", "checkout:one"]);
  });

  test("a failure is not remembered: the next request tries again", async () => {
    let attempts = 0;
    const kernel = createKernel(new Hono() as never);
    await load(kernel, [{ manifest: { name: "flaky", version: "1.0.0", tier: "community", voidbase: "*" }, apply(ctx) { onBootstrap(ctx, async () => { if (attempts++ === 0) throw new Error("not yet"); }); } }], "0.9.0");
    await expect(runBootstraps(kernel, {} as Bindings)).rejects.toThrow("not yet");
    await runBootstraps(kernel, {} as Bindings);
    expect(attempts).toBe(2);
  });
});
