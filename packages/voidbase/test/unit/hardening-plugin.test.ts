// Middleware a plugin provides, held in place by the app: present with the plugin, gone without it.
//
// The slot here is the one app.ts registers, rebuilt over a small app so it can be measured on its own: the kernel
// loads after the routes, so a plugin cannot `use("*")` for itself, and the app asks the provider at request time.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "../../src/server/errors";
import type { Hardening } from "../../src/server/interfaces";
import { createKernel, load, using, type Kernel } from "../../src/server/kernel";
import { hardening } from "../../src/server/plugins/hardening";
import type { AppEnv } from "../../src/server/types";

function appOver(kernel: Kernel) {
  const app = new Hono<AppEnv>();
  const limits = () => using<Hardening | undefined>(kernel, "hardening@1");
  app.use("*", (c, next) => limits()?.bodyLimit(c, next) ?? next());
  app.post("/api/collections/posts/records", (c) => c.json({ ok: true }));
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.text(String(err), 500)));
  return app;
}

const oversized = { method: "POST", headers: { "content-length": String(33 << 20) } };

describe("hardening@1 through the slot", () => {
  test("with the plugin, a body over the limit is refused before the route runs", async () => {
    const kernel = createKernel(new Hono() as never);
    const loaded = await load(kernel, [hardening], "0.9.0");
    expect(loaded.providers["hardening@1"]).toBe("hardening");
    const provided = using<Hardening>(kernel, "hardening@1");
    expect(typeof provided.rateLimit).toBe("function");

    const res = await appOver(kernel).request("/api/collections/posts/records", oversized);
    expect(res.status).toBe(413);
    expect((await res.json() as { message: string }).message).toBe("Request entity too large.");
  });

  test("without it, the slot passes through: no provider, no limits", async () => {
    const kernel = createKernel(new Hono() as never);
    await load(kernel, [], "0.9.0");
    const res = await appOver(kernel).request("/api/collections/posts/records", oversized);
    expect(res.status).toBe(200);
  });
});
