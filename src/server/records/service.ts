// Records CRUD mirroring apis/record_crud.go + forms/record_upsert.go: API rules, modifiers, autodate,
// auth-record form rules, unique-constraint mapping, file storage, expand and fields.
import { isMultiple, type Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import { all, ident, one, stmt } from "../db";
import { ApiError, badRequest, forbidden, notFound, type FieldErrors } from "../errors";
import { compileFilter, compileSort, FilterError, renderJoin, type Join, type RequestInfo } from "../filter/compile";
import { FilterSyntaxError } from "../filter/lexer";
import { nowString, randomId, randomString } from "../ids";
import { hashPassword, verifyPassword } from "../password";
import type { AuthRecord, Row } from "../types";
import { expandRecords } from "./expand";
import { deleteAllRecordFiles, deleteFiles, normalizeFilename, putUpload, sniffMime } from "./files";
import { recordToJSON } from "./json";
import { parseFields, pick } from "./picker";
import { autogenerate, normalizeInput, rowToValues, toColumn, uniqueStrings, validateValues, type FieldError, type RecordErrors, type Upload } from "./values";
import { CollectionRef, HookRecord } from "../hooks/record";
import { trigger, type RequestEvent } from "../hooks/runtime";

export interface RecordContext {
  db: D1Database;
  storage: R2Bucket;
  auth: AuthRecord | null;
  superuser: boolean;
  request: RequestInfo;
  collections: Map<string, Collection>;
  // present when called from an HTTP route: builds the JSVM RequestEvent for *Request hooks
  hookEvent?: (record: HookRecord, collection: Collection) => RequestEvent;
}

export interface ListQuery { page: number; perPage: number; skipTotal: boolean; sort: string; filter: string; expand: string; fields: string }
export interface EnrichOptions { expand?: string; fields?: string }

const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 30;
const SUPERUSER_ONLY_MSG = "Only superusers can perform this action.";

// ---- reading -------------------------------------------------------------------------------------
function ruleParts(ctx: RecordContext, c: Collection, rule: string | null): { sql: string; params: unknown[]; joins: Join[] } | null {
  if (ctx.superuser) return null;
  if (rule === null) throw forbidden(SUPERUSER_ONLY_MSG);
  if (rule.trim() === "") return null;
  const compiled = compileFilter(rule, { base: c, collections: ctx.collections, request: ctx.request, allowHiddenFields: true });
  return { sql: compiled.where, params: compiled.params, joins: compiled.joins };
}

function selectSQL(c: Collection, conds: { sql: string; params: unknown[] }[], joins: Join[], tail = "", count = false): { sql: string; params: unknown[] } {
  const base = ident(c.name);
  const distinct = joins.some((j) => j.multi);
  const joinSql = joins.map(renderJoin).join(" ");
  const where = conds.length ? `WHERE ${conds.map((x) => `(${x.sql})`).join(" AND ")}` : "";
  const params = [...joins.flatMap((j) => j.params), ...conds.flatMap((x) => x.params)];
  const select = count ? (distinct ? `COUNT(DISTINCT ${base}.id) AS n` : "COUNT(*) AS n") : `${distinct ? "DISTINCT " : ""}${base}.*`;
  return { sql: `SELECT ${select} FROM ${base} ${joinSql} ${where} ${tail}`.replace(/\s+/g, " ").trim(), params };
}

function mergeJoins(...lists: Join[][]): Join[] {
  const out: Join[] = [];
  for (const j of lists.flat()) if (!out.some((x) => x.alias === j.alias)) out.push(j);
  return out;
}

function wrapFilterError(err: unknown): never {
  if (err instanceof FilterError || err instanceof FilterSyntaxError) throw badRequest();
  throw err;
}

export async function listRecords(ctx: RecordContext, c: Collection, q: ListQuery) {
  if (!ctx.superuser) {
    for (const token of ["@collection.", "@request."]) {
      if (q.filter.includes(token) || q.sort.includes(token)) throw forbidden(`Only superusers can filter by ${token}`);
    }
  }
  const conds: { sql: string; params: unknown[] }[] = [];
  let joins: Join[] = [];
  const rule = ruleParts(ctx, c, c.listRule);
  if (rule) { conds.push(rule); joins = mergeJoins(joins, rule.joins); }
  if (q.filter.trim()) {
    try {
      const f = compileFilter(q.filter, { base: c, collections: ctx.collections, request: ctx.request, allowHiddenFields: ctx.superuser });
      conds.push({ sql: f.where, params: f.params });
      joins = mergeJoins(joins, f.joins);
    } catch (err) { wrapFilterError(err); }
  }
  let orderBy = "";
  try { orderBy = compileSort(q.sort, c, ctx.superuser) || `ORDER BY ${ident(c.name)}.rowid ASC`; } catch (err) { wrapFilterError(err); }
  const page = Math.max(1, q.page || 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, q.perPage || DEFAULT_PER_PAGE));
  const sel = selectSQL(c, conds, joins, `${orderBy} LIMIT ? OFFSET ?`);
  let rows: Row[];
  try { rows = await all(ctx.db, sel.sql, [...sel.params, perPage, (page - 1) * perPage]); } catch (err) { throw sqlError(err); }
  let totalItems = -1, totalPages = -1;
  if (!q.skipTotal) {
    const cnt = selectSQL(c, conds, joins, "", true);
    const r = await one<{ n: number }>(ctx.db, cnt.sql, cnt.params);
    totalItems = r?.n ?? 0;
    totalPages = Math.ceil(totalItems / perPage);
  }
  const items = await enrich(ctx, c, rows, { expand: q.expand, fields: q.fields });
  return { items, page, perPage, totalItems, totalPages };
}

