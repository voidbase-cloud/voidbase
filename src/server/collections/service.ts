// Collection lifecycle: normalize -> validate -> plan SQL -> one D1 batch. Schema is data, as in PocketBase.
import { crc32 } from "../crc32";
import { all, ident, one, stmt } from "../db";
import { badRequest, notFound, type FieldErrors } from "../errors";
import { nowString, randomString } from "../ids";
import { createIndexesSQL, createTableSQL, createViewSQL, dropIndexesSQL, dropTableSQL, dropViewSQL, parseIndex, buildIndex, syncTableSQL, truncateSQL } from "./ddl";
import { defaultFieldId, normalizeField, sortKeys, type Field } from "./fields";
import { collectionToJSON, invalidateCollections, jsonToCollection, listCollections, type Collection } from "./model";
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
  const rawFields = Array.isArray(merged.fields) ? (merged.fields as Record<string, unknown>[]) : [];
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

function throwIfErrors(errs: Record<string, unknown>, message: string) {
  if (Object.keys(errs).length) throw badRequest(message, errs as FieldErrors);
}

function rowStatements(db: D1Database, c: Collection, mode: "insert" | "update") {
  const params = [c.system, c.type, c.name, JSON.stringify(c.fields), JSON.stringify(c.indexes), c.listRule, c.viewRule, c.createRule, c.updateRule, c.deleteRule, JSON.stringify(c.options), c.created, c.updated];
  return mode === "insert"
    ? stmt(db, "INSERT INTO `_collections` (id, system, type, name, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [c.id, ...params])
    : stmt(db, "UPDATE `_collections` SET system=?, type=?, name=?, fields=?, indexes=?, listRule=?, viewRule=?, createRule=?, updateRule=?, deleteRule=?, options=?, created=?, updated=? WHERE id = ?", [...params, c.id]);
}

export async function createCollection(db: D1Database, raw: Record<string, unknown>): Promise<Collection> {
  const c = prepareCollection(raw, null);
  const ctx = await validateContext(db, []);
  ctx.all.push(c);
  throwIfErrors(validateCollection(c, null, ctx), "Failed to create collection.");
  const statements = [rowStatements(db, c, "insert"), ...planCreate(c).map((sql) => db.prepare(sql))];
  await db.batch(statements);
  invalidateCollections();
  if (c.type === "view") await deriveViewFields(db, c);
  return c;
}

export async function updateCollection(db: D1Database, old: Collection, raw: Record<string, unknown>): Promise<Collection> {
  const c = prepareCollection(raw, old);
  const ctx = await validateContext(db, [c]);
  throwIfErrors(validateCollection(c, old, ctx), "Failed to update collection.");
  const sql = c.type === "view" ? [dropViewSQL(old.name), createViewSQL(c.name, String(c.options.viewQuery ?? ""))] : syncTableSQL(old, c);
  await db.batch([rowStatements(db, c, "update"), ...sql.map((s) => db.prepare(s))]);
  invalidateCollections();
  if (c.type === "view") await deriveViewFields(db, c);
  return c;
}

export async function deleteCollection(db: D1Database, c: Collection): Promise<void> {
  if (c.system) throw badRequest("Failed to delete collection.");
  const refs = (await listCollections(db)).filter((x) => x.id !== c.id && (x.fields as Field[]).some((f) => f.type === "relation" && f.collectionId === c.id));
  if (refs.length) throw badRequest(`Failed to delete collection probably due to existing reference in ${refs.map((r) => r.name).sort().join(", ")}.`);
  const sql = c.type === "view" ? [dropViewSQL(c.name)] : [...dropIndexesSQL(c), dropTableSQL(c.name)];
  await db.batch([...sql.map((s) => db.prepare(s)), stmt(db, "DELETE FROM `_collections` WHERE id = ?", [c.id])]);
  invalidateCollections();
}

export async function truncateCollection(db: D1Database, c: Collection): Promise<void> {
  if (c.type === "view") throw badRequest("View collections cannot be truncated since they don't store their own records.");
  await db.prepare(truncateSQL(c.name)).run();
}

// PUT /api/collections/import
export async function importCollections(db: D1Database, items: Record<string, unknown>[], deleteMissing: boolean): Promise<void> {
  const existing = await listCollections(db);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
  const plan: Array<{ c: Collection; old: Collection | null }> = [];
  for (const raw of items) {
    const old: Collection | null = (raw.id ? byId.get(String(raw.id)) : undefined) ?? (raw.name ? byName.get(String(raw.name).toLowerCase()) : undefined) ?? null;
    plan.push({ c: prepareCollection(raw, old), old });
  }
  const keep = new Set(plan.map((p) => p.c.id));
  const toDelete = deleteMissing ? existing.filter((c) => !c.system && !keep.has(c.id)) : [];
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
async function deriveViewFields(db: D1Database, c: Collection): Promise<void> {
  const cols = await all<{ name: string; type: string }>(db, `PRAGMA table_info(${ident(c.name)})`);
  const taken = new Set<string>();
  c.fields = cols.map((col) => {
    const f = normalizeField(col.name === "id"
      ? { name: "id", type: "text", system: true, required: true, primaryKey: true, autogeneratePattern: "[a-z0-9]{15}", min: 15, max: 15, pattern: "^[a-z0-9]+$" }
      : { name: col.name, type: /INT|REAL|NUM/i.test(col.type) ? "number" : /BOOL/i.test(col.type) ? "bool" : /JSON/i.test(col.type) ? "json" : "text" });
    f.id = defaultFieldId(f.type, f.name, taken);
    taken.add(f.id);
    return sortKeys(f);
  });
  await stmt(db, "UPDATE `_collections` SET fields = ? WHERE id = ?", [JSON.stringify(c.fields), c.id]).run();
  invalidateCollections();
}

export async function mustCollectionRow(db: D1Database, idOrName: string) {
  const row = await one(db, "SELECT id FROM `_collections` WHERE id = ? OR name = ? LIMIT 1", [idOrName, idOrName]);
  if (!row) throw notFound();
  return row;
}
