// Content in the reader's language: a field is declared translatable once, and the records API answers in the
// locale the request asks for.
//
// This is the content half of the roadmap's "Translations, as an official plugin"; interface strings (the project
// half, typed keys that fail the build) are not here. Two knobs declare everything:
//   VOIDBASE_TRANSLATABLE=posts:title,body;pages:title   which fields of which collections have translations
//   VOIDBASE_LOCALES=en,ar,fr                            the locales; the first is the source, the order the fallback
// The translations themselves are records of one collection this plugin owns, `translations`, one row per
// (collection, record, field, locale), written like any record (superuser only). The source text stays in the
// record's own field: writes never touch this plugin, realtime events carry the record as stored.
//
// Reading goes through the kernel's after-read seam (onAfterRead): the list and view routes hand over the rows as
// the response will carry them, after the rules judged the read and `expand` and `fields` were applied, so a
// translation is only ever shown on a record the caller could see. The locale is `?locale=`, else the best match
// of Accept-Language among VOIDBASE_LOCALES, else the source; the response says which in Content-Language. Each
// translatable field is replaced by its translation in that locale, falling back down VOIDBASE_LOCALES' order to
// the source value (an empty source value counts as missing and the next locale is tried), and the record carries
// `translated: { field: locale }` for the fields that were swapped, nothing when none were. The rows of a whole
// response, expanded records included, are looked up in one call to the source. A collection the knob does not
// name is answered exactly as before, header included.
import type { Context, Hono } from "hono";
import { env as runtimeEnv } from "#platform/env";
import { logger } from "#platform/log";
import { requireSuperuser } from "../auth-slot";
import { listCollections, type Collection } from "../collections/model";
import { all, ident, one } from "../db";
import { badRequest } from "../errors";
import { onAfterRead, onBootstrap, type Kernel, type RecordsRead } from "../kernel";
import type { AppEnv, Bindings } from "../types";
import { ensureCollections } from "./collections";
import type { Plugin } from "./manifest";

/** one stored translation: the record's collection and id, the field, the locale and the text */
export interface TranslationRow { collection: string; record: string; field: string; locale: string; value: string }

/** where the facts come from; the defaults read the instance, a test hands in what it likes */
export interface TranslationsSource {
  /** the collections this instance has */
  collections(env: Bindings): Promise<Collection[]>;
  /** the translations of these records in these locales, whatever their collection: one call per response */
  translations(env: Bindings, ids: string[], locales: string[]): Promise<TranslationRow[]>;
  /** a page of a collection's record ids in stored order, and how many records it has */
  recordIds(env: Bindings, collection: Collection, page: number, perPage: number): Promise<{ ids: string[]; totalItems: number }>;
  /** how many records a collection has, and per locale how many (record, field) pairs of these fields have a translation */
  counts(env: Bindings, collection: Collection, fields: string[]): Promise<{ records: number; translated: Record<string, number> }>;
}

export const TRANSLATIONS = "translations";
const T = ident(TRANSLATIONS);
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
const BOUND = 90; // under D1's limit of bound parameters per statement, like the expander's chunks

/** the default source: the instance's own tables, the translations looked up in chunks under D1's parameter limit */
export const dbSource: TranslationsSource = {
  collections: (env) => listCollections(env.DB),
  translations: async (env, ids, locales) => {
    if (!ids.length || !locales.length) return [];
    const out: TranslationRow[] = [];
    const size = Math.max(1, BOUND - locales.length);
    for (let i = 0; i < ids.length; i += size) {
      const chunk = ids.slice(i, i + size);
      out.push(...(await all<TranslationRow>(env.DB, `SELECT collection, record, field, locale, value FROM ${T} WHERE record IN (${marks(chunk.length)}) AND locale IN (${marks(locales.length)})`, [...chunk, ...locales])));
    }
    return out;
  },
  recordIds: async (env, c, page, perPage) => {
    const order = c.type === "view" ? "id" : "rowid"; // views have no rowid, as the records service knows
    const rows = await all<{ id: string }>(env.DB, `SELECT id FROM ${ident(c.name)} ORDER BY ${order} ASC LIMIT ? OFFSET ?`, [perPage, (page - 1) * perPage]);
    const total = await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${ident(c.name)}`);
    return { ids: rows.map((r) => String(r.id)), totalItems: Number(total?.n ?? 0) };
  },
  counts: async (env, c, fields) => {
    const total = await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${ident(c.name)}`);
    const rows = fields.length
      ? await all<{ locale: string; n: number }>(env.DB, `SELECT locale, COUNT(*) AS n FROM ${T} t WHERE t.collection = ? AND t.field IN (${marks(fields.length)}) AND t.value != '' AND EXISTS (SELECT 1 FROM ${ident(c.name)} r WHERE r.id = t.record) GROUP BY locale`, [c.name, ...fields])
      : [];
    return { records: Number(total?.n ?? 0), translated: Object.fromEntries(rows.map((r) => [String(r.locale), Number(r.n)])) };
  },
};

