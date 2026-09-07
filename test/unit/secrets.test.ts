import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets, parseSecretsDeclaration, readSecretsValues, secretsState } from "../../src/node/secrets";
import { generateSecretsDeclaration } from "../../src/adapter/codegen";

const dir = () => mkdtempSync(join(tmpdir(), "vb-secrets-"));

describe("pb_secrets", () => {
  test("the declaration is read, not run: an object of names with descriptions, or an array", () => {
    const d = parseSecretsDeclaration(`/// <reference path="../pb_data/types.d.ts" />\nsecrets({\n  SMTP_PASSWORD: "the SMTP password",\n  API_KEY: { description: "upstream" },\n  PLAIN: "",\n});\nthrow new Error("never evaluated");\n`);
    expect(d.names).toEqual(["SMTP_PASSWORD", "API_KEY", "PLAIN"]);
    expect(d.descriptions).toEqual({ SMTP_PASSWORD: "the SMTP password", API_KEY: "upstream" });
    expect(parseSecretsDeclaration(`secrets(["A_1", "B"])`).names).toEqual(["A_1", "B"]);
  });
  test("the adapter's defineSecrets is the same declaration in TypeScript", () => {
    const d = parseSecretsDeclaration(`import { defineSecrets } from "@voidbase-cloud/voidbase/adapter";\nexport default defineSecrets({ CF_OAUTH_CLIENT_SECRET: "OAuth client secret", GH_TOKEN: "" });\n`, "vb_secrets/main.ts", "defineSecrets");
    expect(d.names).toEqual(["CF_OAUTH_CLIENT_SECRET", "GH_TOKEN"]);
    expect(generateSecretsDeclaration(d)).toContain('secrets({\n  CF_OAUTH_CLIENT_SECRET: "OAuth client secret",\n  GH_TOKEN: "",\n});');
  });
  test("a name that is not an environment-variable name fails, by file", () => {
    expect(() => parseSecretsDeclaration(`secrets({ "smtp-password": "" })`, "pb_secrets/main.pb.js")).toThrow(/pb_secrets\/main\.pb\.js: "smtp-password" is not a secret name/);
    expect(() => parseSecretsDeclaration(`secrets("A")`)).toThrow(/object of names/);
  });
  test("values: strings stay, numbers and objects are stringified, nulls are skipped, non-objects fail", () => {
    const d = dir(); writeFileSync(join(d, "secrets.json"), JSON.stringify({ A: "x", N: 3, O: { k: 1 }, Z: null }));
    expect(readSecretsValues(d)).toEqual({ A: "x", N: "3", O: '{"k":1}' });
    writeFileSync(join(d, "secrets.json"), "[1]");
    expect(() => readSecretsValues(d)).toThrow(/must be an object/);
    expect(readSecretsValues(dir())).toBeNull();
  });
  test("state: provided, unprovided and undeclared names; values with no declaration are refused", () => {
    const d = dir();
    writeFileSync(join(d, "main.pb.js"), `secrets({ A: "", B: "" })`);
    writeFileSync(join(d, "secrets.json"), JSON.stringify({ A: "1", C: "3" }));
    const st = secretsState(d);
    expect([st.provided, st.unprovided, st.undeclared]).toEqual([["A"], ["B"], ["C"]]);
    const bare = dir(); writeFileSync(join(bare, "secrets.json"), JSON.stringify({ A: "1" }));
    expect(() => secretsState(bare)).toThrow(/nothing declares them/);
    const none = dir(); mkdirSync(join(none, "sub"));
    expect(secretsState(join(none, "sub")).declaration).toBeNull();
  });
  test("loadSecrets fills an environment without overwriting it and reports what is still missing", () => {
    const d = dir();
    writeFileSync(join(d, "main.pb.js"), `secrets({ A: "", B: "", C: "" })`);
    writeFileSync(join(d, "secrets.json"), JSON.stringify({ A: "from-file", B: "from-file" }));
    const env: Record<string, string | undefined> = { B: "from-shell" };
    const r = loadSecrets(d, env);
    expect(env).toEqual({ A: "from-file", B: "from-shell" });
    expect(r.loaded).toEqual(["A"]);
    expect(r.missing).toEqual(["C"]);
  });
});
