// Auth as the core plugin, and the slot the core asks through.
//
// The implementation is measured by the conformance suites against PocketBase; what is measured here is the seam:
// the plugin is core, provides auth@1 and owns the auth collections; the loader reports an instance without it as
// missing its core interface; and the slot answers "nobody" and "not a superuser" without a provider, and the
// provider's own answers with one, looked up on every question so a replacement takes effect.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "../../src/server/errors";
import type { Auth } from "../../src/server/interfaces";
import { createKernel, load, using } from "../../src/server/kernel";
import { auth, provider } from "../../src/server/plugins/auth";
import { CORE, resolve } from "../../src/server/plugins/resolve";
import { SHIPPED } from "../../src/server/plugins/shipped";
import { authFields, authenticate, fromToken, isSuperuser, provideAuthLookup, requireSuperuser } from "../../src/server/auth-slot";
import type { AuthRecord, Bindings } from "../../src/server/types";

const superuser = { collection: { name: "_superusers" }, row: { id: "s1" } } as unknown as AuthRecord;
const user = { collection: { name: "users" }, row: { id: "u1" } } as unknown as AuthRecord;
const env = {} as Bindings;
const ctxWith = (record: AuthRecord | null) => ({ get: (k: string) => (k === "auth" ? record : undefined) }) as never;

describe("auth is the core plugin", () => {
  test("its manifest: core, provides auth@1, owns the auth collections, ships first", () => {
    expect(auth.manifest.tier).toBe("core");
    expect(auth.manifest.provides).toEqual(["auth@1"]);
    expect(auth.manifest.collections).toEqual(["_superusers", "_externalAuths", "_authOrigins", "_otps", "_mfas"]);
    expect(SHIPPED[0]).toBe("auth");
    expect(CORE).toContain("auth@1");
  });

  test("an instance without it loads, and says it is missing auth@1", async () => {
    const kernel = createKernel(new Hono() as never);
    const loaded = await load(kernel, [], "0.9.0");
    expect(loaded.missingCore).toContain("auth@1");
    expect(resolve([auth], "0.9.0").missingCore).not.toContain("auth@1");
  });

  test("with it, the kernel serves the whole contract and the routes are mounted on the app", async () => {
    const app = new Hono();
    const kernel = createKernel(app as never);
    const loaded = await load(kernel, [auth], "0.9.0");
    expect(loaded.providers["auth@1"]).toBe("auth");
    const served = using<Auth>(kernel, "auth@1");
    for (const part of ["authenticate", "fromToken", "schema", "collections", "isSuperuser"] as const) expect(typeof served[part]).toBe("function");
    expect(served.schema().map((f) => f.name)).toEqual(["id", "collectionId", "collectionName", "email", "emailVisibility", "verified"]);
    const paths = app.routes.map((r) => `${r.method} ${r.path}`);
    for (const p of ["POST /api/collections/:collection/auth-with-password", "POST /api/collections/:collection/auth-refresh", "GET /api/collections/:collection/auth-methods", "POST /api/collections/:collection/auth-with-oauth2"]) expect(paths).toContain(p);
  });

  test("a superuser is what the provider says it is", () => {
    expect(provider.isSuperuser(superuser)).toBe(true);
    expect(provider.isSuperuser(user)).toBe(false);
    expect(provider.isSuperuser(null)).toBe(false);
  });
});

describe("the slot the core asks through", () => {
  test("without a provider: nobody is signed in, nothing is a superuser, and a superuser route is a 401", async () => {
    provideAuthLookup(() => undefined);
    expect(await authenticate(new Request("http://x/", { headers: { authorization: "t" } }), env)).toBeNull();
    expect(await fromToken("t", env, "file")).toBeNull();
    expect(isSuperuser(superuser)).toBe(false);
    expect(authFields()).toEqual([]);
    const err = await Promise.resolve().then(() => requireSuperuser(ctxWith(null))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  test("with one: its answers, and a replacement takes effect on the next question", async () => {
    let calls = 0;
    const fake: Auth = { authenticate: async () => (calls++, user), fromToken: async () => user, schema: () => [{ name: "id", type: "text" }], collections: async () => ["users"], isSuperuser: (r) => r === superuser };
    provideAuthLookup(() => fake);
    expect(await authenticate(new Request("http://x/"), env)).toBe(user);
    expect(await fromToken("", env)).toBeNull(); // an empty token is nobody without asking
    expect(isSuperuser(superuser)).toBe(true);
    expect(isSuperuser(user)).toBe(false);
    expect(authFields()).toEqual(["id"]);
    const forbidden = await Promise.resolve().then(() => requireSuperuser(ctxWith(user))).catch((e: unknown) => e);
    expect((forbidden as ApiError).status).toBe(403);
    expect(requireSuperuser(ctxWith(superuser))).toBe(superuser);
    provideAuthLookup(() => undefined);
    expect(isSuperuser(superuser)).toBe(false);
    expect(calls).toBe(1);
  });
});
