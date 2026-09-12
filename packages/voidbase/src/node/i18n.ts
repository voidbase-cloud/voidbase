// `voidbase i18n extract`: the project half of the roadmap's "Translations, as an official plugin". The content
// half is the translations plugin (src/server/plugins/translations.ts); this is the other one, the interface
// strings, which live in the project, are typed, and fail the build when a key has no text rather than showing a
// key to a reader.
//
// The command scans the source for translation calls, writes one catalogue per locale and a declaration file of
// the keys, and says what changed. It deliberately has no runtime: nothing here is imported by an app. The files
// are the contract, and `@voidbase-cloud/sdk/i18n` reads them:
//
//   i18n/<locale>.json   a flat JSON object, key -> text, sorted by key, 2-space indented, one trailing newline.
//                        The source locale (the first) carries the call's own default (`t("greeting", "Hello")`)
//                        or, with no default, the key itself. Every other locale gains a new key as "", which is
//                        what "untranslated" means everywhere below.
//   i18n/keys.d.ts       `export type MessageKey = "greeting" | ...`, plus `Locale` and `Messages`. Types only,
//                        no runtime: a client typed against MessageKey makes an unknown key a compile error.
//
// A key that is in a catalogue and no longer called is kept, never deleted silently, and listed in the report: the
// text is someone's work, and a key comes back as often as it goes. It is left out of MessageKey, so a client that
// still names it stops compiling, which is the whole point of the declaration file.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** one call the scan found: the key, the default the call carries, and where it was written */
export interface MessageUse { key: string; default?: string; file: string; line: number }
/** what happened to one locale's catalogue */
export interface CatalogReport {
  locale: string; file: string; source: boolean; keys: number;
  /** keys in use that the file did not have (written, or listed by --check) */
  added: string[];
  /** keys the file has that nothing calls any more: kept in the file, named here */
  unused: string[];
  /** keys in use with no text in this locale */
  untranslated: string[];
}
export interface ExtractReport {
  dir: string; out: string; files: number; uses: MessageUse[]; keys: string[];
  locales: CatalogReport[]; written: string[]; lines: string[];
  /** false when --check found a key with no text in some locale: the caller exits 1 */
  ok: boolean;
}

export interface ExtractOptions {
  /** the project root; every path below is resolved against it (default: the working directory) */
  root?: string;
  /** the directory to scan (default "src") */
  dir?: string;
  /** where the catalogues go (default "i18n") */
  out?: string;
  /** the locales, the first the source; default: VOIDBASE_LOCALES, else the catalogues already there, else "en" */
  locales?: string[];
  /** report only, write nothing, and fail when a key has no text somewhere */
  check?: boolean;
  /** the file extensions scanned */
  extensions?: string[];
}

/** the files a scan looks at: what a Void app's interface strings are written in */
export const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue", ".astro", ".html"];
/** never walked into: build output, dependencies, and anything hidden */
export const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "pb_public", "pb_data", "test-results"]);
export const KEYS_FILE = "keys.d.ts";

/**
 * A translation call: `t("key")`, `t('key')`, `t(`key`)`, `i18n.t("key")` (any `.i18n.t`, so `ctx.i18n.t` counts),
 * with an optional second string argument as the key's default. `t` after a `.` is somebody else's method and is
 * not a translation call. The call may carry more arguments: the match ends at the `,` or the `)` after the key.
 */
const CALL = /(?:(?<![$\w])i18n\s*\.\s*|(?<![$\w.]))t\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*(?:,\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3\s*)?[,)]/g;

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
/** the string a literal holds: the escapes a key or a default can carry, the rest as written */
export function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, esc: string) => {
    if (esc.startsWith("u{")) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16));
    if (esc[0] === "u" || esc[0] === "x") return String.fromCharCode(parseInt(esc.slice(1), 16));
    return ESCAPES[esc] ?? esc;
  });
}

/**
 * Every translation call in one file, with the line each was written on. A template key with an interpolation
 * (`t(`hi ${name}`)`) is not a key at all: nothing could look it up, so it is left out rather than guessed at.
 */
