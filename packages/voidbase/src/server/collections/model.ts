import { all, one } from "../db";
import type { Row } from "../types";
import type { Field } from "./fields";
import authOptionShape from "./auth-option-shape.json";

export type CollectionType = "base" | "auth" | "view";

export type CollectionField = Field;

// Mirrors PocketBase's collection JSON. Type-specific options (auth token configs, viewQuery, ...)
// live in `options` in the table and are flattened into the JSON the API returns.
export interface Collection {
  id: string;
  system: boolean;
  type: CollectionType;
  name: string;
  fields: CollectionField[];
  indexes: string[];
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
  options: Record<string, unknown>;
  created: string;
  updated: string;
}

const COMMON_KEYS = new Set([
  "id", "system", "type", "name", "fields", "indexes",
  "listRule", "viewRule", "createRule", "updateRule", "deleteRule", "created", "updated",
]);

export function rowToCollection(row: Row): Collection {
  return {
    id: String(row.id),
    system: !!row.system,
    type: String(row.type) as CollectionType,
    name: String(row.name),
    fields: JSON.parse(String(row.fields ?? "[]")),
    indexes: JSON.parse(String(row.indexes ?? "[]")),
    listRule: (row.listRule as string | null) ?? null,
    viewRule: (row.viewRule as string | null) ?? null,
    createRule: (row.createRule as string | null) ?? null,
    updateRule: (row.updateRule as string | null) ?? null,
    deleteRule: (row.deleteRule as string | null) ?? null,
    options: JSON.parse(String(row.options ?? "{}")),
    created: String(row.created ?? ""),
    updated: String(row.updated ?? ""),
  };
}

// Split a PocketBase-shaped collection JSON (as in exports/imports) into row columns + options.
export function jsonToCollection(json: Record<string, unknown>): Collection {
  const options: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) if (!COMMON_KEYS.has(k)) options[k] = v;
  return {
    id: String(json.id ?? ""),
    system: !!json.system,
    type: (json.type as CollectionType) ?? "base",
    name: json.name == null ? "" : String(json.name),
    fields: (json.fields as CollectionField[]) ?? [],
    indexes: (json.indexes as string[]) ?? [],
    listRule: (json.listRule as string | null) ?? null,
    viewRule: (json.viewRule as string | null) ?? null,
    createRule: (json.createRule as string | null) ?? null,
    updateRule: (json.updateRule as string | null) ?? null,
    deleteRule: (json.deleteRule as string | null) ?? null,
    options,
    created: String(json.created ?? ""),
    updated: String(json.updated ?? ""),
  };
}

// The JSON the API returns for a collection, in PocketBase's marshaling order.
const AUTH_OPTION_ORDER = [
  "authRule", "manageRule", "authAlert", "oauth2", "passwordAuth", "mfa", "otp", "authToken",
  "passwordResetToken", "emailChangeToken", "verificationToken", "fileToken",
  "verificationTemplate", "resetPasswordTemplate", "confirmEmailChangeTemplate",
];
const VIEW_OPTION_ORDER = ["viewQuery"];

export function collectionToJSON(c: Collection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    listRule: c.listRule,
    viewRule: c.viewRule,
    createRule: c.createRule,
    updateRule: c.updateRule,
    deleteRule: c.deleteRule,
    name: c.name,
    type: c.type,
    fields: c.fields,
    indexes: c.indexes,
    created: c.created,
    updated: c.updated,
    system: c.system,
  };
  const order = c.type === "auth" ? AUTH_OPTION_ORDER : c.type === "view" ? VIEW_OPTION_ORDER : [];
  const shape = c.type === "auth" ? (authOptionShape as Record<string, unknown>) : {};
  for (const k of order) if (k in c.options) out[k] = withoutSecret(reorderLike(c.options[k], shape[k]));
  for (const [k, v] of Object.entries(c.options)) if (!(k in out)) out[k] = withoutSecret(v);
  return out;
}

// Emit nested option objects in PocketBase's struct key order (inputs arrive in arbitrary order, e.g. sorted snapshots).
function reorderLike(value: unknown, spec: unknown): unknown {
  if (!spec || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const elem = Array.isArray(spec) ? spec[0] : null;
    return elem ? value.map((v) => reorderLike(v, elem)) : value;
  }
  if (Array.isArray(spec)) return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(spec as object)) if (k in src) out[k] = reorderLike(src[k], (spec as Record<string, unknown>)[k]);
  for (const [k, v] of Object.entries(src)) if (!(k in out)) out[k] = v;
  return out;
}

// PocketBase never returns token secrets in collection JSON.
function withoutSecret(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && "secret" in (v as object)) {
    const { secret: _s, ...rest } = v as Record<string, unknown>;
    return rest;
  }
  return v;
}

export const isAuth = (c: Collection) => c.type === "auth";
export const isView = (c: Collection) => c.type === "view";
export const SUPERUSERS = "_superusers";

type OptionsObj = Record<string, unknown>;
export function option<T = unknown>(c: Collection, path: string, fallback: T): T {
  let cur: unknown = c.options;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return fallback;
    cur = (cur as OptionsObj)[key];
  }
  return (cur === undefined ? fallback : cur) as T;
}

// Per-isolate cache. Writes to _collections must call invalidateCollections().
let cache: Map<string, Collection> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 5_000;

export function invalidateCollections() {
  cache = null;
}

export async function loadCollections(db: D1Database): Promise<Map<string, Collection>> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const rows = await all(db, "SELECT * FROM `_collections` ORDER BY rowid ASC");
  const map = new Map<string, Collection>();
  for (const row of rows) {
    const c = rowToCollection(row);
    map.set(c.id, c);
    map.set(c.name, c);
  }
  cache = map;
  cacheAt = Date.now();
  return map;
}

export async function findCollection(db: D1Database, idOrName: string): Promise<Collection | null> {
  const map = await loadCollections(db);
  const hit = map.get(idOrName);
  if (hit) return hit;
  const row = await one(db, "SELECT * FROM `_collections` WHERE id = ? OR name = ? LIMIT 1", [idOrName, idOrName]);
  return row ? rowToCollection(row) : null;
}

export async function listCollections(db: D1Database): Promise<Collection[]> {
  const map = await loadCollections(db);
  const seen = new Set<string>();
  const out: Collection[] = [];
  for (const c of map.values()) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}
