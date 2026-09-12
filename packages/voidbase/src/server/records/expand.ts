// Relation expansion (core/record_query_expand.go): direct and nested paths, back-relations `coll_via_field`,
// batched fetches with the target collection's view rule applied, depth capped at 6.
import { isMultiple, type Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import { all, ident } from "../db";
import { compileFilter, renderJoin, type RequestInfo } from "../filter/compile";
import type { AuthRecord, Row } from "../types";
import { recordToJSON } from "./json";
import { previewOf, previewScope } from "./preview";
import { fromColumn } from "./values";

export interface ExpandContext {
  db: D1Database;
  collections: Map<string, Collection>;
  auth: AuthRecord | null;
  superuser: boolean;
  request: RequestInfo;
}

const MAX_DEPTH = 6;
const VIA = /^(\w+)_via_(\w+)$/;

// Returns per-record expand objects (keyed by record id). Records without any resolvable expand get no entry
// unless a valid relation path was requested, in which case they get {} (PocketBase keeps the key).
export async function expandRecords(ctx: ExpandContext, c: Collection, rows: Row[], expands: string[]): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  const paths = [...new Set(expands.map((s) => s.trim()).filter(Boolean))];
  for (const path of paths) await expandPath(ctx, c, rows, path, 1, result);
  return result;
}

async function expandPath(ctx: ExpandContext, c: Collection, rows: Row[], path: string, depth: number, result: Map<string, Record<string, unknown>>): Promise<void> {
  if (depth > MAX_DEPTH || rows.length === 0) return;
  const [head, ...restParts] = path.split(".");
  const rest = restParts.join(".");
  const fields = c.fields as Field[];
  let related: Collection | null = null;
  let byRow = new Map<string, Row[]>(); // base row id -> related rows
  let single = false;
  const relField = fields.find((f) => f.name === head && f.type === "relation");
  if (relField) {
    related = ctx.collections.get(String(relField.collectionId)) ?? null;
    if (!related) return;
    single = !isMultiple(relField);
    const idsByRow = new Map<string, string[]>();
    const allIds = new Set<string>();
    for (const r of rows) {
      const v = fromColumn(relField, r[relField.name]);
      const ids = Array.isArray(v) ? v : v ? [String(v)] : [];
      idsByRow.set(String(r.id), ids);
      ids.forEach((id) => allIds.add(id));
    }
    const fetched = await fetchAllowed(ctx, related, [...allIds]);
    for (const [rid, ids] of idsByRow) byRow.set(rid, ids.map((id) => fetched.get(id)).filter((x): x is Row => !!x));
  } else {
    const via = VIA.exec(head!);
    if (!via) return; // unknown expand: ignored, as PocketBase does
    related = ctx.collections.get(via[1]!) ?? null;
    const backField = related && (related.fields as Field[]).find((f) => f.name === via[2] && f.type === "relation" && f.collectionId === c.id);
    if (!related || !backField) return;
    single = related.indexes.some((idx) => /UNIQUE/i.test(idx) && new RegExp("\\(\\s*[`\"']?" + backField.name + "[`\"']?\\s*\\)").test(idx));
    const ids = rows.map((r) => String(r.id));
    const fetched = await fetchBackRelated(ctx, related, backField, ids);
    for (const r of rows) byRow.set(String(r.id), []);
    for (const rel of fetched) {
      const v = fromColumn(backField, rel[backField.name]);
      const targets = Array.isArray(v) ? v : v ? [String(v)] : [];
      for (const t of targets) byRow.get(t)?.push(rel);
    }
  }
  // nested expands on the related rows
  const nested = new Map<string, Record<string, unknown>>();
  const relatedRows = [...new Map([...byRow.values()].flat().map((r) => [String(r.id), r])).values()];
  if (rest) await expandPath(ctx, related, relatedRows, rest, depth + 1, nested);
  for (const r of rows) {
    const rid = String(r.id);
    const items = byRow.get(rid) ?? [];
    const entry = result.get(rid) ?? {};
    const toJSON = (x: Row) => recordToJSON(related!, x, { auth: ctx.auth, own: ctx.auth?.collection.id === related!.id && ctx.auth.row.id === x.id, expand: nested.get(String(x.id)) });
    if (single) { if (items[0]) entry[head!] = toJSON(items[0]); }
    else if (items.length) entry[head!] = items.map(toJSON);
    result.set(rid, entry);
  }
}

// Fetch records by id through the collection's view rule (superusers bypass it).
async function fetchAllowed(ctx: ExpandContext, c: Collection, ids: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  if (ids.length === 0) return out;
  if (!ctx.superuser && c.viewRule === null) return out;
  let ruleSql = "";
  let ruleParams: unknown[] = [];
  let joins = "";
  if (!ctx.superuser && c.viewRule) {
    const compiled = compileFilter(c.viewRule, { base: c, collections: ctx.collections, request: { ...ctx.request, context: "expand" }, allowHiddenFields: true });
    ruleSql = ` AND (${compiled.where})`;
    ruleParams = compiled.params;
    joins = compiled.joins.map(renderJoin).join(" ");
  }
  // an expanded record is a read like any other: the preview lane applies to it exactly as it does to the list
  const scope = previewScope(c, previewOf(ctx.request));
  if (scope) { ruleSql += ` AND ${scope.sql}`; ruleParams = [...ruleParams, ...scope.params]; }
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const rows = await all(ctx.db, `SELECT DISTINCT ${ident(c.name)}.* FROM ${ident(c.name)} ${joins} WHERE ${ident(c.name)}.id IN (${chunk.map(() => "?").join(",")})${ruleSql}`, [...chunk, ...ruleParams]);
    for (const r of rows) out.set(String(r.id), r);
  }
  return out;
}

async function fetchBackRelated(ctx: ExpandContext, c: Collection, backField: Field, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  if (!ctx.superuser && c.viewRule === null) return [];
  let ruleSql = "";
  let ruleParams: unknown[] = [];
  let joins = "";
  if (!ctx.superuser && c.viewRule) {
    const compiled = compileFilter(c.viewRule, { base: c, collections: ctx.collections, request: { ...ctx.request, context: "expand" }, allowHiddenFields: true });
    ruleSql = ` AND (${compiled.where})`;
    ruleParams = compiled.params;
    joins = compiled.joins.map(renderJoin).join(" ");
  }
  // an expanded record is a read like any other: the preview lane applies to it exactly as it does to the list
  const scope = previewScope(c, previewOf(ctx.request));
  if (scope) { ruleSql += ` AND ${scope.sql}`; ruleParams = [...ruleParams, ...scope.params]; }
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const col = `${ident(c.name)}.${ident(backField.name)}`;
    const match = isMultiple(backField)
      ? `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE json_array(${col}) END) WHERE value IN (${chunk.map(() => "?").join(",")}))`
      : `${col} IN (${chunk.map(() => "?").join(",")})`;
    out.push(...(await all(ctx.db, `SELECT DISTINCT ${ident(c.name)}.* FROM ${ident(c.name)} ${joins} WHERE ${match}${ruleSql}`, [...chunk, ...ruleParams])));
  }
  return out;
}
