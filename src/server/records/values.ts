// Record value normalization and validation per field type, mirroring core/field_*.go ValidateValue.
import { isMultiple, type Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import { all, ident } from "../db";
import { nowString } from "../ids";
import type { Row } from "../types";

export interface FieldError { code: string; message: string; params?: Record<string, unknown> }
export type RecordErrors = Record<string, FieldError>;
const err = (code: string, message: string, params?: Record<string, unknown>): FieldError => (params ? { code, message, params } : { code, message });
export const REQUIRED = err("validation_required", "Cannot be blank.");

export interface Upload { name: string; type: string; size: number; bytes: ArrayBuffer }
// value of a file field during an upsert: kept names plus new uploads (already renamed)
export interface FileValue { names: string[]; uploads: Map<string, Upload> }

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// ---- reading rows ---------------------------------------------------------
export function fromColumn(f: Field, v: unknown): unknown {
  if (f.type === "bool") return !!v;
  if (f.type === "number") return typeof v === "number" ? v : Number(v ?? 0) || 0;
  if (f.type === "json") {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
    return v;
  }
  if (f.type === "geoPoint") {
    if (typeof v === "string") { try { const o = JSON.parse(v); return { lon: Number(o?.lon ?? 0), lat: Number(o?.lat ?? 0) }; } catch { /* fallthrough */ } }
    return { lon: 0, lat: 0 };
  }
  if (isMultiple(f)) {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string" && v !== "") { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : [String(v)]; } catch { return [v]; } }
    return [];
  }
  if (v === null || v === undefined) return "";
  return String(v);
}

export function rowToValues(c: Collection, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of c.fields as Field[]) out[f.name] = fromColumn(f, row[f.name]);
  return out;
}

// ---- writing rows ---------------------------------------------------------
export function toColumn(f: Field, v: unknown): unknown {
  if (f.type === "bool") return v ? 1 : 0;
  if (f.type === "number") return typeof v === "number" ? v : Number(v) || 0;
  if (f.type === "json") return v === null || v === undefined ? null : JSON.stringify(v);
  if (f.type === "geoPoint") { const o = (v ?? {}) as { lon?: unknown; lat?: unknown }; return JSON.stringify({ lon: Number(o.lon ?? 0) || 0, lat: Number(o.lat ?? 0) || 0 }); }
  if (isMultiple(f)) return JSON.stringify(Array.isArray(v) ? v : v === "" || v == null ? [] : [String(v)]);
  if (f.type === "file" || f.type === "select" || f.type === "relation") return Array.isArray(v) ? String(v[0] ?? "") : v == null ? "" : String(v);
  return v == null ? "" : String(v);
}

// ---- input normalization (Record.Set semantics) ---------------------------
export function normalizeInput(f: Field, raw: unknown): unknown {
  switch (f.type) {
    case "bool": return raw === true || raw === "true" || raw === 1 || raw === "1";
    case "number": {
      if (raw === "" || raw === null || raw === undefined) return 0;
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? n : NaN;
    }
    case "json": {
      if (raw === undefined) return null;
      if (typeof raw === "string") { const s = raw.trim(); if (s === "") return null; try { return JSON.parse(s); } catch { return raw; } }
      return raw;
    }
    case "geoPoint": {
      let o = raw;
      if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { o = null; } }
      const g = (o ?? {}) as { lon?: unknown; lat?: unknown };
      return { lon: Number(g.lon ?? 0) || 0, lat: Number(g.lat ?? 0) || 0 };
    }
    case "date": return normalizeDate(raw);
    case "select": case "relation": case "file": {
      let list: string[];
      if (Array.isArray(raw)) list = raw.map(String);
      else if (typeof raw === "string") { const s = raw.trim(); if (s.startsWith("[") && isMultiple(f)) { try { list = (JSON.parse(s) as unknown[]).map(String); } catch { list = [s]; } } else list = s === "" ? [] : [s]; }
      else list = raw == null ? [] : [String(raw)];
      list = uniqueStrings(list.map((s) => s.trim()).filter(Boolean));
      return isMultiple(f) ? list : (list[list.length - 1] ?? "");
    }
    default: return raw == null ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  }
}