export async function fetchRecord(ctx: RecordContext, c: Collection, id: string, rule: string | null): Promise<Row | null> {
  const conds: { sql: string; params: unknown[] }[] = [{ sql: `${ident(c.name)}.id = ?`, params: [id] }];
  let joins: Join[] = [];
  const r = ruleParts(ctx, c, rule);
  if (r) { conds.push(r); joins = r.joins; }
  const sel = selectSQL(c, conds, joins, "LIMIT 1");
  try { return await one(ctx.db, sel.sql, sel.params); } catch (err) { throw sqlError(err); }
}

export async function viewRecord(ctx: RecordContext, c: Collection, id: string, opts: EnrichOptions) {
  const row = await fetchRecord(ctx, c, id, c.viewRule);
  if (!row) throw notFound();
  return (await enrich(ctx, c, [row], opts))[0];
}

export async function enrich(ctx: RecordContext, c: Collection, rows: Row[], opts: EnrichOptions): Promise<Record<string, unknown>[]> {
  const expands = (opts.expand ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const expandMap = expands.length ? await expandRecords({ db: ctx.db, collections: ctx.collections, auth: ctx.auth, superuser: ctx.superuser, request: ctx.request }, c, rows, expands) : null;
  let items: unknown = rows.map((r) => recordToJSON(c, r, { auth: ctx.auth, own: isOwn(ctx, c, r), expand: expandMap?.get(String(r.id)) }));
  if (opts.fields?.trim()) {
    try { items = pick(items, parseFields(opts.fields)); } catch { throw badRequest(); }
  }
  return items as Record<string, unknown>[];
}

const isOwn = (ctx: RecordContext, c: Collection, row: Row) => c.type === "auth" && !!ctx.auth && ctx.auth.collection.id === c.id && ctx.auth.row.id === row.id;

// ---- input ---------------------------------------------------------------------------------------
type RawBody = Record<string, unknown>; // JSON values, strings, File objects, or arrays of those

interface Prepared {
  values: Record<string, unknown>; // final normalized values per field
  uploads: Record<string, Map<string, Upload>>; // per file field
  plain: { password?: string; passwordConfirm?: string; oldPassword?: string };
  plainPasswords: Record<string, string>; // per password-type field: the submitted plain text
  touched: Set<string>;
}

async function toUpload(file: File): Promise<Upload> {
  const bytes = await file.arrayBuffer();
  const sniffed = sniffMime(new Uint8Array(bytes), file.type, file.name);
  return { name: normalizeFilename(file.name, sniffed.ext), type: sniffed.type, size: bytes.byteLength, bytes };
}

const isFile = (v: unknown): v is File => typeof File !== "undefined" && v instanceof File;
const isUpload = (v: unknown): v is Upload => !!v && typeof v === "object" && "bytes" in (v as object) && "name" in (v as object);

async function prepareInput(c: Collection, current: Record<string, unknown>, body: RawBody): Promise<Prepared> {
  const fields = c.fields as Field[];
  const byName = new Map(fields.map((f) => [f.name, f]));
  const values: Record<string, unknown> = { ...current };
  const uploads: Record<string, Map<string, Upload>> = {};
  const plain: Prepared["plain"] = {};
  const plainPasswords: Record<string, string> = {};
  const touched = new Set<string>();
  if ("passwordConfirm" in body) plain.passwordConfirm = String(body.passwordConfirm ?? "");
  if ("oldPassword" in body) plain.oldPassword = String(body.oldPassword ?? "");

  // PocketBase applies modifiers shortest key first
  const keys = Object.keys(body).filter((k) => k !== "passwordConfirm" && k !== "oldPassword").sort((a, b) => a.length - b.length);
  for (const key of keys) {
    const raw = body[key];
    let name = key, mod: "" | "append" | "prepend" | "remove" = "";
    if (byName.has(key)) name = key;
    else if (key.endsWith("+") && byName.has(key.slice(0, -1))) { name = key.slice(0, -1); mod = "append"; }
    else if (key.startsWith("+") && byName.has(key.slice(1))) { name = key.slice(1); mod = "prepend"; }
    else if (key.endsWith("-") && byName.has(key.slice(0, -1))) { name = key.slice(0, -1); mod = "remove"; }
    else continue; // unknown keys are ignored
    const f = byName.get(name)!;
    if (f.type === "autodate") continue;
    touched.add(name);
    if (f.type === "password") {
      plainPasswords[name] = raw == null ? "" : String(raw);
      if (name === "password") plain.password = plainPasswords[name];
      continue;
    }
    if (f.type === "file") {
      const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
      const names: string[] = [];
      for (const item of list) {
        if (isFile(item)) { const up = await toUpload(item); (uploads[name] ??= new Map()).set(up.name, up); names.push(up.name); }
        else if (isUpload(item)) { (uploads[name] ??= new Map()).set(item.name, item); names.push(item.name); }
        else if (typeof item === "string" && item.trim()) { const s = item.trim(); if (s.startsWith("[")) { try { names.push(...(JSON.parse(s) as unknown[]).map(String)); continue; } catch { /* plain name */ } } names.push(s); }
      }
      const cur = (values[name] as string[] | undefined) ?? [];
      const curList = Array.isArray(cur) ? cur : cur ? [String(cur)] : [];
      let next: string[];
      if (mod === "append") next = uniqueStrings([...curList, ...names]);
      else if (mod === "prepend") next = uniqueStrings([...names, ...curList]);
      else if (mod === "remove") next = curList.filter((n) => !names.includes(n));
      else next = uniqueStrings(names);
      values[name] = isMultiple(f) ? next : (next[next.length - 1] ?? "");
      continue;
    }
    if (mod === "") { values[name] = normalizeInput(f, raw); continue; }
    if (f.type === "number") {
      const delta = Number(raw) || 0;
      values[name] = (Number(values[name]) || 0) + (mod === "remove" ? -delta : delta);
      continue;
    }
    if (f.type === "select" || f.type === "relation") {
      const incoming = normalizeInput({ ...f, maxSelect: 99 } as Field, raw) as string[];
      const curList = Array.isArray(values[name]) ? (values[name] as string[]) : values[name] ? [String(values[name])] : [];
      let next: string[];
      if (mod === "append") next = uniqueStrings([...curList, ...incoming]);
      else if (mod === "prepend") next = uniqueStrings([...incoming, ...curList]);
      else next = curList.filter((x) => !incoming.includes(x));
      values[name] = isMultiple(f) ? next : (next[next.length - 1] ?? "");
      continue;
    }
    values[name] = normalizeInput(f, raw);
  }
  return { values, uploads, plain, plainPasswords, touched };
}

function defaults(c: Collection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of c.fields as Field[]) {
    if (f.type === "bool") out[f.name] = false;
    else if (f.type === "number") out[f.name] = 0;
    else if (f.type === "json") out[f.name] = null;
    else if (f.type === "geoPoint") out[f.name] = { lon: 0, lat: 0 };
    else if (isMultiple(f)) out[f.name] = [];
    else out[f.name] = "";
  }
  return out;
}