/** the collection the plugin owns, in the shape POST /api/collections takes; rules: anyone reads, superusers write */
export const TRANSLATIONS_COLLECTION: Record<string, unknown> = {
  name: TRANSLATIONS,
  type: "base",
  fields: [
    { name: "collection", type: "text", required: true, presentable: true },
    { name: "record", type: "text", required: true, presentable: true },
    { name: "field", type: "text", required: true, presentable: true },
    { name: "locale", type: "text", required: true, presentable: true },
    { name: "value", type: "text" },
    { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ],
  indexes: [`CREATE UNIQUE INDEX \`idx_translations_key\` ON \`${TRANSLATIONS}\` (\`collection\`, \`record\`, \`field\`, \`locale\`)`],
  listRule: "",
  viewRule: "",
  createRule: null,
  updateRule: null,
  deleteRule: null,
};

// --- the knobs -------------------------------------------------------------------------------------------------------
const read = (name: string, env?: object): string => {
  try { return String((env as Record<string, unknown> | undefined)?.[name] ?? (runtimeEnv as Record<string, unknown>)[name] ?? process.env?.[name] ?? "").trim(); } catch { return ""; }
};
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCALE = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;

/**
 * VOIDBASE_TRANSLATABLE: entries separated by `;`, each `collection:field,field`. Whitespace around a name is
 * ignored, a collection named twice has the union of its fields, and an entry with no `:`, an invalid name or no
 * field is skipped with a warning.
 */
export function parseTranslatable(spec: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of spec.split(";").map((s) => s.trim()).filter(Boolean)) {
    const at = raw.indexOf(":");
    const collection = at < 0 ? "" : raw.slice(0, at).trim();
    const fields = at < 0 ? [] : raw.slice(at + 1).split(",").map((s) => s.trim()).filter(Boolean);
    if (!NAME.test(collection) || !fields.length || fields.some((f) => !NAME.test(f))) { logger.warn("voidbase: translations: VOIDBASE_TRANSLATABLE entry skipped, expected collection:field,field", { entry: raw }); continue; }
    const have = out.get(collection) ?? [];
    for (const f of fields) if (!have.includes(f)) have.push(f);
    out.set(collection, have);
  }
  return out;
}