export function extractFrom(text: string, file: string): MessageUse[] {
  const out: MessageUse[] = [];
  CALL.lastIndex = 0;
  for (let m = CALL.exec(text); m; m = CALL.exec(text)) {
    const quote = m[1]!, rawKey = m[2] ?? "";
    if (quote === "`" && rawKey.includes("${")) continue;
    if (m[3] === "`" && (m[4] ?? "").includes("${")) continue;
    const key = unescapeLiteral(rawKey);
    if (!key) continue;
    const line = text.slice(0, m.index).split("\n").length;
    const use: MessageUse = { key, file, line };
    if (m[3]) use.default = unescapeLiteral(m[4] ?? "");
    out.push(use);
  }
  return out;
}

/** every file under dir with one of the extensions, in a stable order, build output and dependencies skipped */
export function sourceFiles(dir: string, extensions: string[] = EXTENSIONS, skip: string[] = []): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const skipped = new Set(skip.map((s) => resolve(s)));
  const walk = (at: string): string[] => readdirSync(at).sort().flatMap((entry) => {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) return [];
    const full = join(at, entry);
    if (skipped.has(resolve(full))) return [];
    if (statSync(full).isDirectory()) return walk(full);
    return extensions.some((e) => entry.endsWith(e)) ? [full] : [];
  });
  return walk(dir);
}