// ---- rules against not-yet-saved values (create rule, manage rule) ---------------------------------
export async function recordMatchesRule(ctx: RecordContext, c: Collection, rule: string, values: Record<string, unknown>): Promise<boolean> { return ruleMatchesValues(ctx, c, rule, values); }

async function ruleMatchesValues(ctx: RecordContext, c: Collection, rule: string, values: Record<string, unknown>): Promise<boolean> {
  const dummy = `${c.name}__dry${randomString(6).toLowerCase()}`;
  let compiled;
  try {
    compiled = compileFilter(rule, { base: c, baseTable: dummy, collections: ctx.collections, request: ctx.request, allowHiddenFields: true });
  } catch { return false; }
  const fields = c.fields as Field[];
  const cols = fields.map((f) => `? AS ${ident(f.name)}`).join(", ");
  const params = fields.map((f) => toColumn(f, values[f.name]));
  const joins = compiled.joins.map(renderJoin).join(" ");
  const sql = `WITH ${ident(dummy)} AS (SELECT ${cols}) SELECT 1 AS ok FROM ${ident(dummy)} ${joins} WHERE ${compiled.where} LIMIT 1`;
  try {
    const row = await one(ctx.db, sql, [...params, ...compiled.joins.flatMap((j) => j.params), ...compiled.params]);
    return !!row;
  } catch (err) { console.error("voidbase: rule evaluation failed", err); return false; }
}

