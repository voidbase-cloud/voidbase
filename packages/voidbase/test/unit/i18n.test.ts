// `voidbase i18n extract`: the call forms it finds and the ones it does not, the default argument, the catalogue
// it merges (a key that vanished is kept and listed), the declaration file's union, and --check's answer, which is
// a build's exit code.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFrom, extractMessages, keysDeclaration, mergeCatalog, sourceFiles, type MessageUse } from "../../src/node/i18n";

const roots: string[] = [];
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "voidbase-i18n-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
};
const catalog = (root: string, locale: string) => JSON.parse(readFileSync(join(root, "i18n", `${locale}.json`), "utf8")) as Record<string, string>;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("the calls a scan finds", () => {
  const keys = (text: string) => extractFrom(text, "src/app.ts").map((u) => u.key);

  test("the three quotes, i18n.t, and a member call that is somebody else's t", () => {
    expect(keys('t("a"); t(\'b\'); t(`c`); i18n.t("d"); ctx.i18n.t("e");')).toEqual(["a", "b", "c", "d", "e"]);
    expect(keys('other.t("nope"); this.t("nope");')).toEqual([]);
    // a key is a literal: a template with an interpolation could never be looked up, so it is not a key
    expect(keys("t(`hi ${name}`);")).toEqual([]);
    expect(keys('t(""); t(key); t(...args);')).toEqual([]);
  });

  test("a call may carry more arguments, and the key keeps its escapes", () => {
    expect(keys('t("count", "{n} items", { n: 2 })')).toEqual(["count"]);
    expect(keys('t("it\\"s", "fine")')).toEqual(['it"s']);
  });

  test("the second string argument is the key's default, with the file and the line it was written on", () => {
    const uses = extractFrom('const a = 1;\nconst b = t("greeting", "Hello");\nconst c = t("plain");\n', "src/ui/app.ts");
    expect(uses).toEqual([
      { key: "greeting", default: "Hello", file: "src/ui/app.ts", line: 2 },
      { key: "plain", file: "src/ui/app.ts", line: 3 },
    ] as MessageUse[]);
  });

  test("the scan walks the source tree, skipping dependencies, build output and what it is not written in", () => {
    const root = project({
      "src/a.ts": 't("a")', "src/deep/b.tsx": 't("b")', "src/c.svelte": 't("c")', "src/notes.md": 't("d")',
      "src/node_modules/pkg/e.ts": 't("e")', "src/dist/f.js": 't("f")', "src/.hidden/g.ts": 't("g")',
    });
    expect(sourceFiles(join(root, "src")).map((f) => f.slice(root.length + 1).split("\\").join("/"))).toEqual(["src/a.ts", "src/c.svelte", "src/deep/b.tsx"]);
  });
});

describe("the catalogue", () => {
  const uses: MessageUse[] = [
    { key: "greeting", default: "Hello", file: "src/a.ts", line: 1 },
    { key: "plain", file: "src/a.ts", line: 2 },
  ];

  test("the source locale takes the call's default, else the key; every other locale gains it empty", () => {
    expect(mergeCatalog({}, uses, true).messages).toEqual({ greeting: "Hello", plain: "plain" });
    expect(mergeCatalog({}, uses, false).messages).toEqual({ greeting: "", plain: "" });
  });

  test("what a locale already has is kept, and a key nothing calls any more is kept and listed", () => {
    const merged = mergeCatalog({ greeting: "مرحبا", gone: "قديم" }, uses, false);
    expect(merged.messages).toEqual({ gone: "قديم", greeting: "مرحبا", plain: "" });
    expect(merged.added).toEqual(["plain"]);
    expect(merged.unused).toEqual(["gone"]);
    expect(merged.untranslated).toEqual(["plain"]);
    expect(Object.keys(merged.messages)).toEqual(["gone", "greeting", "plain"]); // sorted, so a diff is the change
  });

  test("keys.d.ts declares the union of the keys in use, the locales and a catalogue's type", () => {
    const d = keysDeclaration(["greeting", "nav.home"], ["en", "ar"], { dir: "src", files: 2 });
    expect(d).toContain('export type MessageKey =\n  | "greeting"\n  | "nav.home";');
    expect(d).toContain('export type Locale = "en" | "ar";');
    expect(d).toContain("export type Messages = Record<MessageKey, string>;");
    expect(keysDeclaration([], [], { dir: "src", files: 0 })).toContain("export type MessageKey = never;");
  });
});