/** the calls in a whole tree, deduplicated by key: the first one wins, and carries the default if it has one */
export function collectUses(root: string, files: string[]): MessageUse[] {
  const byKey = new Map<string, MessageUse>();
  for (const file of files) {
    for (const use of extractFrom(readFileSync(file, "utf8"), relative(root, file).split("\\").join("/"))) {
      const had = byKey.get(use.key);
      if (!had) byKey.set(use.key, use);
      else if (had.default === undefined && use.default !== undefined) had.default = use.default;
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** a catalogue as it is on disk: a flat object of strings, or nothing when the file is absent or not that */
export function readCatalog(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`voidbase: i18n: ${file} is not JSON (${err instanceof Error ? err.message : String(err)}). Fix or delete it: extract will not overwrite a file it cannot read.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`voidbase: i18n: ${file} is not a flat JSON object of key -> text.`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = typeof v === "string" ? v : String(v ?? "");
  return out;
}

/**
 * One locale's catalogue after this scan: what it had, plus the keys in use it lacked (the call's default or the
 * key itself in the source locale, "" everywhere else), keeping every key it already had. Sorted by key, so a diff
 * is the change and nothing else.
 */
export function mergeCatalog(existing: Record<string, string>, uses: MessageUse[], source: boolean): { messages: Record<string, string>; added: string[]; unused: string[]; untranslated: string[] } {
  const inUse = new Set(uses.map((u) => u.key));
  const messages: Record<string, string> = { ...existing };
  const added: string[] = [];
  for (const use of uses) {
    if (use.key in existing) continue;
    added.push(use.key);
    messages[use.key] = source ? (use.default ?? use.key) : "";
  }
  const unused = Object.keys(existing).filter((k) => !inUse.has(k)).sort();
  const untranslated = uses.filter((u) => !messages[u.key]).map((u) => u.key);
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(messages).sort()) sorted[key] = messages[key]!;
  return { messages: sorted, added, unused, untranslated };
}

/** i18n/keys.d.ts: the union of the keys in use, the locales, and a catalogue's type. Declarations only. */
export function keysDeclaration(keys: string[], locales: string[], from: { dir: string; files: number }): string {
  const union = keys.length ? keys.map((k) => `\n  | ${JSON.stringify(k)}`).join("") : " never";
  return [
    `// Generated by \`voidbase i18n extract\` from ${from.files} file${from.files === 1 ? "" : "s"} under ${from.dir}/.`,
    "// Do not edit: the next run rewrites it.",
    "//",
    "// The union is the keys in use. A key a catalogue still carries but nothing calls any more is left out, so a",
    "// client that still names it stops compiling; the text stays in the catalogue until someone removes it.",
    `export type MessageKey =${union};`,
    "/** the locales this project has a catalogue for; the first is the source locale */",
    `export type Locale = ${locales.length ? locales.map((l) => JSON.stringify(l)).join(" | ") : "never"};`,
    '/** one catalogue as it is read from i18n/<locale>.json; "" is a key nobody has translated yet */',
    "export type Messages = Record<MessageKey, string>;",
    "",
  ].join("\n");
}

/** the locales to write when the command was not told: the env's, else the catalogues already there, else en */
export function defaultLocales(outDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const declared = String(env.VOIDBASE_LOCALES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (declared.length) return [...new Set(declared)];
  const found = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort() : [];
  return found.length ? found : ["en"];
}

const list = (keys: string[], n = 5) => keys.slice(0, n).join(", ") + (keys.length > n ? `, and ${keys.length - n} more` : "");

/**
 * The whole command: scan, merge, write (unless `check`), report. Returns what it found and whether a build
 * should carry on; the CLI prints `lines` and exits 1 when `ok` is false.
 */
export function extractMessages(opts: ExtractOptions = {}): ExtractReport {
  const root = resolve(opts.root ?? ".");
  const dirRel = opts.dir ?? "src";
  const outRel = opts.out ?? "i18n";
  const dir = resolve(root, dirRel);
  const out = resolve(root, outRel);
  if (!existsSync(dir)) throw new Error(`voidbase: i18n: there is no ${dirRel}/ under ${root} to scan (--dir names another directory).`);
  const locales = (opts.locales?.length ? opts.locales : defaultLocales(out)).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(locales)];
  if (!unique.length) throw new Error("voidbase: i18n: no locales: --locales en,ar,fr, or VOIDBASE_LOCALES.");

  const files = sourceFiles(dir, opts.extensions ?? EXTENSIONS, [out]);
  const uses = collectUses(root, files);
  const keys = uses.map((u) => u.key);
  const at = new Map(uses.map((u) => [u.key, `${u.file}:${u.line}`]));

  const reports: CatalogReport[] = [];
  const written: string[] = [];
  const lines: string[] = [];
  let ok = true;
  for (const [i, locale] of unique.entries()) {
    const file = join(out, `${locale}.json`);
    const existing = readCatalog(file);
    const source = i === 0;
    const merged = mergeCatalog(existing, uses, source);
    // --check reads the files as they are: a key nobody has extracted yet is missing, which is the build's answer
    const missing = opts.check ? keys.filter((k) => !existing[k]) : merged.untranslated;
    const report: CatalogReport = { locale, file: relative(root, file).split("\\").join("/"), source, keys: Object.keys(merged.messages).length, added: merged.added, unused: merged.unused, untranslated: missing };
    reports.push(report);
    if (!opts.check) {
      mkdirSync(out, { recursive: true });
      writeFileSync(file, JSON.stringify(merged.messages, null, 2) + "\n");
      written.push(report.file);
    }
    if (missing.length) ok = false;
    lines.push(`${report.file}  ${report.keys} key${report.keys === 1 ? "" : "s"}${source ? " (source)" : ""}: ${merged.added.length} ${opts.check ? "missing from the file" : "added"}, ${merged.unused.length} no longer used, ${missing.length} untranslated`);
  }

  const keysFile = join(out, KEYS_FILE);
  const declaration = keysDeclaration(keys, unique, { dir: dirRel, files: files.length });
  if (!opts.check) {
    mkdirSync(out, { recursive: true });
    writeFileSync(keysFile, declaration);
    written.push(relative(root, keysFile).split("\\").join("/"));
  } else if (existsSync(keysFile) && readFileSync(keysFile, "utf8") !== declaration) {
    ok = false;
    lines.push(`${relative(root, keysFile).split("\\").join("/")} is out of date: run voidbase i18n extract`);
  }
  lines.unshift(`${keys.length} key${keys.length === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"} under ${dirRel}/`);
  const unused = reports[0]?.unused ?? [];
  if (unused.length) lines.push(`kept, no longer used: ${list(unused)}`);
  if (opts.check && !ok) for (const r of reports.filter((x) => x.untranslated.length)) lines.push(`${r.locale} has no text for: ${list(r.untranslated.map((k) => `${k} (${at.get(k) ?? "?"})`))}`);
  return { dir: dirRel, out: outRel, files: files.length, uses, keys, locales: reports, written, lines, ok };
}
