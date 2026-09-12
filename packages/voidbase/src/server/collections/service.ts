// Collection lifecycle: normalize -> validate -> plan SQL -> one D1 batch. Schema is data, as in PocketBase.
import { trigger } from "../hooks/runtime";
import { CollectionRef } from "../hooks/record";
import { crc32 } from "../crc32";
import { all, ident, one, stmt } from "../db";
import { badRequest, notFound, type FieldErrors } from "../errors";
import { nowString, randomString } from "../ids";
import { ownedCollections } from "../kernel";
import { createIndexesSQL, createTableSQL, createViewSQL, dropIndexesSQL, dropTableSQL, dropViewSQL, parseIndex, buildIndex, syncTableSQL, truncateSQL } from "./ddl";
import { defaultFieldId, normalizeField, RUNTIME_SYSTEM_FIELDS, sortKeys, type Field } from "./fields";
import { collectionToJSON, invalidateCollections, jsonToCollection, listCollections, loadCollections, type Collection } from "./model";
import { validateCollection, type ValidateContext } from "./validate";
import scaffolds from "./scaffolds.json";

const SECRET_OPTIONS = ["authToken", "passwordResetToken", "emailChangeToken", "verificationToken", "fileToken"];
const COMMON = ["id", "system", "type", "name", "fields", "indexes", "listRule", "viewRule", "createRule", "updateRule", "deleteRule", "created", "updated"];

export const collectionId = (type: string, name: string) => "pbc_" + crc32(type + name);

// PocketBase stores index expressions as written and only rebuilds them when the table name changes.
function retargetIndex(raw: string, table: string): string {
  const idx = parseIndex(raw);
  if (!idx || idx.table.toLowerCase() === table.toLowerCase()) return raw;
  return buildIndex(idx, table);
}

// Build the target collection from request JSON, optionally overlaying an existing collection (PATCH semantics).
export function prepareCollection(raw: Record<string, unknown>, old: Collection | null): Collection {
  const base = old ? collectionToJSON(old) : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(raw)) {
    if (k === "created" || k === "updated") continue;
    const cur = merged[k];
    merged[k] = !COMMON.includes(k) && cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object" && !Array.isArray(v)
      ? { ...(cur as object), ...(v as object) }
      : v;
  }
  if (old) {
    // keep stored secrets (never present in API JSON) unless explicitly replaced
    for (const key of SECRET_OPTIONS) {
      const stored = old.options[key] as Record<string, unknown> | undefined;
      const incoming = merged[key] as Record<string, unknown> | undefined;
      if (stored?.secret && incoming && !incoming.secret) merged[key] = { ...incoming, secret: stored.secret };
    }
    merged.id = old.id;
    merged.system = old.system;
  }
  const c = jsonToCollection(merged);
  if (!c.type) c.type = "base";
  if (!c.id) c.id = collectionId(c.type, c.name);
  if (c.type === "auth") {
    // missing option keys take PocketBase's struct defaults (as in the auth scaffold)
    c.options = deepDefaults(c.options, authOptionDefaults());
    for (const key of SECRET_OPTIONS) {
      const cfg = (c.options[key] as Record<string, unknown> | undefined) ?? {};
      if (!cfg.secret) c.options[key] = { ...cfg, secret: randomString(50) };
    }
  }
  // fields: normalize, reuse ids by name (PocketBase FieldsList.Add semantics), generate missing ids
  const oldFields = (old?.fields ?? []) as Field[];
  const taken = new Set<string>();
  const given = Array.isArray(merged.fields) ? (merged.fields as Record<string, unknown>[]) : [];
  const rawFields = old && old.type !== "view" ? keepRuntimeFields(given, old) : given;
  c.fields = rawFields.map((rf) => {
    const f = normalizeField(rf ?? {});
    if (!f.id) {
      const byName = oldFields.find((x) => x.name === f.name);
      f.id = byName ? byName.id : defaultFieldId(f.type, f.name, taken);
    }
    taken.add(f.id);
    return sortKeys(f);
  });
  ensureDefaultFields(c, taken);
  c.indexes = Array.isArray(merged.indexes) ? (merged.indexes as unknown[]).map((i) => retargetIndex(String(i), c.name)) : [];
  const now = nowString();
  c.created = old?.created || now;
  c.updated = now;
  return c;
}

