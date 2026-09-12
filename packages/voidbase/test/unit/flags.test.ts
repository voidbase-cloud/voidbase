// Flags: a boolean tier in the declaration, and per-request values from Flagship written onto the request's env.
import { describe, expect, test } from "bun:test";
import { boolean, defineSecrets, flag, server, string } from "../../src/env/define";
import { declaredFlags, withFlags } from "../../src/server/flags";

describe("the flag tier", () => {
  test("a flag is a boolean; anything else is refused at definition", () => {
    const d = defineSecrets({ NEW_UI: flag(boolean().default(false), "the new UI"), NAME: server(string()) });
    expect(d.of("flag")).toEqual(["NEW_UI"]);
    expect(() => defineSecrets({ MODE: flag(string()) })).toThrow(/a flag is a boolean/);
  });
});

describe("evaluating at request time", () => {
  const fakeFlags = (answers: Record<string, boolean>, seen: unknown[]) => ({ getBooleanValue: async (key: string, fallback: boolean, ctx?: unknown) => { seen.push([key, ctx]); return key in answers ? answers[key]! : fallback; } });
  test("declared flags are evaluated with the targeting key and land on a copy of env as strings", async () => {
    const seen: unknown[] = [];
    const env = { VOIDBASE_FLAGS: JSON.stringify({ NEW_UI: false, BETA: true }), FLAGS: fakeFlags({ NEW_UI: true }, seen), PLAIN: "x" };
    const out = await withFlags(env, "user-42");
    expect(out).not.toBe(env);
    expect(out.NEW_UI).toBe("true"); expect(out.BETA).toBe("true"); expect(out.PLAIN).toBe("x");
    expect(seen).toEqual([["NEW_UI", { targetingKey: "user-42" }], ["BETA", { targetingKey: "user-42" }]]);
    expect(declaredFlags(env)).toEqual({ NEW_UI: false, BETA: true });
  });
  test("without the binding, or without declared flags, env is returned as it is: the baked defaults answer", async () => {
    const env = { VOIDBASE_FLAGS: JSON.stringify({ NEW_UI: false }), NEW_UI: "false" };
    expect(await withFlags(env, "k")).toBe(env);
    const bare = { FLAGS: fakeFlags({}, []) };
    expect(await withFlags(bare, "k")).toBe(bare);
  });
  test("a failing evaluation falls back to the flag's baked default", async () => {
    const env = { VOIDBASE_FLAGS: JSON.stringify({ NEW_UI: true }), FLAGS: { getBooleanValue: async () => { throw new Error("down"); } } };
    expect((await withFlags(env, "k")).NEW_UI).toBe("true");
  });
});
