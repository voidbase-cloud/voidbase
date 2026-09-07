import { describe as group, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browser, defineSecrets, local, number, secret, server, string, url } from "../../src/env/define";
import { loadSecrets, parseSecretsDeclaration, readSecretsValues, secretsState } from "../../src/node/secrets";
import { generateSecretsDeclaration } from "../../src/adapter/codegen";

const dir = () => mkdtempSync(join(tmpdir(), "vb-secrets-"));
const DEFINE = resolve(import.meta.dir, "../../src/env/define.ts");
const declaration = `import { defineSecrets, secret, server, browser, string, number, url } from ${JSON.stringify(DEFINE)};
export default defineSecrets({
  SMTP_PASSWORD: secret(string(), "the SMTP password"),
  MAX_USERS: server(number().default(5)),
  ADMIN_EMAILS: server(string().default("")),
  SITE_URL: browser(url().optional()),
  REQUIRED_PLAIN: server(string()),
});
`;

group("pb_secrets: the declaration", () => {
  test("every key states its tier: the audience wrappers, or Void's .secret()/.public() markers; a bare validator is refused", () => {
    const d = defineSecrets({ A: string().secret(), B: server(string()), C: url().public(), D: secret(string(), "d"), E: browser(number()), F: local(string(), "the deploy token") });
    expect(d.names).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(d.of("secret")).toEqual(["A", "D"]);
    expect(d.of("server")).toEqual(["B"]);
    expect(d.of("public")).toEqual(["C", "E"]);
    expect(d.of("local")).toEqual(["F"]);
    expect(d.entries.D.description).toBe("d");
    expect(() => defineSecrets({ BARE: string() })).toThrow(/BARE has no tier/);
  });
  test("values are parsed through the validators: defaults filled in, numbers coerced, bad and missing values named without their values", async () => {
    const d = defineSecrets({ N: server(number().default(5)), U: server(url()), S: string().secret(), O: server(string().optional()) });
    const r = await d.evaluate({ U: "not a url", N: "7" });
    expect(r.values.N).toBe(7);
    expect(r.stored).toEqual({ N: "7" });
    expect(r.missing).toEqual(["S"]);
    expect(r.invalid.map((i) => i.name)).toEqual(["U"]);
    expect(JSON.stringify(r)).not.toContain("not a url");
    await expect(d.read({ U: "https://x.test", S: "s" })).resolves.toEqual({ N: 5, U: "https://x.test", S: "s" });
    await expect(d.read({})).rejects.toThrow(/U: missing.*S: missing|S: missing.*U: missing/);
  });
  test("a lookup function is a source too, and a tier filter reads only what that tier may see", async () => {
    const d = defineSecrets({ S: secret(string()), P: browser(string()) });
    const env: Record<string, string> = { S: "hidden", P: "shown" };
    expect(await d.read((n) => env[n], ["public"])).toEqual({ P: "shown" } as never);
    expect((await d.info()).map((i) => `${i.name}:${i.access}:${i.optional}`)).toEqual(["S:secret:false", "P:public:false"]);
  });
  test("a name that is not an environment-variable name, or a value that is no validator, fails at definition", () => {
    expect(() => defineSecrets({ "smtp-password": secret(string()) })).toThrow(/"smtp-password" is not a configuration name/);
    expect(() => defineSecrets({ A: "nope" as never })).toThrow(/A needs a validator/);
  });
  test("read statically for the build: names, tiers and descriptions, without running the file", () => {
    const d = parseSecretsDeclaration(declaration + 'throw new Error("never evaluated");\n', "vb_secrets/main.ts");
    expect(d.names).toEqual(["SMTP_PASSWORD", "MAX_USERS", "ADMIN_EMAILS", "SITE_URL", "REQUIRED_PLAIN"]);
    expect(d.access).toEqual({ SMTP_PASSWORD: "secret", MAX_USERS: "server", ADMIN_EMAILS: "server", SITE_URL: "public", REQUIRED_PLAIN: "server" });
    expect(d.descriptions).toEqual({ SMTP_PASSWORD: "the SMTP password" });
    expect(parseSecretsDeclaration(`export default defineSecrets({ A: secret(z.string(), "a"), B: browser(z.string()), C: server(z.string()), D: local(string()), E: string().secret(), F: url().optional().public() })`).access).toEqual({ A: "secret", B: "public", C: "server", D: "local", E: "secret", F: "public" });
    expect(() => parseSecretsDeclaration(`export default defineSecrets({ BARE: string() })`, "vb_secrets/main.ts")).toThrow(/BARE has no tier/);
    expect(() => parseSecretsDeclaration(`export default {}`, "x.ts")).toThrow(/does not call defineSecrets/);
    expect(generateSecretsDeclaration(d)).toContain('export { default } from "../../vb_secrets/main";');
  });
});

group("pb_secrets: the directory", () => {
  test("values: strings stay, numbers and objects are stringified, nulls are skipped, non-objects fail", () => {
    const d = dir(); writeFileSync(join(d, "secrets.json"), JSON.stringify({ A: "x", N: 3, O: { k: 1 }, Z: null }));
    expect(readSecretsValues(d)).toEqual({ A: "x", N: "3", O: '{"k":1}' });
    writeFileSync(join(d, "secrets.json"), "[1]");
    expect(() => readSecretsValues(d)).toThrow(/must be an object/);
    expect(readSecretsValues(dir())).toBeNull();
  });
  test("state: the declaration is imported; provided, unprovided and undeclared names; values with no declaration are refused", async () => {
    const d = dir();
    writeFileSync(join(d, "main.ts"), declaration);
    writeFileSync(join(d, "secrets.json"), JSON.stringify({ SMTP_PASSWORD: "1", STRAY: "3" }));
    const st = await secretsState(d);
    expect(st.definition?.names.length).toBe(5);
    expect([st.provided, st.unprovided, st.undeclared]).toEqual([["SMTP_PASSWORD"], ["MAX_USERS", "ADMIN_EMAILS", "SITE_URL", "REQUIRED_PLAIN"], ["STRAY"]]);
    expect(st.info.find((i) => i.name === "MAX_USERS")).toMatchObject({ access: "server", optional: true, fallback: "5" });
    const bare = dir(); writeFileSync(join(bare, "secrets.json"), JSON.stringify({ A: "1" }));
    await expect(secretsState(bare)).rejects.toThrow(/nothing declares them/);
    const none = dir(); mkdirSync(join(none, "sub"));
    expect((await secretsState(join(none, "sub"))).definition).toBeNull();
  });
  test("loadSecrets fills an environment (defaults included) without overwriting it, and reports what is missing or refused", async () => {
    const d = dir();
    writeFileSync(join(d, "main.ts"), declaration);
    writeFileSync(join(d, "secrets.json"), JSON.stringify({ SMTP_PASSWORD: "from-file", MAX_USERS: "9", SITE_URL: "nope" }));
    const env: Record<string, string | undefined> = { MAX_USERS: "3" };
    const r = await loadSecrets(d, env);
    expect(env).toEqual({ MAX_USERS: "3", SMTP_PASSWORD: "from-file", ADMIN_EMAILS: "" });
    expect(r.loaded).toEqual(["SMTP_PASSWORD", "ADMIN_EMAILS"]);
    expect(r.missing).toEqual(["REQUIRED_PLAIN"]);
    expect(r.invalid.map((i) => i.name)).toEqual(["SITE_URL"]);
  });
});