async function hasManageAccess(ctx: RecordContext, c: Collection, values: Record<string, unknown>): Promise<boolean> {
  if (ctx.superuser) return true;
  if (c.type !== "auth" || !ctx.auth) return false;
  const rule = c.options.manageRule as string | null | undefined;
  if (rule === null || rule === undefined) return false;
  if (rule.trim() === "") return true;
  return ruleMatchesValues(ctx, c, rule, values);
}

// ---- auth form rules (forms/record_upsert.go validateFormFields) ----------------------------------
function authFormErrors(c: Collection, p: Prepared, original: Record<string, unknown> | null, manage: boolean): RecordErrors {
  const errors: RecordErrors = {};
  if (c.type !== "auth") return errors;
  const isNew = original === null;
  const mismatch: FieldError = { code: "validation_values_mismatch", message: "Values don't match." };
  const required: FieldError = { code: "validation_required", message: "Cannot be blank." };
  const password = p.plain.password ?? "";
  const confirm = p.plain.passwordConfirm ?? "";
  const old = p.plain.oldPassword ?? "";
  if (!isNew && !manage && p.touched.has("email") && p.values.email !== original.email) errors.email = mismatch;
  if (!manage && p.touched.has("verified") && !!p.values.verified !== !!(original?.verified ?? false)) errors.verified = mismatch;
  if ((isNew || confirm !== "" || old !== "") && password === "") errors.password = required;
  if ((isNew || password !== "" || old !== "") && confirm === "") errors.passwordConfirm = required;
  else if (confirm !== "" && confirm !== password) errors.passwordConfirm = mismatch;
  if (!isNew && !manage && (password !== "" || confirm !== "") && old === "") errors.oldPassword = required;
  return errors;
}

// ---- change feed -----------------------------------------------------------------------------------
function changeStmt(db: D1Database, c: Collection, action: "create" | "update" | "delete", row: Row) {
  return stmt(db, "INSERT INTO `_changes` (collection, recordId, action, data, created) VALUES (?, ?, ?, ?, ?)", [c.name, String(row.id), action, JSON.stringify(row), nowString()]);
}
function valuesToRow(c: Collection, values: Record<string, unknown>): Row {
  const row: Row = {};
  for (const f of c.fields as Field[]) row[f.name] = toColumn(f, values[f.name]);
  return row;
}