export const uniqueStrings = (list: string[]) => [...new Set(list)];

export function normalizeDate(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (raw instanceof Date) return nowString(raw);
  const s = String(raw).trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return s;
  const iso = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(s) ? s.replace(" ", "T") : s;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T00:00:00Z" : /Z|[+-]\d{2}:?\d{2}$/.test(iso) || !/T/.test(iso) ? iso : iso + "Z");
  return Number.isNaN(d.getTime()) ? "" : nowString(d);
}

// ---- validation ----------------------------------------------------------
export interface ValidateContext {
  db: D1Database;
  collections: Map<string, Collection>;
  isNew: boolean;
  originalId?: string;
  uploads: Record<string, Map<string, Upload>>; // per file field: newly uploaded name -> upload
  existingFiles: Record<string, string[]>; // per file field: names stored before this request
}

const len = (s: string) => [...s].length;
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "number" && v === 0);

export async function validateValues(c: Collection, values: Record<string, unknown>, ctx: ValidateContext): Promise<RecordErrors> {
  const errors: RecordErrors = {};
  for (const f of c.fields as Field[]) {
    const e = await validateField(f, values[f.name], ctx, values);
    if (e) errors[f.name] = e;
  }
  return errors;
}

async function validateField(f: Field, v: unknown, ctx: ValidateContext, values: Record<string, unknown>): Promise<FieldError | null> {
  const n = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  switch (f.type) {
    case "text": {
      const s = String(v ?? "");
      if (f.primaryKey) {
        if (!ctx.isNew && ctx.originalId !== undefined && s !== ctx.originalId) return err("validation_pk_change", "The record primary key cannot be changed.");
        if (s === "") return REQUIRED;
      } else if (f.required && s === "") return REQUIRED;
      if (s === "") return null;
      if (n(f.min) && len(s) < (n(f.min) as number)) return err("validation_min_text_constraint", `Must be at least ${f.min} character(s).`, { min: f.min });
      if (n(f.max) && len(s) > (n(f.max) as number)) return err("validation_max_text_constraint", `Must be no more than ${f.max} character(s).`, { max: f.max });
      if (f.pattern && !safeRegex(String(f.pattern)).test(s)) return err("validation_invalid_format", "Invalid value format.");
      return null;
    }
    case "editor": {
      const s = String(v ?? "");
      if (f.required && s === "") return REQUIRED;
      if (n(f.maxSize) && new TextEncoder().encode(s).length > (n(f.maxSize) as number)) return err("validation_content_size_limit", `The maximum allowed content size is ${f.maxSize} bytes.`, { maxSize: f.maxSize });
      return null;
    }
    case "number": {
      if (typeof v === "number" && Number.isNaN(v)) return err("validation_not_a_number", "The submitted number is not properly formatted");
      const x = Number(v ?? 0);
      if (f.required && x === 0) return REQUIRED;
      if (f.onlyInt && !Number.isInteger(x)) return err("validation_only_int_constraint", "Decimal numbers are not allowed");
      if (n(f.min) !== null && x < (n(f.min) as number)) return err("validation_min_number_constraint", `Must be greater or equal than ${f.min}.`, { min: f.min });
      if (n(f.max) !== null && x > (n(f.max) as number)) return err("validation_max_number_constraint", `Must be less or equal than ${f.max}.`, { max: f.max });
      return null;
    }
    case "bool": return f.required && !v ? REQUIRED : null;
    case "email": {
      const s = String(v ?? "");
      if (f.required && s === "") return REQUIRED;
      if (s === "") return null;
      if (!EMAIL_RE.test(s)) return err("validation_is_email", "Must be a valid email address.");
      const domain = s.split("@")[1]!.toLowerCase();
      const only = f.onlyDomains as string[] | null; const except = f.exceptDomains as string[] | null;
      if (only?.length && !only.map((d) => d.toLowerCase()).includes(domain)) return err("validation_email_domain_not_allowed", "Email domain is not allowed");
      if (except?.length && except.map((d) => d.toLowerCase()).includes(domain)) return err("validation_email_domain_not_allowed", "Email domain is not allowed");
      return null;
    }
    case "url": {
      const s = String(v ?? "");
      if (f.required && s === "") return REQUIRED;
      if (s === "") return null;
      let host = "";
      try { const u = new URL(s); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(); host = u.hostname.toLowerCase(); } catch { return err("validation_invalid_url", "Must be a valid url."); }
      const only = f.onlyDomains as string[] | null; const except = f.exceptDomains as string[] | null;
      if (only?.length && !only.map((d) => d.toLowerCase()).includes(host)) return err("validation_url_domain_not_allowed", "Url domain is not allowed");
      if (except?.length && except.map((d) => d.toLowerCase()).includes(host)) return err("validation_url_domain_not_allowed", "Url domain is not allowed");
      return null;
    }
    case "date": {
      const s = String(v ?? "");
      if (f.required && s === "") return REQUIRED;
      if (s === "") return null;
      if (f.min && s < String(f.min)) return err("validation_min_date_constraint", `Must be later than ${f.min}`, { min: f.min });
      if (f.max && s > String(f.max)) return err("validation_max_date_constraint", `Must be earlier than ${f.max}`, { max: f.max });
      return null;
    }
    case "autodate": return null;
    case "select": {
      const list = Array.isArray(v) ? (v as string[]) : v ? [String(v)] : [];
      if (f.required && list.length === 0) return REQUIRED;
      const max = isMultiple(f) ? Number(f.maxSelect) : 1;
      if (list.length > max) return err("validation_too_many_values", `Select no more than ${max}`, { maxSelect: max });
      const allowed = (f.values as string[] | null) ?? [];
      for (const s of list) if (!allowed.includes(s)) return err("validation_invalid_value", `Invalid value ${s}.`, { value: s });
      return null;
    }
    case "relation": {
      const list = Array.isArray(v) ? (v as string[]) : v ? [String(v)] : [];
      if (f.required && list.length === 0) return REQUIRED;
      const max = isMultiple(f) ? Number(f.maxSelect) : 1;
      const min = Number(f.minSelect ?? 0);
      if (min > 0 && list.length < min) return err("validation_not_enough_values", `Select at least ${min}`, { minSelect: min });
      if (max > 0 && list.length > max) return err("validation_too_many_values", `Select no more than ${max}`, { maxSelect: max });
      if (list.length === 0) return null;
      const rel = ctx.collections.get(String(f.collectionId));
      if (!rel) return err("validation_missing_rel_collection", "Relation connection is missing or cannot be accessed");
      const found = new Set<string>();
      for (let i = 0; i < list.length; i += 90) {
        const chunk = list.slice(i, i + 90);
        const rows = await all<{ id: string }>(ctx.db, `SELECT id FROM ${ident(rel.name)} WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
        for (const r of rows) found.add(r.id);
      }
      if (list.some((id) => !found.has(id))) return err("validation_missing_rel_records", "Failed to find all relation records with the provided ids.");
      return null;
    }
    case "file": {
      const list = Array.isArray(v) ? (v as string[]) : v ? [String(v)] : [];
      if (f.required && list.length === 0) return REQUIRED;
      const max = isMultiple(f) ? Number(f.maxSelect) : 1;
      if (max > 0 && list.length > max) return err("validation_too_many_files", `The maximum allowed files is ${max}`, { maxSelect: max });
      const uploads = ctx.uploads[f.name] ?? new Map<string, Upload>();
      const existing = new Set(ctx.existingFiles[f.name] ?? []);
      const invalid = list.filter((name) => !uploads.has(name) && !existing.has(name));
      if (invalid.length) return err("validation_invalid_file", `Invalid new files: ${invalid.join(", ")}.`, { invalidFiles: invalid.join(", ") });
      const mimeTypes = (f.mimeTypes as string[] | null) ?? [];
      const maxSize = Number(f.maxSize ?? 0);
      for (const name of list) {
        const up = uploads.get(name);
        if (!up) continue;
        if (maxSize > 0 && up.size > maxSize) return err("validation_file_size_limit", `Failed to upload "${name}" - the maximum allowed file size is ${maxSize} bytes.`, { maxSize });
        if (mimeTypes.length && !mimeTypes.includes(up.type)) return err("validation_invalid_mime_type", `"${name}" mime type must be one of: ${mimeTypes.join(", ")}.`);
      }
      return null;
    }
    case "json": {
      if (f.required && (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v && Object.keys(v as object).length === 0))) return REQUIRED;
      const bytes = new TextEncoder().encode(JSON.stringify(v ?? null)).length;
      if (n(f.maxSize) && bytes > (n(f.maxSize) as number)) return err("validation_json_size_limit", `The maximum allowed JSON size is ${f.maxSize} bytes.`, { maxSize: f.maxSize });
      return null;
    }
    case "password": {
      // v here is the plain text password when it is being set; empty means untouched
      const s = String(v ?? "");
      if (s === "") return null;
      if (n(f.min) && len(s) < (n(f.min) as number)) return err("validation_min_text_constraint", `Must be at least ${f.min} character(s).`);
      if (n(f.max) && len(s) > (n(f.max) as number)) return err("validation_max_text_constraint", `Must be no more than ${f.max} character(s).`);
      if (f.pattern && !safeRegex(String(f.pattern)).test(s)) return err("validation_invalid_format", "Invalid value format.");
      return null;
    }
    case "geoPoint": {
      const g = (v ?? {}) as { lon?: number; lat?: number };
      const lon = Number(g.lon ?? 0), lat = Number(g.lat ?? 0);
      if (f.required && lon === 0 && lat === 0) return REQUIRED;
      if (lon < -180 || lon > 180) return err("validation_invalid_longitude", "Longitude must be between -180 and 180 degrees.");
      if (lat < -90 || lat > 90) return err("validation_invalid_latitude", "Latitude must be between -90 and 90 degrees.");
      return null;
    }
  }
  void values; void isEmpty;
  return null;
}

const regexCache = new Map<string, RegExp>();
function safeRegex(p: string): RegExp {
  let r = regexCache.get(p);
  if (!r) { try { r = new RegExp(p); } catch { r = /$^/; } regexCache.set(p, r); }
  return r;
}

// Generates a value for autogeneratePattern: literal chars and [class]{n} groups (the forms PocketBase ships).
export function autogenerate(pattern: string): string {
  let out = "";
  const re = /\[([^\]]+)\]\{(\d+)(?:,(\d+))?\}|\[([^\]]+)\]|(\\?.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern))) {
    if (m[1] !== undefined) out += randomFromClass(m[1], Number(m[2]) + (m[3] ? Math.floor(Math.random() * (Number(m[3]) - Number(m[2]) + 1)) : 0));
    else if (m[4] !== undefined) out += randomFromClass(m[4], 1);
    else out += m[5]!.replace(/^\\/, "");
  }
  return out;
}
function randomFromClass(cls: string, count: number): string {
  const chars: string[] = [];
  for (let i = 0; i < cls.length; i++) {
    if (cls[i + 1] === "-" && i + 2 < cls.length) {
      for (let c = cls.charCodeAt(i); c <= cls.charCodeAt(i + 2); c++) chars.push(String.fromCharCode(c));
      i += 2;
    } else chars.push(cls[i]!);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  let s = "";
  for (let i = 0; i < count; i++) s += chars[bytes[i]! % chars.length];
  return s;
}
