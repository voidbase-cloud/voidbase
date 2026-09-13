// lookup (src/server/kernel.ts): an interface a plugin builds on without requiring it, read the way cordis allows a
// plugin to read one it did not inject, and nothing when no plugin provides it.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createKernel, load, lookup, serve, using, type Kernel } from "../../src/server/kernel";

test("a plugin reads a capability it did not require through lookup, and gets nothing where none is provided", async () => {
  let kept: Kernel | null = null;
  const provider = { manifest: { name: "provider", version: "0.1.0", tier: "community" as const, voidbase: "*", provides: ["zzprobe@1" as const] }, apply(ctx: Kernel) { serve(ctx, "zzprobe@1", { hello: "world" }); } };
  const reader = { manifest: { name: "reader", version: "0.1.0", tier: "community" as const, voidbase: "*" }, apply(ctx: Kernel) { kept = ctx; } };
  await load(createKernel(new Hono() as never), [provider, reader], "0.9.0");
  // what cordis refuses: a plugin's own context has no service it did not inject
  expect(() => using(kept!, "zzprobe@1")).toThrow("without inject");
  expect(lookup<{ hello: string }>(kept!, "zzprobe@1")).toEqual({ hello: "world" });
  expect(lookup(kept!, "absent@1")).toBeUndefined();
});