/** VOIDBASE_LOCALES: comma-separated language tags, lowercased and deduplicated; the first is the source locale */
export function parseLocales(spec: string): string[] {
  const out: string[] = [];
  for (const raw of spec.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!LOCALE.test(raw)) { logger.warn("voidbase: translations: VOIDBASE_LOCALES entry skipped, expected a language tag like en or pt-br", { entry: raw }); continue; }
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

export interface TranslationsConfig { locales: string[]; source: string; translatable: Map<string, string[]> }
export const configOf = (env?: object): TranslationsConfig => {
  const locales = parseLocales(read("VOIDBASE_LOCALES", env));
  return { locales, source: locales[0] ?? "", translatable: parseTranslatable(read("VOIDBASE_TRANSLATABLE", env)) };
};
const active = (cfg: TranslationsConfig) => cfg.locales.length > 0 && cfg.translatable.size > 0;

/** what /api/plugins says: the locales, the source, and the declared collections with their fields */
export const translationsInfo = (env?: object): { source: string; locales: string[]; collections: Record<string, string[]> } => {
  const cfg = configOf(env);
  return { source: cfg.source, locales: cfg.locales, collections: Object.fromEntries(cfg.translatable) };
};

// --- the locale ------------------------------------------------------------------------------------------------------
const primary = (tag: string) => tag.split("-")[0]!;

/**
 * The locale to serve: `?locale=` when it is one of the locales (an unknown one is the source, not an error),
 * else the best Accept-Language match by q value (a tag matches its locale exactly, or by primary subtag: en-US
 * finds en, `*` is the source), else the source.
 */
export function negotiateLocale(query: string | undefined, acceptLanguage: string | undefined, locales: string[]): string {
  const source = locales[0] ?? "";
  if (!source) return "";
  const asked = (query ?? "").trim().toLowerCase();
  if (asked) return locales.includes(asked) ? asked : source;
  const ranked = (acceptLanguage ?? "").split(",").map((part, i) => {
    const [tag = "", ...params] = part.trim().split(";").map((s) => s.trim());
    const q = params.map((p) => /^q=(.*)$/i.exec(p)?.[1]).find((v) => v !== undefined);
    const weight = q === undefined ? 1 : Number(q);
    return { tag: tag.toLowerCase(), q: Number.isFinite(weight) ? weight : 0, i };
  }).filter((r) => r.tag && r.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    if (tag === "*") return source;
    if (locales.includes(tag)) return tag;
    const byPrimary = locales.find((l) => primary(l) === primary(tag));
    if (byPrimary) return byPrimary;
  }
  return source;
}

// --- the swap --------------------------------------------------------------------------------------------------------
const key = (collection: string, record: string, field: string, locale: string) => `${collection} ${record} ${field} ${locale}`;
const MAX_DEPTH = 6; // the expander's own cap
type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** every record in the response with its collection: the rows, then what `expand` carries, however deep */
function walk(rows: Json[], collection: string, visit: (row: Json, collection: string) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    visit(row, collection);
    const expand = row.expand;
    if (!isRecord(expand)) continue;
    for (const v of Object.values(expand)) {
      const related = (Array.isArray(v) ? v : [v]).filter(isRecord);
      for (const r of related) walk([r], String(r.collectionName ?? ""), visit, depth + 1);
    }
  }
}

/**
 * Swap the translatable fields of these rows into `locale`, falling back down the locales' order; the source locale
 * means the record's own value when it is not empty. `translated` names the locale each swapped field came from.
 */
export function applyTranslations(rows: Json[], collection: string, cfg: TranslationsConfig, locale: string, found: TranslationRow[]): void {
  const byKey = new Map<string, string>();
  for (const t of found) if (t.value) byKey.set(key(t.collection, t.record, t.field, t.locale.toLowerCase()), t.value);
  const chain = [locale, ...cfg.locales.filter((l) => l !== locale)];
  walk(rows, collection, (row, name) => {
    const fields = cfg.translatable.get(name);
    const id = String(row.id ?? "");
    if (!fields || !id) return;
    const translated: Record<string, string> = {};
    for (const field of fields) {
      if (!(field in row)) continue; // `fields` left it out
      for (const l of chain) {
        if (l === cfg.source) { if (typeof row[field] === "string" ? row[field] !== "" : row[field] != null) break; continue; }
        const value = byKey.get(key(name, id, field, l));
        if (value === undefined) continue;
        row[field] = value;
        translated[field] = l;
        break;
      }
    }
    if (Object.keys(translated).length) row.translated = translated;
  });
}

/** the ids of every record in the response that belongs to a declared collection */
function declaredIds(rows: Json[], collection: string, cfg: TranslationsConfig): string[] {
  const ids = new Set<string>();
  walk(rows, collection, (row, name) => { const id = String(row.id ?? ""); if (id && cfg.translatable.has(name)) ids.add(id); });
  return [...ids];
}