async function validateContext(db: D1Database, extra: Collection[] = []): Promise<ValidateContext> {
  const known = await listCollections(db);
  // stored collections being replaced by an update are represented by their new version only
  const replaced = new Set(extra.filter((e) => known.some((k) => k.id === e.id)).map((e) => e.id));
  const rows = await all<{ name: string; tbl_name: string }>(db, "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL");
  return { all: [...known.filter((k) => !replaced.has(k.id)), ...extra], usedIndexNames: new Map(rows.map((r) => [r.name.toLowerCase(), r.tbl_name])) };
}

function authOptionDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((scaffolds as Record<string, Record<string, unknown>>).auth ?? {})) if (!COMMON.includes(k)) out[k] = v;
  return out;
}

function deepDefaults(value: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const [k, d] of Object.entries(defaults)) {
    const v = out[k];
    if (v === undefined) out[k] = structuredClone(d);
    else if (v && d && typeof v === "object" && typeof d === "object" && !Array.isArray(v) && !Array.isArray(d)) {
      out[k] = deepDefaults(v as Record<string, unknown>, d as Record<string, unknown>);
    }
  }
  return out;
}

// PocketBase's default system fields for base/auth collections, inserted when a payload omits them.
const ID_FIELD = { name: "id", type: "text", system: true, required: true, primaryKey: true, autogeneratePattern: "[a-z0-9]{15}", min: 15, max: 15, pattern: "^[a-z0-9]+$", hidden: false, presentable: false, help: "" };
const AUTH_FIELDS: Record<string, unknown>[] = [
  { name: "password", type: "password", system: true, hidden: true, required: true, cost: 0, min: 8, max: 0, pattern: "", presentable: false, help: "" },
  { name: "tokenKey", type: "text", system: true, hidden: true, required: true, min: 30, max: 60, pattern: "", autogeneratePattern: "[a-zA-Z0-9]{50}", primaryKey: false, presentable: false, help: "" },
  { name: "email", type: "email", system: true, required: true, exceptDomains: null, onlyDomains: null, hidden: false, presentable: false, help: "" },
  { name: "emailVisibility", type: "bool", system: true, hidden: false, presentable: false, required: false, help: "" },
  { name: "verified", type: "bool", system: true, hidden: false, presentable: false, required: false, help: "" },
];
function ensureDefaultFields(c: Collection, taken: Set<string>) {
  if (c.type === "view") return;
  const fields = c.fields as Field[];
  const add = (raw: Record<string, unknown>, at: number) => {
    const f = normalizeField(raw);
    f.id = defaultFieldId(f.type, f.name, taken);
    taken.add(f.id);
    fields.splice(at, 0, sortKeys(f));
  };
  if (!fields.some((f) => f.name === "id")) add(ID_FIELD, 0);
  if (c.type === "auth") {
    let pos = fields.findIndex((f) => f.name === "id") + 1;
    for (const def of AUTH_FIELDS) {
      const i = fields.findIndex((f) => f.name === def.name);
      if (i >= 0) { pos = i + 1; continue; }
      add(def, pos);
      pos++;
    }
  }
}

// the system fields voidbase adds to a collection at runtime (fields.ts); a definition that leaves one out keeps it
export { RUNTIME_SYSTEM_FIELDS };

// A stored runtime system field that the incoming fields do not name, by id or by name in any case, is carried over as
// stored, so its column and every row's value in it survive. Without this, an app's own definitions stop importing the
// moment a flagged write gives one of its collections `_preview`: validateFields refuses them as deleting a system field,
// which is how the demo's hourly reset aborted from 2026-09-11 on. A definition that names the field is judged as before,
// so renaming or retyping it is still refused, and the core system fields are never carried over.
// A PATCH gets the same, since prepareCollection is behind both: the panel sends back the collection as it read it,
// `_preview` included, while a client that sends its own fields (the SDK's collections.update) works on PocketBase, which
// refuses a missing system field but never adds one, so refusing it here would break that client only on voidbase.
function keepRuntimeFields(fields: Record<string, unknown>[], old: Collection): Record<string, unknown>[] {
  const named = (f: Field) => fields.some((rf) => (!!rf?.id && rf.id === f.id) || String(rf?.name ?? "").toLowerCase() === f.name.toLowerCase());
  const kept = (old.fields as Field[]).filter((f) => f.system && RUNTIME_SYSTEM_FIELDS.includes(f.name) && !named(f));
  return kept.length ? [...fields, ...kept.map((f) => ({ ...f }))] : fields;
}