describe("the command", () => {
  const source = 'import { t } from "@voidbase-cloud/sdk/i18n";\nexport const a = t("greeting", "Hello");\nexport const b = t("nav.home");\n';

  test("writes a catalogue per locale and the declaration file, and reports what changed", () => {
    const root = project({ "src/app.ts": source, "i18n/en.json": '{\n  "gone": "Old"\n}\n', "i18n/ar.json": '{\n  "nav.home": "الرئيسية"\n}\n' });
    const report = extractMessages({ root, locales: ["en", "ar", "fr"] });
    expect(report.keys).toEqual(["greeting", "nav.home"]);
    expect(report.written).toEqual(["i18n/en.json", "i18n/ar.json", "i18n/fr.json", "i18n/keys.d.ts"]);
    expect(catalog(root, "en")).toEqual({ gone: "Old", greeting: "Hello", "nav.home": "nav.home" });
    expect(catalog(root, "ar")).toEqual({ greeting: "", "nav.home": "الرئيسية" });
    expect(catalog(root, "fr")).toEqual({ greeting: "", "nav.home": "" });
    expect(readFileSync(join(root, "i18n/en.json"), "utf8").endsWith("}\n")).toBe(true);
    expect(readFileSync(join(root, "i18n/keys.d.ts"), "utf8")).toContain('export type MessageKey =\n  | "greeting"\n  | "nav.home";');
    // the key that vanished is in the file and in the report, never deleted behind someone's back
    expect(report.locales[0]?.unused).toEqual(["gone"]);
    expect(report.locales[1]?.untranslated).toEqual(["greeting"]);
    expect(report.lines.join("\n")).toContain("kept, no longer used: gone");
    expect(report.ok).toBe(false); // ar and fr have no text for greeting
  });

  test("running it again writes the same bytes", () => {
    const root = project({ "src/app.ts": source });
    extractMessages({ root, locales: ["en", "ar"] });
    const before = ["i18n/en.json", "i18n/ar.json", "i18n/keys.d.ts"].map((f) => readFileSync(join(root, f), "utf8"));
    extractMessages({ root, locales: ["en", "ar"] });
    expect(["i18n/en.json", "i18n/ar.json", "i18n/keys.d.ts"].map((f) => readFileSync(join(root, f), "utf8"))).toEqual(before);
  });

  test("--check writes nothing and fails on a key nobody has text for, naming where it came from", () => {
    const root = project({ "src/app.ts": source });
    const report = extractMessages({ root, locales: ["en"], check: true });
    expect(existsSync(join(root, "i18n"))).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.locales[0]?.untranslated).toEqual(["greeting", "nav.home"]);
    expect(report.lines.join("\n")).toContain("en has no text for: greeting (src/app.ts:2), nav.home (src/app.ts:3)");
  });

  test("--check passes once every locale has text, and fails again when a call adds a key", () => {
    const root = project({ "src/app.ts": source });
    extractMessages({ root, locales: ["en", "ar"] });
    writeFileSync(join(root, "i18n/ar.json"), JSON.stringify({ greeting: "مرحبا", "nav.home": "الرئيسية" }, null, 2) + "\n");
    expect(extractMessages({ root, locales: ["en", "ar"], check: true }).ok).toBe(true);
    writeFileSync(join(root, "src/app.ts"), source + 'export const c = t("cart.empty");\n');
    const failed = extractMessages({ root, locales: ["en", "ar"], check: true });
    expect(failed.ok).toBe(false);
    expect(failed.locales.map((l) => l.untranslated)).toEqual([["cart.empty"], ["cart.empty"]]);
  });

  test("the locales come from the argument, else VOIDBASE_LOCALES, else the catalogues already there, else en", () => {
    const root = project({ "src/app.ts": source, "i18n/pt-br.json": "{}", "i18n/de.json": "{}" });
    expect(extractMessages({ root }).locales.map((l) => l.locale)).toEqual(["de", "pt-br"]);
    const env = { ...process.env, VOIDBASE_LOCALES: "en,ar" };
    const before = process.env.VOIDBASE_LOCALES;
    try { process.env.VOIDBASE_LOCALES = env.VOIDBASE_LOCALES; expect(extractMessages({ root }).locales.map((l) => l.locale)).toEqual(["en", "ar"]); }
    finally { if (before === undefined) delete process.env.VOIDBASE_LOCALES; else process.env.VOIDBASE_LOCALES = before; }
    expect(extractMessages({ root, locales: ["FR", "en"] }).locales.map((l) => l.locale)).toEqual(["fr", "en"]);
  });

  test("a directory that is not there, and a catalogue that is not JSON, say so instead of writing over it", () => {
    const root = project({ "src/app.ts": source, "i18n/en.json": "{oops" });
    expect(() => extractMessages({ root, dir: "app" })).toThrow(/there is no app\/ under/);
    expect(() => extractMessages({ root, locales: ["en"] })).toThrow(/is not JSON/);
  });
});