async function afterRead(c: Context<AppEnv>, read: RecordsRead, source: TranslationsSource): Promise<void> {
  const cfg = configOf(c.env);
  if (!active(cfg)) return;
  const ids = declaredIds(read.rows, read.collection, cfg);
  if (!ids.length && !cfg.translatable.has(read.collection)) return; // nothing declared here: untouched
  const locale = negotiateLocale(c.req.query("locale"), c.req.header("accept-language"), cfg.locales);
  c.header("Content-Language", locale);
  if (locale === cfg.source || !ids.length) return; // the source is the records as they are
  const found = await source.translations(c.env, ids, cfg.locales.filter((l) => l !== cfg.source));
  applyTranslations(read.rows, read.collection, cfg, locale, found);
}

// --- the reports -----------------------------------------------------------------------------------------------------
const MAX_PER_PAGE = 1000, DEFAULT_PER_PAGE = 30;

function mountRoutes(app: Hono<AppEnv>, source: TranslationsSource) {
  // what has no translation yet in a locale: paginated over the collection's records, like the records API, and
  // the items are the records of that page missing at least one field, each with the fields it lacks
  app.get("/api/translations/missing", async (c) => {
    requireSuperuser(c);
    const cfg = configOf(c.env);
    const name = (c.req.query("collection") ?? "").trim();
    const locale = (c.req.query("locale") ?? "").trim().toLowerCase();
    const fields = cfg.translatable.get(name);
    if (!fields) throw badRequest(`${JSON.stringify(name)} is not declared translatable (VOIDBASE_TRANSLATABLE).`);
    if (!cfg.locales.includes(locale)) throw badRequest(`${JSON.stringify(locale)} is not one of the locales (VOIDBASE_LOCALES).`);
    if (locale === cfg.source) throw badRequest(`${JSON.stringify(locale)} is the source locale; the records themselves hold it.`);
    const collection = (await source.collections(c.env)).find((col) => col.name === name);
    if (!collection) throw badRequest(`the collection ${JSON.stringify(name)} does not exist.`);
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(c.req.query("perPage") ?? DEFAULT_PER_PAGE) || DEFAULT_PER_PAGE));
    const { ids, totalItems } = await source.recordIds(c.env, collection, page, perPage);
    const have = new Set((await source.translations(c.env, ids, [locale])).filter((t) => t.value && t.collection === name).map((t) => `${t.record} ${t.field}`));
    const items = ids.map((id) => ({ id, fields: fields.filter((f) => !have.has(`${id} ${f}`)) })).filter((it) => it.fields.length);
    return c.json({ collection: name, locale, page, perPage, totalItems, totalPages: Math.ceil(totalItems / perPage), items });
  });

  // per declared collection and locale: how many (record, field) pairs are translated, out of records × fields
  app.get("/api/translations/status", async (c) => {
    requireSuperuser(c);
    const cfg = configOf(c.env);
    const byName = new Map((await source.collections(c.env)).map((col) => [col.name, col]));
    const collections: Record<string, unknown> = {};
    for (const [name, fields] of cfg.translatable) {
      const collection = byName.get(name);
      if (!collection) { logger.warn("voidbase: translations: a declared collection does not exist, left out of the status", { collection: name }); continue; }
      const { records, translated } = await source.counts(c.env, collection, fields);
      const total = records * fields.length;
      collections[name] = { fields, records, locales: Object.fromEntries(cfg.locales.filter((l) => l !== cfg.source).map((l) => [l, { translated: translated[l] ?? 0, total }])) };
    }
    return c.json({ source: cfg.source, locales: cfg.locales, collections });
  });
}

/** the plugin over a source of its own: tests hand in collections, records and translations without a database */
export function translationsWith(source: Partial<TranslationsSource> = {}): Plugin {
  const full = { ...dbSource, ...source };
  const plugin: Plugin = {
    manifest: { name: "translations", version: "0.1.0", tier: "official", voidbase: "*", collections: [TRANSLATIONS] },
    info: (env) => translationsInfo(env),
    apply(ctx: Kernel) {
      onBootstrap(ctx, async (env) => { await ensureCollections(plugin, env.DB, [TRANSLATIONS_COLLECTION]); });
      onAfterRead(ctx, (c, read) => afterRead(c, read, full));
      mountRoutes(ctx.app, full);
    },
  };
  return plugin;
}

/** the shipped plugin: the instance's own collections, records and translations */
export const translations: Plugin = translationsWith();