function throwIfErrors(errs: Record<string, unknown>, message: string) {
  if (Object.keys(errs).length) throw badRequest(message, errs as FieldErrors);
}

function rowStatements(db: D1Database, c: Collection, mode: "insert" | "update") {
  const params = [c.system, c.type, c.name, JSON.stringify(c.fields), JSON.stringify(c.indexes), c.listRule, c.viewRule, c.createRule, c.updateRule, c.deleteRule, JSON.stringify(c.options), c.created, c.updated];
  return mode === "insert"
    ? stmt(db, "INSERT INTO `_collections` (id, system, type, name, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [c.id, ...params])
    : stmt(db, "UPDATE `_collections` SET system=?, type=?, name=?, fields=?, indexes=?, listRule=?, viewRule=?, createRule=?, updateRule=?, deleteRule=?, options=?, created=?, updated=? WHERE id = ?", [...params, c.id]);
}

// Model-level collection events (core/collection_model.go): onCollection{Create,Update,Delete} wrap the
// persist step (validation runs inside onCollectionValidate within it), then AfterXSuccess or AfterXError.
async function withCollectionHooks(op: "Create" | "Update" | "Delete", c: Collection, isNew: boolean, validate: () => Promise<void>, persist: () => Promise<void>): Promise<void> {
  const ev = { app: undefined as unknown, collection: new CollectionRef(c), isNew, next: async () => undefined as unknown };
  try {
    await trigger(`onCollection${op}`, ev, c.name, async () => {
      await trigger("onCollectionValidate", ev, c.name, validate);
      await persist();
    });
  } catch (err) {
    try { await trigger(`onCollectionAfter${op}Error`, { ...ev, error: err }, c.name, async () => undefined); } catch (hookErr) { console.error(`voidbase: onCollectionAfter${op}Error handler failed`, hookErr); }
    throw err;
  }
  await trigger(`onCollectionAfter${op}Success`, ev, c.name, async () => undefined);
}

export async function createCollection(db: D1Database, raw: Record<string, unknown>): Promise<Collection> {
  const c = prepareCollection(raw, null);
  await withCollectionHooks("Create", c, true, async () => {
    const ctx = await validateContext(db, []);
    ctx.all.push(c);
    if (c.type === "view") await preloadViewFields(db, c);
    throwIfErrors(validateCollection(c, null, ctx), "Failed to create collection.");
    if (c.type === "view") await viewDryRun(db, c, "Failed to create collection.", true);
  }, async () => {
    const statements = [rowStatements(db, c, "insert"), ...planCreate(c).map((sql) => db.prepare(sql))];
    await db.batch(statements);
    invalidateCollections();
    if (c.type === "view") await deriveViewFields(db, c);
  });
  return c;
}

export async function updateCollection(db: D1Database, old: Collection, raw: Record<string, unknown>): Promise<Collection> {
  const c = prepareCollection(raw, old);
  await withCollectionHooks("Update", c, false, async () => {
    const ctx = await validateContext(db, [c]);
    if (c.type === "view") await preloadViewFields(db, c);
    throwIfErrors(validateCollection(c, old, ctx), "Failed to update collection.");
    if (c.type === "view") await viewDryRun(db, c, "Failed to update collection.", false);
  }, async () => {
    const sql = c.type === "view" ? [dropViewSQL(old.name), createViewSQL(c.name, String(c.options.viewQuery ?? ""))] : syncTableSQL(old, c);
    await db.batch([rowStatements(db, c, "update"), ...sql.map((s) => db.prepare(s))]);
    invalidateCollections();
    if (c.type === "view") await deriveViewFields(db, c);
  });
  return c;
}

export async function deleteCollection(db: D1Database, c: Collection): Promise<void> {
  await withCollectionHooks("Delete", c, false, async () => {
    if (c.system) throw badRequest("Failed to delete collection.");
    const refs = (await listCollections(db)).filter((x) => x.id !== c.id && (x.fields as Field[]).some((f) => f.type === "relation" && f.collectionId === c.id));
    if (refs.length) throw badRequest(`Failed to delete collection probably due to existing reference in ${refs.map((r) => r.name).sort().join(", ")}.`);
  }, async () => {
    const sql = c.type === "view" ? [dropViewSQL(c.name)] : [...dropIndexesSQL(c), dropTableSQL(c.name)];
    await db.batch([...sql.map((s) => db.prepare(s)), stmt(db, "DELETE FROM `_collections` WHERE id = ?", [c.id])]);
    invalidateCollections();
  });
}

export async function truncateCollection(db: D1Database, c: Collection): Promise<void> {
  if (c.type === "view") throw badRequest("View collections cannot be truncated since they don't store their own records.");
  await db.prepare(truncateSQL(c.name)).run();
}

// PUT /api/collections/import
export async function importCollections(db: D1Database, items: Record<string, unknown>[], deleteMissing: boolean): Promise<void> {
  // read fresh rather than from this isolate's five-second cache: another isolate may just have given a collection a
  // runtime system field, and a plan made against the older shape would write the definition without it
  invalidateCollections();
  const existing = await listCollections(db);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
  const plan: Array<{ c: Collection; old: Collection | null }> = [];
  for (const raw of items) {
    const old: Collection | null = (raw.id ? byId.get(String(raw.id)) : undefined) ?? (raw.name ? byName.get(String(raw.name).toLowerCase()) : undefined) ?? null;
    plan.push({ c: prepareCollection(raw, old), old });
  }
  const keep = new Set(plan.map((p) => p.c.id));
  // An import is about the collections the caller manages, so deleteMissing sweeps only those. A system collection is
  // voidbase's, and a collection a loaded plugin owns is the plugin's: its manifest names it, its bootstrap creates it
  // once per isolate, and the schema is the plugin's to change. Both stay. Deleting an owned one is still possible on
  // purpose (DELETE /api/collections/:name); a sweep is not that. The demo's hourly reset, which imports its own list
  // with deleteMissing, deleted every plugin's collections this way until a fresh isolate recreated them (2026-09-11).
  const owned = ownedCollections();
  const toDelete = deleteMissing ? existing.filter((c) => !c.system && !owned.has(c.name) && !keep.has(c.id)) : [];
  const ctx = await validateContext(db, plan.map((p) => p.c));
  ctx.all = ctx.all.filter((c) => !toDelete.some((d) => d.id === c.id));
  const errors: Record<string, unknown> = {};
  plan.forEach(({ c, old }, i) => {
    const errs = validateCollection(c, old, ctx);
    if (Object.keys(errs).length) errors[String(i)] = errs;
  });
  if (Object.keys(errors).length) throw badRequest("Failed to import collections.", { collections: errors } as unknown as FieldErrors);

  const statements: D1PreparedStatement[] = [];
  for (const d of toDelete) {
    statements.push(...(d.type === "view" ? [dropViewSQL(d.name)] : [...dropIndexesSQL(d), dropTableSQL(d.name)]).map((s) => db.prepare(s)));
    statements.push(stmt(db, "DELETE FROM `_collections` WHERE id = ?", [d.id]));
  }
  // tables first, views last (views may reference the tables)
  const ordered = [...plan.filter((p) => p.c.type !== "view"), ...plan.filter((p) => p.c.type === "view")];
  for (const { c, old } of ordered) {
    statements.push(rowStatements(db, c, old ? "update" : "insert"));
    const sql = old
      ? c.type === "view" ? [dropViewSQL(old.name), createViewSQL(c.name, String(c.options.viewQuery ?? ""))] : syncTableSQL(old, c)
      : planCreate(c);
    statements.push(...sql.map((s) => db.prepare(s)));
  }
  await db.batch(statements);
  invalidateCollections();
  for (const { c } of ordered) if (c.type === "view") await deriveViewFields(db, c);
}

export function planCreate(c: Collection): string[] {
  if (c.type === "view") return [createViewSQL(c.name, String(c.options.viewQuery ?? ""))];
  return [createTableSQL(c), ...createIndexesSQL(c)];
}

// View collections: fields come from the view's columns (text by default; PocketBase infers more, milestone five).
// core/view.go CreateViewFields: run the query as a temporary view to learn its columns, then infer each field
// from the SELECT list (clones of the source collection fields, a relation for a source id, number for
// count()/total(), CAST types, json for everything else). Throws Error with PocketBase's raw message on failure.
export async function inferViewFields(db: D1Database, query: string, collections: Map<string, Collection>): Promise<Field[]> {
  const parsed = parseViewQuery(query);
  for (const col of parsed.columns) if (col.alias === "*" || col.original === "*") throw new Error("wildcard columns (*) are not supported - manually type the collection field names you want the view query to have");
  const tmp = `__vb_view_${randomString(8).toLowerCase()}`;
  let info: { name: string; type: string }[];
  try {
    await db.batch([db.prepare(`CREATE VIEW ${ident(tmp)} AS ${query}`)]);
    info = await all<{ name: string; type: string }>(db, `PRAGMA table_info(${ident(tmp)})`);
  } catch (err) {
    throw new Error(String((err as Error)?.message ?? err).replace(/^D1_ERROR: /, "").replace(/: SQLITE_ERROR$/, ""));
  } finally { try { await db.batch([db.prepare(`DROP VIEW IF EXISTS ${ident(tmp)}`)]); } catch { /* ignore */ } }
  const byAlias = new Map(parsed.tables.map((t) => [t.alias, t.original]));
  const main = parsed.tables[0];
  const suggested = new Map<string, Record<string, unknown>>();
  for (const col of parsed.columns) {
    const lower = col.original.toLowerCase();
    if (col.alias === "id") { suggested.set("id", viewIdField()); continue; }
    if (lower.startsWith("count(")) { suggested.set(col.alias, { name: col.alias, type: "number", onlyInt: true }); continue; }
    if (lower.startsWith("total(")) { suggested.set(col.alias, { name: col.alias, type: "number" }); continue; }
    const cast = /^cast\s*\(.*\s+as\s+(\w+)\s*\)$/i.exec(col.original);
    if (cast) {
      const t = cast[1]!.toLowerCase();
      if (["real", "decimal", "numeric"].includes(t)) { suggested.set(col.alias, { name: col.alias, type: "number" }); continue; }
      if (["int", "integer"].includes(t)) { suggested.set(col.alias, { name: col.alias, type: "number", onlyInt: true }); continue; }
      if (t === "text") { suggested.set(col.alias, { name: col.alias, type: "text" }); continue; }
      if (["boolean", "bool"].includes(t)) { suggested.set(col.alias, { name: col.alias, type: "bool" }); continue; }
    }
    const parts = col.original.split(".");
    const [tableRef, fieldName] = parts.length === 2 ? [parts[0]!, parts[1]!] : [main?.alias ?? "", parts[0]!];
    const source = collections.get(byAlias.get(tableRef) ?? tableRef);
    if (!source) { suggested.set(col.alias, { name: col.alias, type: "json", maxSize: 1 }); continue; }
    const field = (source.fields as Field[]).find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
    if (!field) { suggested.set(col.alias, { name: col.alias, type: "json", maxSize: 1 }); continue; }
    if (fieldName.toLowerCase() === "id") { suggested.set(col.alias, { name: col.alias, type: "relation", maxSelect: 1, collectionId: source.id }); continue; }
    suggested.set(col.alias, { ...(field as unknown as Record<string, unknown>), name: col.alias, id: "_clone_" + randomString(4) });
  }
  let hasId = false;
  const taken = new Set<string>();
  const fields = info.map((row) => {
    if (row.name === "id") hasId = true;
    const raw = suggested.get(row.name) ?? (row.name === "id" ? viewIdField() : { name: row.name, type: "json", maxSize: 1 });
    const f = normalizeField(raw);
    if (!f.id) f.id = defaultFieldId(f.type, f.name, taken);
    taken.add(f.id);
    return sortKeys(f);
  });
  if (!hasId) throw new Error("missing required id column (you can use `(ROW_NUMBER() OVER()) as id` if you don't have one)");
  return fields as Field[];
}
// validation_invalid_view_query, the way collection_validate.go reports a broken view query
// Best-effort inference before validation: API rules are checked against the fields the query produces.
// A broken query is reported by viewDryRun right after, with PocketBase's viewQuery/fields errors.
async function preloadViewFields(db: D1Database, c: Collection): Promise<void> {
  try { c.fields = await inferViewFields(db, String(c.options.viewQuery ?? ""), await loadCollections(db)); } catch { /* reported by viewDryRun */ }
}

async function viewDryRun(db: D1Database, c: Collection, failMsg: string, isNew: boolean): Promise<void> {
  try { await inferViewFields(db, String(c.options.viewQuery ?? ""), await loadCollections(db)); }
  catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const sentenized = /[.!?]$/.test(raw) ? raw : raw + ".";
    // the fields are re-derived from the query during validation, so a broken query also leaves them blank
    const fieldsErr = raw.startsWith("missing required id column") ? { code: "validation_missing_primary_key", message: 'Missing or invalid "id" PK field.' } : { code: "validation_required", message: "Cannot be blank." };
    const errs: Record<string, unknown> = { fields: fieldsErr, viewQuery: { code: "validation_invalid_view_query", message: "Invalid query - " + sentenized } };
    void isNew;
    throw badRequest(failMsg, errs as never);
  }
}
const viewIdField = () => ({ name: "id", type: "text", system: true, required: true, primaryKey: true, pattern: "^[a-z0-9]+$" });

