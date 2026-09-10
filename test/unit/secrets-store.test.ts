// Secrets Store bindings become strings on env, once per isolate, and nothing else on env is touched.
import { describe, expect, test } from "bun:test";
import { isSecretBinding, resolveSecretBindings } from "../../src/server/secrets-store";

const secret = (value: string) => { let reads = 0; return { binding: { get: async () => { reads++; return value; } }, reads: () => reads }; };

describe("what counts as a Secrets Store binding", () => {
  test("an object with get() and nothing a bucket, a database, a namespace, a workflow or a flag service has", () => {
    expect(isSecretBinding({ get: async () => "x" })).toBe(true);
    expect(isSecretBinding({ get: () => null, put: () => null })).toBe(false); // KV or R2
    expect(isSecretBinding({ prepare: () => null })).toBe(false); // D1
    expect(isSecretBinding({ get: () => null, idFromName: () => null })).toBe(false); // Durable Object namespace
    expect(isSecretBinding({ get: () => null, create: () => null })).toBe(false); // Workflow
    expect(isSecretBinding({ getBooleanValue: () => null, get: () => null })).toBe(false); // Flagship
    expect(isSecretBinding("plain")).toBe(false);
    expect(isSecretBinding(null)).toBe(false);
  });
});

describe("resolving them", () => {
  test("replaces each binding with its value, leaves the rest, and reads each secret once for the env object", async () => {
    const a = secret("alpha"), b = secret("beta");
    const env: Record<string, unknown> = { A: a.binding, B: b.binding, DB: { prepare: () => null }, PLAIN: "keep", N: 3 };
    await Promise.all([resolveSecretBindings(env), resolveSecretBindings(env)]);
    await resolveSecretBindings(env);
    expect(env.A).toBe("alpha"); expect(env.B).toBe("beta"); expect(env.PLAIN).toBe("keep"); expect(env.N).toBe(3);
    expect(typeof (env.DB as { prepare: unknown }).prepare).toBe("function");
    expect(a.reads()).toBe(1); expect(b.reads()).toBe(1);
  });
  test("a failure is not remembered: the next caller tries again", async () => {
    let attempts = 0;
    const env: Record<string, unknown> = { S: { get: async () => { if (attempts++ === 0) throw new Error("store down"); return "ok"; } } };
    await expect(resolveSecretBindings(env)).rejects.toThrow("store down");
    await resolveSecretBindings(env);
    expect(env.S).toBe("ok"); expect(attempts).toBe(2);
  });
  test("a name the deploy listed is resolved even as an RPC stub, whose shape says nothing (a Workflow step)", async () => {
    const stub = { get: async () => "from-the-stub", fetch: () => null, connect: () => null };
    const env: Record<string, unknown> = { VOIDBASE_STORE_SECRETS: "TOKEN, MISSING", TOKEN: stub, SERVICE: { fetch: () => null, connect: () => null } };
    await resolveSecretBindings(env);
    expect(env.TOKEN).toBe("from-the-stub"); expect(typeof (env.SERVICE as { fetch: unknown }).fetch).toBe("function");
  });
  test("an env with no bindings of that kind costs nothing", async () => {
    const env: Record<string, unknown> = { X: "1" };
    await resolveSecretBindings(env); expect(env.X).toBe("1");
  });
});
