// Field type registry mirroring PocketBase core/field_*.go: defaults, normalization, column types.
import { crc32 } from "../crc32";

export const FIELD_TYPES = [
  "text", "editor", "number", "bool", "email", "url", "date", "autodate",
  "select", "file", "relation", "json", "password", "geoPoint",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  system: boolean;
  hidden: boolean;
  presentable: boolean;
  required: boolean;
  help: string;
  [option: string]: unknown;
}

// Type-specific option defaults, as PocketBase marshals them when unset (Go zero values / nil slices).
const TYPE_DEFAULTS: Record<FieldType, Record<string, unknown>> = {
  text: { autogeneratePattern: "", max: 0, min: 0, pattern: "", primaryKey: false },
  editor: { convertURLs: false, maxSize: 0 },
  number: { max: null, min: null, onlyInt: false },
  bool: {},
  email: { exceptDomains: null, onlyDomains: null },
  url: { exceptDomains: null, onlyDomains: null },
  date: { max: "", min: "" },
  autodate: { onCreate: false, onUpdate: false },
  select: { maxSelect: 0, values: null },
  file: { maxSelect: 0, maxSize: 0, mimeTypes: null, protected: false, thumbs: null },
  relation: { cascadeDelete: false, collectionId: "", maxSelect: 0, minSelect: 0 },
  json: { maxSize: 0 },
  password: { cost: 0, max: 0, min: 0, pattern: "" },
  geoPoint: {},
};

const COMMON_DEFAULTS = { help: "", hidden: false, presentable: false, required: false, system: false };

export const isFieldType = (t: unknown): t is FieldType => typeof t === "string" && (FIELD_TYPES as readonly string[]).includes(t);

const num = (v: unknown, fallback: number | null) => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: unknown, fallback = false) => (v === undefined || v === null ? fallback : v === true || v === "true" || v === 1);
const str = (v: unknown, fallback = "") => (v === undefined || v === null ? fallback : String(v));
const strList = (v: unknown, fallback: string[] | null) => (Array.isArray(v) ? v.map(String) : fallback);

// Coerce raw JSON (from the panel, imports, migrations) into the canonical field object with alphabetical keys.
export function normalizeField(raw: Record<string, unknown>): Field {
  const type = raw.type as FieldType;
  const out: Record<string, unknown> = {
    id: str(raw.id),
    name: str(raw.name),
    type,
    system: bool(raw.system),
    hidden: bool(raw.hidden),
    presentable: bool(raw.presentable),
    required: bool(raw.required),
    help: str(raw.help),
  };
  if (type === "autodate") {
    // AutodateField has no help/required in PocketBase's JSON
    delete out.help;
    delete out.required;
  }
  const d = TYPE_DEFAULTS[type] ?? {};
  for (const [k, def] of Object.entries(d)) {
    const v = raw[k];
    if (typeof def === "boolean") out[k] = bool(v, def);
    else if (typeof def === "number" || def === null && (k === "max" || k === "min")) out[k] = num(v, def as number | null);
    else if (Array.isArray(def) || def === null) out[k] = k === "collectionId" ? str(v) : strList(v, def as string[] | null);
    else out[k] = str(v, def as string);
  }
  if (type === "relation") out.collectionId = str(raw.collectionId);
  return sortKeys(out) as Field;
}

export function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as T;
}

// PocketBase: id = type + crc32(name), suffixed 2..999 until unique within the list.
export function defaultFieldId(type: string, name: string, taken: Set<string>): string {
  const base = type + crc32(name);
  let id = base;
  for (let i = 2; taken.has(id) && i < 1000; i++) id = base + i;
  return id;
}

export function isMultiple(f: Field): boolean {
  if (f.type === "select" || f.type === "file" || f.type === "relation") return Number(f.maxSelect ?? 0) > 1;
  return false;
}

// SQLite column definition for a field (core/field_*.go ColumnType).
export function columnType(f: Field): string {
  switch (f.type) {
    case "text":
      return f.primaryKey ? "TEXT PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL" : "TEXT DEFAULT '' NOT NULL";
    case "editor": case "email": case "url": case "date": case "autodate": case "password":
      return "TEXT DEFAULT '' NOT NULL";
    case "number":
      return "NUMERIC DEFAULT 0 NOT NULL";
    case "bool":
      return "BOOLEAN DEFAULT FALSE NOT NULL";
    case "select": case "file": case "relation":
      return isMultiple(f) ? "JSON DEFAULT '[]' NOT NULL" : "TEXT DEFAULT '' NOT NULL";
    case "json":
      return "JSON DEFAULT NULL";
    case "geoPoint":
      return `JSON DEFAULT '{"lon":0,"lat":0}' NOT NULL`;
  }
}

export const SYSTEM_AUTH_FIELDS = ["password", "tokenKey", "email", "emailVisibility", "verified"] as const;

// System fields voidbase adds to a collection at runtime for a feature of its own, as opposed to the ones a collection's
// type implies (collections/service.ts ensureDefaultFields). Nobody writing a definition wrote them, so a definition that
// leaves one out keeps it (service.ts keepRuntimeFields), and one that names it may not turn its system flag off
// (validate.ts). A new field of this kind is listed here. The name is spelled out rather than imported as PREVIEW_FIELD,
// because records/preview.ts imports the collections service.
export const RUNTIME_SYSTEM_FIELDS: readonly string[] = [
  "_preview", // records/preview.ts PREVIEW_FIELD: the flagged preview lane's mark, added on a collection's first flagged write
];