// core/view.go identifiersParser: select list, from table and join tables with their aliases
function parseViewQuery(sql: string): { columns: { original: string; alias: string }[]; tables: { original: string; alias: string }[] } {
  let str = sql.trim().replace(/;+$/, "");
  str = str.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  str = str.replace(/\s+(full\s+outer\s+join|left\s+outer\s+join|right\s+outer\s+join|full\s+join|cross\s+join|inner\s+join|outer\s+join|left\s+join|right\s+join|join)\s+/gi, " __pb_join__ ");
  str = str.replace(/\s+(where|group\s+by|having|order\s+by|limit|offset|window|union|except|intersect)\s+/gi, " __pb_discard__ ");
  const tokens = tokenize(str);
  let part = ""; let skip = false;
  const parts: Record<string, string[]> = { select: [], from: [], join: [] };
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (low === "select") { part = "select"; skip = false; continue; }
    if (low === "distinct") continue;
    if (low === "from") { part = "from"; skip = false; continue; }
    if (low === "__pb_join__") { if (part === "join") parts.join!.push(","); part = "join"; skip = false; continue; }
    if (low === "__pb_discard__") { skip = true; continue; }
    if (part === "join" && low === "on") { skip = true; continue; }
    if (!skip && part) parts[part]!.push(tok);
  }
  return { columns: extractIdentifiers(parts.select!), tables: [...extractIdentifiers(parts.from!), ...extractIdentifiers(parts.join!)] };
}
// splits on whitespace and commas at nesting level zero, keeping the commas as separators
function tokenize(str: string): string[] {
  const out: string[] = []; let cur = ""; let depth = 0; let quote = "";
  for (const ch of str) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") { quote = ch === "[" ? "]" : ch; cur += ch; continue; }
    if (ch === "(") depth++; if (ch === ")") depth--;
    if (depth === 0 && (ch === "," || /\s/.test(ch))) { if (cur) out.push(cur); cur = ""; if (ch === ",") out.push(","); continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const trimIdent = (s: string) => s.replace(/^[`"\[]|[`"\]]$/g, "").split(".").map((p) => p.replace(/^[`"\[]|[`"\]]$/g, "")).join(".");
function extractIdentifiers(tokens: string[]): { original: string; alias: string }[] {
  const groups: string[][] = [[]];
  for (const t of tokens) { if (t === ",") groups.push([]); else groups[groups.length - 1]!.push(t); }
  const out: { original: string; alias: string }[] = [];
  for (const g of groups.filter((x) => x.length)) {
    let original: string, alias: string;
    if (g.length >= 3 && g[g.length - 2]!.toLowerCase() === "as") { original = g.slice(0, -2).join(" "); alias = g[g.length - 1]!; }
    else if (g.length >= 2 && /^[`"\[]?[A-Za-z_]\w*[`"\]]?$/.test(g[g.length - 1]!) && !/[()]/.test(g[g.length - 1]!)) { original = g.slice(0, -1).join(" "); alias = g[g.length - 1]!; }
    else { original = g.join(" "); const parts = trimIdent(original).split("."); alias = parts[parts.length - 1]!; }
    if (/\s/.test(original.trim()) && !/^\(.*\)$/.test(original.trim()) && !/^\w+\s*\(.*\)$/i.test(original.trim())) throw new Error(`invalid identifier parts [${g.join(" ")}].`);
    out.push({ original: trimIdent(original), alias: trimIdent(alias) });
  }
  return out;
}

async function deriveViewFields(db: D1Database, c: Collection): Promise<void> {
  const collections = await loadCollections(db);
  c.fields = await inferViewFields(db, String(c.options.viewQuery ?? ""), collections);
  await stmt(db, "UPDATE `_collections` SET fields = ? WHERE id = ?", [JSON.stringify(c.fields), c.id]).run();
  invalidateCollections();
}

export async function mustCollectionRow(db: D1Database, idOrName: string) {
  const row = await one(db, "SELECT id FROM `_collections` WHERE id = ? OR name = ? LIMIT 1", [idOrName, idOrName]);
  if (!row) throw notFound();
  return row;
}