// ---- errors ---------------------------------------------------------------------------------------
const sortedErrors = (e: RecordErrors) => Object.fromEntries(Object.entries(e).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as unknown as FieldErrors;

function sqlError(err: unknown): ApiError {
  console.error("voidbase: sql error", err);
  return badRequest();
}

function uniqueViolation(err: unknown): string | null {
  const m = /UNIQUE constraint failed: \w+\.(\w+)/.exec(String((err as Error)?.message ?? err));
  return m ? m[1]! : null;
}

// ---- create ---------------------------------------------------------------------------------------
export async function createRecord(ctx: RecordContext, c: Collection, body: RawBody, opts: EnrichOptions) {
  if (c.type === "view") throw badRequest("Unsupported collection type.");
  if (c.createRule === null && !ctx.superuser) throw forbidden(SUPERUSER_ONLY_MSG);
  const fields = c.fields as Field[];
  const p = await prepareInput(c, defaults(c), body);
  const now = nowString();
  for (const f of fields) {
    if (f.type === "text" && f.autogeneratePattern && !p.values[f.name]) p.values[f.name] = autogenerate(String(f.autogeneratePattern));
    if (f.type === "autodate" && f.onCreate) p.values[f.name] = now;
  }
  if (!p.values.id) p.values.id = randomId();
  if (c.type === "auth" && !p.values.tokenKey) p.values.tokenKey = randomString(50);
  for (const f of fields) if (f.type === "password") p.values[f.name] = p.plainPasswords[f.name] ?? "";
  ctx.request.body = { ...p.values };
  if (!ctx.superuser && c.createRule && c.createRule.trim() !== "" && !(await ruleMatchesValues(ctx, c, c.createRule, p.values))) {
    throw badRequest("Failed to create record.");
  }
  const manage = await hasManageAccess(ctx, c, p.values);
  const rec = new HookRecord(new CollectionRef(c), {}, { isNew: true });
  rec.values = p.values;
  const reqEv = ctx.hookEvent?.(rec, c);
  const core = async () => {
    const values = rec.values; // hooks may have changed it
    const errors: RecordErrors = { ...authFormErrors(c, { ...p, values }, null, manage) };
    const fieldErrors = await validateValues(c, values, { db: ctx.db, collections: ctx.collections, isNew: true, uploads: mergeUploads(p.uploads, rec.uploads), existingFiles: {} });
    for (const [k, v] of Object.entries(fieldErrors)) if (!(k in errors)) errors[k] = v;
    if (c.type === "auth" && values.id) {
      const clash = await one(ctx.db, `SELECT 1 AS x FROM ${ident(c.name)} WHERE id = ?`, [values.id]);
      if (clash) errors.id = { code: "validation_pk_invalid", message: "The record primary key is invalid or already exists." };
    }
    if (Object.keys(errors).length) throw badRequest("Failed to create record.", sortedErrors(errors));
    const stored = { ...values };
    for (const f of fields) if (f.type === "password") stored[f.name] = stored[f.name] ? await hashPassword(String(stored[f.name])) : "";
    const cols = fields.map((f) => ident(f.name));
    const params = fields.map((f) => toColumn(f, stored[f.name]));
    try {
      await ctx.db.batch([stmt(ctx.db, `INSERT INTO ${ident(c.name)} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params), changeStmt(ctx.db, c, "create", valuesToRow(c, stored))]);
    } catch (err) {
      const col = uniqueViolation(err);
      if (col) throw badRequest("Failed to create record.", { [col]: { code: "validation_not_unique", message: "Value must be unique." } } as unknown as FieldErrors);
      if (String((err as Error)?.message).includes("PRIMARY KEY")) throw badRequest("Failed to create record.", { id: { code: "validation_pk_invalid", message: "The record primary key is invalid or already exists." } } as unknown as FieldErrors);
      throw sqlError(err);
    }
    await storeUploads(ctx, c, String(values.id), mergeUploads(p.uploads, rec.uploads));
    rec.markAsNotNew();
    rec.setOriginal(values);
  };
  const modelEv = { app: undefined as unknown, record: rec, model: rec, collection: new CollectionRef(c), next: async () => undefined as unknown };
  const withModelHooks = () => trigger("onModelCreate", modelEv, c.name, () => trigger("onRecordCreate", modelEv, c.name, core));
  if (reqEv) await trigger("onRecordCreateRequest", reqEv, c.name, withModelHooks);
  else await withModelHooks();
  await trigger("onRecordAfterCreateSuccess", modelEv, c.name, async () => undefined);
  await trigger("onModelAfterCreateSuccess", modelEv, c.name, async () => undefined);
  const row = await one(ctx.db, `SELECT * FROM ${ident(c.name)} WHERE id = ?`, [rec.values.id]);
  return (await enrich(ctx, c, [row!], opts))[0];
}

function mergeUploads(a: Record<string, Map<string, Upload>>, b: Record<string, Upload[]>): Record<string, Map<string, Upload>> {
  const out: Record<string, Map<string, Upload>> = {};
  for (const [k, m] of Object.entries(a)) out[k] = new Map(m);
  for (const [k, list] of Object.entries(b)) { const m = out[k] ?? (out[k] = new Map()); for (const up of list) m.set(up.name, up); }
  return out;
}

async function storeUploads(ctx: RecordContext, c: Collection, id: string, uploads: Record<string, Map<string, Upload>>) {
  for (const map of Object.values(uploads)) for (const up of map.values()) {
    try { await putUpload(ctx.storage, c.id, id, up); } catch (err) { console.error("voidbase: file upload failed", err); }
  }
}

// ---- update ---------------------------------------------------------------------------------------
export async function updateRecord(ctx: RecordContext, c: Collection, id: string, body: RawBody, opts: EnrichOptions) {
  if (c.type === "view") throw badRequest("Unsupported collection type.");
  if (c.updateRule === null && !ctx.superuser) throw forbidden(SUPERUSER_ONLY_MSG);
  const row = await fetchRecord(ctx, c, id, c.updateRule);
  if (!row) throw notFound();
  const fields = c.fields as Field[];
  const current = rowToValues(c, row);
  const p = await prepareInput(c, current, body);
  p.values.id = current.id;
  const now = nowString();
  for (const f of fields) if (f.type === "autodate" && f.onUpdate) p.values[f.name] = now;
  ctx.request.body = { ...p.values };
  const manage = await hasManageAccess(ctx, c, current);
  const rec = new HookRecord(new CollectionRef(c), {}, { isNew: false });
  rec.values = p.values;
  rec.setOriginal(current);
  const reqEv = ctx.hookEvent?.(rec, c);
  const core = async () => {
    const values = rec.values;
    const errors: RecordErrors = { ...authFormErrors(c, { ...p, values }, current, manage) };
    if (c.type === "auth" && !manage && !errors.oldPassword && (p.plain.password || p.plain.passwordConfirm) && p.plain.oldPassword) {
      if (!(await verifyPassword(p.plain.oldPassword, String(row.password ?? "")))) errors.oldPassword = { code: "validation_invalid_old_password", message: "Missing or invalid old password." };
    }
    const forValidation = { ...values };
    for (const f of fields) if (f.type === "password") forValidation[f.name] = p.plainPasswords[f.name] ?? "";
    const existingFiles: Record<string, string[]> = {};
    for (const f of fields) if (f.type === "file") { const v = current[f.name]; existingFiles[f.name] = Array.isArray(v) ? (v as string[]) : v ? [String(v)] : []; }
    const uploads = mergeUploads(p.uploads, rec.uploads);
    const fieldErrors = await validateValues(c, forValidation, { db: ctx.db, collections: ctx.collections, isNew: false, originalId: String(current.id), uploads, existingFiles });
    for (const [k, v] of Object.entries(fieldErrors)) if (!(k in errors)) errors[k] = v;
    if (Object.keys(errors).length) throw badRequest("Failed to update record.", sortedErrors(errors));

    const stored = { ...values };
    let refreshTokenKey = false;
    for (const f of fields) {
      if (f.type !== "password") continue;
      const plain = p.plainPasswords[f.name];
      if (plain) { stored[f.name] = await hashPassword(plain); if (f.name === "password") refreshTokenKey = true; }
      else stored[f.name] = row[f.name] ?? "";
    }
    if (c.type === "auth" && p.touched.has("email") && values.email !== current.email) refreshTokenKey = true;
    if (refreshTokenKey) stored.tokenKey = randomString(50);
    const setCols = fields.filter((f) => f.name !== "id").map((f) => `${ident(f.name)} = ?`);
    const params = fields.filter((f) => f.name !== "id").map((f) => toColumn(f, stored[f.name]));
    try {
      await ctx.db.batch([stmt(ctx.db, `UPDATE ${ident(c.name)} SET ${setCols.join(", ")} WHERE id = ?`, [...params, id]), changeStmt(ctx.db, c, "update", { ...valuesToRow(c, stored), id })]);
    } catch (err) {
      const col = uniqueViolation(err);
      if (col) throw badRequest("Failed to update record.", { [col]: { code: "validation_not_unique", message: "Value must be unique." } } as unknown as FieldErrors);
      throw sqlError(err);
    }
    await storeUploads(ctx, c, id, uploads);
    for (const f of fields) {
      if (f.type !== "file") continue;
      const before = existingFiles[f.name] ?? [];
      const afterV = stored[f.name];
      const after = Array.isArray(afterV) ? (afterV as string[]) : afterV ? [String(afterV)] : [];
      const removed = before.filter((n) => !after.includes(n));
      if (removed.length) { try { await deleteFiles(ctx.storage, c.id, id, removed); } catch (err) { console.error("voidbase: file delete failed", err); } }
    }
  };
  const modelEv = { app: undefined as unknown, record: rec, model: rec, collection: new CollectionRef(c), next: async () => undefined as unknown };
  const withModelHooks = () => trigger("onModelUpdate", modelEv, c.name, () => trigger("onRecordUpdate", modelEv, c.name, core));
  if (reqEv) await trigger("onRecordUpdateRequest", reqEv, c.name, withModelHooks);
  else await withModelHooks();
  await trigger("onRecordAfterUpdateSuccess", modelEv, c.name, async () => undefined);
  await trigger("onModelAfterUpdateSuccess", modelEv, c.name, async () => undefined);
  const fresh = await one(ctx.db, `SELECT * FROM ${ident(c.name)} WHERE id = ?`, [id]);
  return (await enrich(ctx, c, [fresh!], opts))[0];
}

// ---- delete ---------------------------------------------------------------------------------------
export async function deleteRecord(ctx: RecordContext, c: Collection, id: string): Promise<void> {
  if (c.type === "view") throw badRequest("Unsupported collection type.");
  if (c.deleteRule === null && !ctx.superuser) throw forbidden(SUPERUSER_ONLY_MSG);
  const row = await fetchRecord(ctx, c, id, c.deleteRule);
  if (!row) throw notFound();
  const rec = HookRecord.fromRow(c, row);
  const reqEv = ctx.hookEvent?.(rec, c);
  const core = async () => {
    // core/record_model.go cascadeRecordDelete: referencing records are unlinked, deleted when the relation is
    // cascadeDelete and nothing else remains, or refused when a required relation would become empty.
    // Everything is planned first and applied in one D1 batch so a refusal leaves nothing half-done.
    const plan: DeletePlan = { statements: [], deleted: [], overlay: new Map() };
    await planCascadeDelete(ctx, c, row, plan);
    await ctx.db.batch(plan.statements);
    for (const d of plan.deleted) {
      try { await deleteAllRecordFiles(ctx.storage, d.c.id, String(d.row.id)); } catch (err) { console.error("voidbase: file cleanup failed", err); }
    }
    for (const d of plan.deleted) {
      if (d.c.id === c.id && d.row.id === row.id) continue; // the main record's hooks fire around this function
      const r = HookRecord.fromRow(d.c, d.row);
      const ev = { app: undefined as unknown, record: r, model: r, collection: new CollectionRef(d.c), next: async () => undefined as unknown };
      await trigger("onRecordAfterDeleteSuccess", ev, d.c.name, async () => undefined);
      await trigger("onModelAfterDeleteSuccess", ev, d.c.name, async () => undefined);
    }
  };
  const modelEv = { app: undefined as unknown, record: rec, model: rec, collection: new CollectionRef(c), next: async () => undefined as unknown };
  const withModelHooks = () => trigger("onModelDelete", modelEv, c.name, () => trigger("onRecordDelete", modelEv, c.name, core));
  if (reqEv) await trigger("onRecordDeleteRequest", reqEv, c.name, withModelHooks);
  else await withModelHooks();
  await trigger("onRecordAfterDeleteSuccess", modelEv, c.name, async () => undefined);
  await trigger("onModelAfterDeleteSuccess", modelEv, c.name, async () => undefined);
}


// ---- cascade delete planning --------------------------------------------------------------------
interface DeletePlan { statements: D1PreparedStatement[]; deleted: { c: Collection; row: Row }[]; overlay: Map<string, Row> }
const REQUIRED_REF_MSG = "Failed to delete record. Make sure that the record is not part of a required relation reference.";

async function planCascadeDelete(ctx: RecordContext, c: Collection, row: Row, plan: DeletePlan): Promise<void> {
  const key = `${c.id}:${row.id}`;
  if (plan.deleted.some((d) => `${d.c.id}:${d.row.id}` === key)) return;
  plan.deleted.push({ c, row });
  const id = String(row.id);
  const others = [...new Set(ctx.collections.values())].filter((o) => o.type !== "view").sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const other of others) {
    for (const f of other.fields as Field[]) {
      if (f.type !== "relation" || f.collectionId !== c.id) continue;
      const col = `${ident(other.name)}.${ident(f.name)}`;
      const match = isMultiple(f) ? `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE json_array(${col}) END) WHERE value = ?)` : `${col} = ?`;
      const self = other.id === c.id;
      const refs = await all<Row>(ctx.db, `SELECT * FROM ${ident(other.name)} WHERE ${match}${self ? ` AND ${ident(other.name)}.id != ?` : ""}`, self ? [id, id] : [id]);
      for (const fresh of refs) {
        const refKey = `${other.id}:${fresh.id}`;
        if (plan.deleted.some((d) => `${d.c.id}:${d.row.id}` === refKey)) continue; // already going away
        const r = plan.overlay.get(refKey) ?? fresh;
        const raw = r[f.name];
        const ids = (isMultiple(f) ? (Array.isArray(raw) ? raw : JSON.parse(String(raw || "[]"))) as unknown[] : [raw]).map(String).filter((x) => x !== "");
        const remaining = ids.filter((x) => x !== id);
        if (f.cascadeDelete && remaining.length === 0) { await planCascadeDelete(ctx, other, r, plan); continue; }
        if (f.required && remaining.length === 0) throw badRequest(REQUIRED_REF_MSG);
        const value = isMultiple(f) ? JSON.stringify(remaining) : (remaining[0] ?? "");
        const now = nowString();
        const updated: Row = { ...r, [f.name]: value };
        const sets = [`${ident(f.name)} = ?`];
        const params: unknown[] = [value];
        for (const af of other.fields as Field[]) if (af.type === "autodate" && af.onUpdate) { sets.push(`${ident(af.name)} = ?`); params.push(now); updated[af.name] = now; }
        plan.overlay.set(refKey, updated);
        plan.statements.push(stmt(ctx.db, `UPDATE ${ident(other.name)} SET ${sets.join(", ")} WHERE id = ?`, [...params, r.id]), changeStmt(ctx.db, other, "update", updated));
      }
    }
  }
  plan.statements.push(stmt(ctx.db, `DELETE FROM ${ident(c.name)} WHERE id = ?`, [id]), changeStmt(ctx.db, c, "delete", row));
}

// ---- programmatic saves from hooks ($app.save / RecordUpsertForm.submit) -------------------------
export async function saveHookRecord(ctx: RecordContext, rec: HookRecord): Promise<HookRecord> {
  const c = rec.collection().data;
  const body: Record<string, unknown> = {};
  for (const f of c.fields as Field[]) {
    if (f.type === "autodate") continue;
    if (f.type === "password") { const v = rec.values[f.name]; if (v && !String(v).startsWith("$2")) body[f.name] = v; continue; }
    if (f.type === "file") { body[f.name] = [...((rec.values[f.name] as string[] | string | undefined) ? ([] as string[]).concat(rec.values[f.name] as string[]) : []).filter((n) => !(rec.uploads[f.name] ?? []).some((u) => u.name === n)), ...(rec.uploads[f.name] ?? [])]; continue; }
    body[f.name] = rec.values[f.name];
  }
  const sctx: RecordContext = { ...ctx, superuser: true, hookEvent: undefined };
  const out = rec.isNew() ? await createRecord(sctx, c, body, {}) : await updateRecord(sctx, c, rec.id, body, {});
  const row = await one(ctx.db, `SELECT * FROM ${ident(c.name)} WHERE id = ?`, [String(out.id)]);
  const saved = HookRecord.fromRow(c, row!);
  rec.values = saved.values; rec.setOriginal(saved.values); rec.markAsNotNew();
  return rec;
}
