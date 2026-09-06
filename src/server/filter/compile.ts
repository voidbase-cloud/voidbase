// Compiles PocketBase filter/rule expressions to SQLite SQL, mirroring tools/search/filter.go and
// core/record_field_resolver*.go: relation joins, back-relations, json paths, :each/:length/:lower,
// @request.*, @collection.*, datetime macros, geoDistance, multi-match ("all values") semantics.
import { isMultiple, type Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import { ident } from "../db";
import { nowString } from "../ids";
import type { Sign, Token } from "./lexer";
import { parseFilter, type Expr } from "./parser";

export class FilterError extends Error {}

export interface AuthInfo {
  collection: Collection;
  row: Record<string, unknown>; // raw table row (hidden fields included)
}

export interface RequestInfo {
  auth: AuthInfo | null;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>; // lowercase keys, "-" replaced by "_"
  body: Record<string, unknown>;
  context: string; // default | oauth2 | otp | password | realtime | protectedFile | expand | batch
}

export interface CompileOptions {
  base: Collection;
  baseTable?: string; // table or CTE name to select from (defaults to the collection name)
  collections: Map<string, Collection>; // by id and by name
  request: RequestInfo | null;
  allowHiddenFields: boolean;
  aliasSuffix?: string;
}

export interface Join {
  table: string; // table name or json_each(...) expression
  alias: string;
  on: string; // may reference {P} for the parent alias and {A} for this alias
  params: unknown[];
  multi: boolean; // the join can yield several rows per base row
}

interface Resolved {
  sql: string;
  params: unknown[];
  nullFallback?: "auto" | "disabled" | "enforced";
  joins: Join[];
  multiValue?: { valueSql: string; joins: Join[]; params: unknown[] }; // for "all values must match" checks
}

export interface Compiled {
  where: string;
  params: unknown[];
  joins: Join[];
}

const MACROS: Record<string, () => unknown> = {
  "@now": () => nowString(),
  "@yesterday": () => nowString(new Date(Date.now() - 86400000)),
  "@tomorrow": () => nowString(new Date(Date.now() + 86400000)),
  "@second": () => new Date().getUTCSeconds(),
  "@minute": () => new Date().getUTCMinutes(),
  "@hour": () => new Date().getUTCHours(),
  "@day": () => new Date().getUTCDate(),
  "@month": () => new Date().getUTCMonth() + 1,
  "@weekday": () => new Date().getUTCDay(),
  "@year": () => new Date().getUTCFullYear(),
  "@todayStart": () => nowString(new Date()).slice(0, 10) + " 00:00:00.000Z",
  "@todayEnd": () => nowString(new Date()).slice(0, 10) + " 23:59:59.999Z",
  "@monthStart": () => nowString(new Date()).slice(0, 7) + "-01 00:00:00.000Z",
  "@monthEnd": () => { const d = new Date(); return nowString(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))).slice(0, 10) + " 23:59:59.999Z"; },
  "@yearStart": () => nowString(new Date()).slice(0, 4) + "-01-01 00:00:00.000Z",
  "@yearEnd": () => nowString(new Date()).slice(0, 4) + "-12-31 23:59:59.999Z",
};

const REQUEST_AUTH_STATIC = new Set(["id", "collectionId", "collectionName", "email", "emailVisibility", "verified"]);

export const jsonEach = (col: string) =>
  `json_each(CASE WHEN iif(json_valid(${col}), json_type(${col})='array', FALSE) THEN ${col} ELSE json_array(${col}) END)`;
export const jsonArrayLength = (col: string) =>
  `json_array_length(CASE WHEN iif(json_valid(${col}), json_type(${col})='array', FALSE) THEN ${col} ELSE (CASE WHEN ${col} = '' OR ${col} IS NULL THEN json_array() ELSE json_array(${col}) END) END)`;
export function jsonExtract(col: string, path: string): string {
  const p = path && !path.startsWith("[") ? "." + path : path;
  return `(CASE WHEN json_valid(${col}) THEN JSON_EXTRACT(${col}, '$${p}') ELSE JSON_EXTRACT(json_object('pb', ${col}), '$.pb${p}') END)`;
}

const isArrayable = (f: Field) => f.type === "select" || f.type === "file" || f.type === "relation";
const col = (alias: string, name: string) => `${ident(alias)}.${ident(name)}`;
let seq = 0;
const uniq = () => (++seq).toString(36);

export function compileFilter(filter: string, opts: CompileOptions): Compiled {
  const ast = parseFilter(filter);
  const c = new Compiler(opts);
  const out = c.group(ast);
  return { where: out.sql, params: out.params, joins: c.joins };
}

// Sort: plain fields, @rowid, @random (relation-path sorting lands with the records milestone polish).
export function compileSort(sort: string, base: Collection, allowHidden: boolean): string {
  if (!sort.trim()) return "";
  const parts: string[] = [];
  for (const raw of sort.split(",")) {
    const s = raw.trim();
    if (!s) continue;
    const desc = s.startsWith("-");
    const name = s.replace(/^[+-]/, "");
    if (name === "@rowid") parts.push(`${ident(base.name)}.${base.type === "view" ? "id" : "rowid"} ${desc ? "DESC" : "ASC"}`);
    else if (name === "@random") parts.push("RANDOM()");
    else {
      const f = (base.fields as Field[]).find((x) => x.name === name);
      if (!f || (f.hidden && !allowHidden)) throw new FilterError(`invalid sort field "${name}"`);
      parts.push(`${col(base.name, f.name)} ${desc ? "DESC" : "ASC"}`);
    }
  }
  return parts.length ? `ORDER BY ${parts.join(", ")}` : "";
}

class Compiler {
  joins: Join[] = [];
  private baseAlias: string;
  constructor(private o: CompileOptions) {
    this.baseAlias = o.baseTable ?? o.base.name;
  }

  group(e: Expr): { sql: string; params: unknown[] } {
    if (e.kind === "cmp") return this.cmp(e.op, e.left, e.right);
    // PocketBase folds left to right: ((a && b) || c)
    let sql = "";
    const params: unknown[] = [];
    e.items.forEach((item, i) => {
      const r = this.group(item.expr);
      const part = item.expr.kind === "group" ? `(${r.sql})` : r.sql;
      sql = i === 0 ? part : `(${sql} ${item.join === "&&" ? "AND" : "OR"} ${part})`;
      params.push(...r.params);
    });
    return { sql, params };
  }

  private addJoin(j: Join) {
    if (!this.joins.some((x) => x.alias === j.alias)) this.joins.push(j);
  }

  cmp(op: Sign, leftTok: Token, rightTok: Token): { sql: string; params: unknown[] } {
    // tools/search/filter.go wraps resolver failures with the operand they came from
    const operand = (side: "left" | "right", tok: Token): Resolved => {
      try { return this.resolve(tok); } catch (e) { throw e instanceof FilterError ? new FilterError(`invalid ${side} operand "${tok.literal}" - ${e.message}`) : e; }
    };
    const left = operand("left", leftTok);
    const right = operand("right", rightTok);
    for (const j of [...left.joins, ...right.joins]) this.addJoin(j);
    const base = buildCmp(op, left.sql, left, right.sql, right);
    const params = [...base.params];
    let sql = base.sql;
    const any = op.startsWith("?");
    if (!any) {
      // "all values must match": no row of the multi-valued side may fail the comparison
      for (const [side, other, otherSql] of [[left, right, right.sql], [right, left, left.sql]] as const) {
        if (!side.multiValue) continue;
        const inner = side === left ? buildCmp(op, side.multiValue.valueSql, side, otherSql, other) : buildCmp(op, otherSql, other, side.multiValue.valueSql, side);
        const mmJoins = side.multiValue.joins.map((j) => renderJoin(j)).join(" ");
        sql = `(${sql} AND NOT EXISTS (SELECT 1 FROM ${ident(this.baseAlias)} AS ${ident("__mm_" + this.baseAlias)} ${mmJoins} WHERE ${col("__mm_" + this.baseAlias, "id")} = ${col(this.baseAlias, "id")} AND NOT (${inner.sql})))`;
        params.push(...side.multiValue.params, ...inner.params);
      }
    }
    return { sql, params };
  }

  resolve(t: Token): Resolved {
    switch (t.type) {
      case "text":
        return { sql: "?", params: [t.literal], nullFallback: "auto", joins: [] };
      case "number":
        return { sql: "?", params: [Number(t.literal)], nullFallback: "auto", joins: [] };
      case "function":
        return this.func(t);
      case "identifier":
        return this.identifier(t.literal);
      default:
        throw new FilterError(`unexpected token ${t.literal}`);
    }
  }

  private func(t: Token): Resolved {
    if (t.literal !== "geoDistance") throw new FilterError(`unknown function "${t.literal}"`);
    const args = (t.meta ?? []).map((a) => this.resolve(a));
    if (args.length !== 4) throw new FilterError("geoDistance expects 4 arguments");
    const [lonA, latA, lonB, latB] = args as [Resolved, Resolved, Resolved, Resolved];
    const sql = `(6371 * acos(cos(radians(${latA.sql})) * cos(radians(${latB.sql})) * cos(radians(${lonB.sql}) - radians(${lonA.sql})) + sin(radians(${latA.sql})) * sin(radians(${latB.sql}))))`;
    return { sql, params: [...latA.params, ...latB.params, ...lonB.params, ...lonA.params, ...latA.params, ...latB.params], nullFallback: "disabled", joins: args.flatMap((a) => a.joins) };
  }

  private identifier(name: string): Resolved {
    const lower = name.toLowerCase();
    if (lower === "null") return { sql: "NULL", params: [], joins: [] };
    if (lower === "true") return { sql: "1", params: [], joins: [] };
    if (lower === "false") return { sql: "0", params: [], joins: [] };
    if (MACROS[name]) return { sql: "?", params: [MACROS[name]!()], nullFallback: "auto", joins: [] };
    if (name.startsWith("@request.")) return this.request(name);
    if (name.startsWith("@collection.")) return this.collectionRef(name);
    if (name.startsWith("@")) throw new FilterError(`unknown identifier "${name}"`);
    return this.path(this.o.base, this.baseAlias, name.split("."), false);
  }

  private request(name: string): Resolved {
    const req = this.o.request;
    const parts = name.split(".");
    const kind = parts[1];
    if (kind === "method") return { sql: "?", params: [req?.method ?? ""], nullFallback: "auto", joins: [] };
    if (kind === "context") return { sql: "?", params: [req?.context ?? "default"], nullFallback: "auto", joins: [] };
    if (kind === "query" || kind === "headers") {
      const key = parts.slice(2).join(".");
      const v = kind === "query" ? req?.query[key] : req?.headers[key.toLowerCase().replace(/-/g, "_")];
      return v === undefined ? { sql: "NULL", params: [], joins: [] } : { sql: "?", params: [v], nullFallback: "auto", joins: [] };
    }
    if (kind === "body") return this.requestBody(parts.slice(2).join("."));
    if (kind === "auth") return this.requestAuth(parts.slice(2));
    throw new FilterError(`unknown identifier "${name}"`);
  }

  private requestBody(rest: string): Resolved {
    const [field, modifier] = rest.split(":") as [string, string | undefined];
    const body = this.o.request?.body ?? {};
    const has = field in body;
    if (modifier === "isset") return { sql: has ? "1" : "0", params: [], joins: [] };
    const v = body[field];
    if (modifier === "length") {
      const arr = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
      return { sql: "?", params: [arr.length], nullFallback: "auto", joins: [] };
    }
    if (modifier === "each") {
      const arr = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
      const alias = `__je_body_${field}_${uniq()}`;
      const join: Join = { table: `json_each(?)`, alias, on: "1=1", params: [JSON.stringify(arr)], multi: true };
      return { sql: col(alias, "value"), params: [], nullFallback: "auto", joins: [join], multiValue: { valueSql: col(alias, "value"), joins: [join], params: [] } };
    }
    if (modifier === "lower") return { sql: "LOWER(?)", params: [v == null ? "" : String(v)], nullFallback: "auto", joins: [] };
    if (v === undefined || v === null) return { sql: "NULL", params: [], joins: [] };
    if (typeof v === "object") return { sql: "?", params: [JSON.stringify(v)], nullFallback: "auto", joins: [] };
    return { sql: "?", params: [typeof v === "boolean" ? (v ? 1 : 0) : v], nullFallback: "auto", joins: [] };
  }

  private requestAuth(parts: string[]): Resolved {
    const auth = this.o.request?.auth;
    if (!auth) return { sql: "NULL", params: [], joins: [] };
    const [first] = parts;
    if (parts.length === 1 && first) {
      const [field, modifier] = first.split(":") as [string, string | undefined];
      let v: unknown;
      if (field === "collectionId") v = auth.collection.id;
      else if (field === "collectionName") v = auth.collection.name;
      else {
        const f = (auth.collection.fields as Field[]).find((x) => x.name === field);
        if (!f && !REQUEST_AUTH_STATIC.has(field)) throw new FilterError(`unknown @request.auth field "${field}"`);
        v = auth.row[field];
        if (f && isMultiple(f) && typeof v === "string") { try { v = JSON.parse(v); } catch { v = [v]; } }
        if (f?.type === "bool") v = v ? 1 : 0;
      }
      if (modifier === "lower") return { sql: "LOWER(?)", params: [v == null ? "" : String(v)], nullFallback: "auto", joins: [] };
      if (modifier === "length") return { sql: "?", params: [Array.isArray(v) ? v.length : v ? 1 : 0], nullFallback: "auto", joins: [] };
      if (v === undefined || v === null) return { sql: "NULL", params: [], joins: [] };
      return { sql: "?", params: [typeof v === "object" ? JSON.stringify(v) : v], nullFallback: "auto", joins: [] };
    }
    // nested: join the auth collection on the authenticated id, then walk the path
    const alias = `__auth_${auth.collection.name}`;
    const join: Join = { table: auth.collection.name, alias, on: `${col(alias, "id")} = ?`, params: [String(auth.row.id)], multi: false };
    const res = this.path(auth.collection, alias, parts, true);
    return { ...res, joins: [join, ...res.joins] };
  }

  private collectionRef(name: string): Resolved {
    // @collection.NAME[:alias].field.path
    const parts = name.split(".");
    const [collName, aliasName] = (parts[1] ?? "").split(":") as [string, string | undefined];
    const collection = this.o.collections.get(collName);
    if (!collection) throw new FilterError(`failed to load collection "${collName}" from field path "${name}"`);
    const alias = `__collection_${aliasName ?? collName}`;
    const join: Join = { table: collection.name, alias, on: "1=1", params: [], multi: true };
    const res = this.path(collection, alias, parts.slice(2), true);
    const joins = [join, ...res.joins];
    return { ...res, joins, multiValue: { valueSql: res.sql, joins, params: [] } };
  }

  // Walk field.path[.path] from `collection` (aliased `alias`); relation segments add LEFT JOINs.
  private path(collection: Collection, alias: string, parts: string[], allowHidden: boolean): Resolved {
    const joins: Join[] = [];
    let multi = false;
    let cur = collection;
    let curAlias = alias;
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]!;
      const isLast = i === parts.length - 1;
      const [prop, rawModifier] = raw.split(":") as [string, string | undefined];
      let modifier = rawModifier;
      const fields = cur.fields as Field[];
      const field = fields.find((f) => f.name === prop);
      if (field && field.hidden && !this.o.allowHiddenFields && !allowHidden) throw new FilterError(`unknown field "${prop}"`);

      // back-relation: otherCollection_via_relField
      const via = /^(\w+)_via_(\w+)$/.exec(prop);
      if (!field && via && !isLast) {
        // record_field_resolver_runner.go back-relation checks, in PocketBase's order and wording
        const other = this.o.collections.get(via[1]!);
        if (!other) throw new FilterError(`failed to load back relation field "${prop}" collection`);
        const backField = (other.fields as Field[]).find((f) => f.name === via[2]);
        if (!backField) throw new FilterError(`missing back relation field "${via[2]}"`);
        if (backField.type !== "relation") throw new FilterError(`invalid back relation field "${via[2]}"`);
        if (backField.hidden && !this.o.allowHiddenFields) throw new FilterError(`non-filterable back relation field "${backField.name}"`);
        if (backField.collectionId !== cur.id) throw new FilterError(`invalid collection reference of a back relation field "${backField.name}"`);
        const relField = backField;
        const newAlias = `${curAlias}_${prop}`;
        const on = isMultiple(relField)
          ? `${col(curAlias, "id")} IN (SELECT value FROM ${jsonEach(col(newAlias, relField.name))})`
          : `${col(newAlias, relField.name)} = ${col(curAlias, "id")}`;
        const hasUnique = cur.indexes.some(() => false); // uniqueness of the back field is not tracked here
        joins.push({ table: other.name, alias: newAlias, on, params: [], multi: true });
        multi = multi || !hasUnique;
        cur = other;
        curAlias = newAlias;
        continue;
      }
      if (!field) throw new FilterError(`unknown field "${prop}"`);

      if (!isLast) {
        if (field.type === "relation") {
          const rel = this.o.collections.get(String(field.collectionId));
          if (!rel) throw new FilterError(`missing relation collection for "${prop}"`);
          const newAlias = `${curAlias}_${prop}`;
          const on = isMultiple(field)
            ? `${col(newAlias, "id")} IN (SELECT value FROM ${jsonEach(col(curAlias, prop))})`
            : `${col(newAlias, "id")} = ${col(curAlias, prop)}`;
          joins.push({ table: rel.name, alias: newAlias, on, params: [], multi: isMultiple(field) });
          multi = multi || isMultiple(field);
          cur = rel;
          curAlias = newAlias;
          continue;
        }
        if (field.type === "json" || field.type === "geoPoint") {
          const jsonPath = parts.slice(i + 1).join(".");
          const sql = jsonExtract(col(curAlias, prop), jsonPath);
          return { sql, params: [], nullFallback: "auto", joins, multiValue: multi ? { valueSql: sql, joins, params: [] } : undefined };
        }
        throw new FilterError(`invalid path "${parts.join(".")}"`);
      }

      // last segment
      const c = col(curAlias, prop);
      if (modifier === "length" && !isArrayable(field)) modifier = ""; // PocketBase ignores :length on single-value fields
      if (modifier === "length") {
        const sql = jsonArrayLength(c);
        return { sql, params: [], nullFallback: "auto", joins, multiValue: multi ? { valueSql: sql, joins, params: [] } : undefined };
      }
      if (modifier === "each") {
        if (!isArrayable(field)) throw new FilterError(`":each" modifier is not supported on "${prop}"`);
        const je = `__je_${curAlias}_${prop}`;
        joins.push({ table: jsonEach(c), alias: je, on: "1=1", params: [], multi: true });
        const sql = col(je, "value");
        return { sql, params: [], nullFallback: "auto", joins, multiValue: { valueSql: sql, joins, params: [] } };
      }
      let sql = c;
      if (modifier === "lower") sql = `LOWER(${c})`;
      else if (modifier) throw new FilterError(`unknown modifier ":${modifier}"`);
      else if (field.type === "json") sql = jsonExtract(c, "");
      return { sql, params: [], nullFallback: "auto", joins, multiValue: multi ? { valueSql: sql, joins, params: [] } : undefined };
    }
    throw new FilterError("empty field path");
  }
}

export function renderJoin(j: Join): string {
  const table = j.table.startsWith("json_each(") ? j.table : ident(j.table);
  return `LEFT JOIN ${table} AS ${ident(j.alias)} ON ${j.on}`;
}

// Operators mirror buildResolversExpr + resolveEqualExpr in tools/search/filter.go.
function buildCmp(op: Sign, leftSql: string, left: Resolved, rightSql: string, right: Resolved): { sql: string; params: unknown[] } {
  const bare = op.replace("?", "") as Sign;
  switch (bare) {
    case "=": case "!=": {
      const e = equal(bare === "=", leftSql, left, rightSql, right);
      const lp = e.useLeft ? (e.dupLeft ? [...left.params, ...left.params] : left.params) : [];
      const rp = e.useRight ? (e.dupRight ? [...right.params, ...right.params] : right.params) : [];
      return { sql: e.sql, params: [...lp, ...rp] };
    }
    case "~": case "!~": {
      const not = bare === "!~" ? "NOT " : "";
      if (right.params.length === 0) return { sql: `${leftSql} ${not}LIKE ('%' || ${rightSql} || '%') ESCAPE '\\'`, params: [...left.params] };
      return { sql: `${leftSql} ${not}LIKE ${rightSql} ESCAPE '\\'`, params: [...left.params, ...right.params.map(wrapLike)] };
    }
    case "<": case "<=": case ">": case ">=":
      return { sql: `${leftSql} ${bare} ${rightSql}`, params: [...left.params, ...right.params] };
    default:
      throw new FilterError(`unknown operator ${op}`);
  }
}

function equal(eq: boolean, l: string, left: Resolved, r: string, right: Resolved): { sql: string; useLeft: boolean; useRight: boolean; dupLeft?: boolean; dupRight?: boolean } {
  const eqOp = eq ? "=" : "IS NOT";
  const nullEqOp = eq ? "IS" : "IS NOT";
  const concat = eq ? "OR" : "AND";
  const nullExpr = eq ? "IS NULL" : "IS NOT NULL";
  if (left.nullFallback === "disabled" || right.nullFallback === "disabled") return { sql: `${l} ${nullEqOp} ${r}`, useLeft: true, useRight: true };
  const isEmptyIdent = (s: string) => ["", "null", "''", '""'].includes(s.toLowerCase());
  const isEmptyParam = (x: Resolved) => x.nullFallback === "auto" && x.params.length === 1 && (x.params[0] === "" || x.params[0] === null);
  const leftEmpty = isEmptyIdent(l) || isEmptyParam(left);
  const rightEmpty = isEmptyIdent(r) || isEmptyParam(right);
  if (leftEmpty && rightEmpty) return { sql: `'' ${eqOp} ''`, useLeft: false, useRight: false };
  const known = (s: string, x: Resolved) => x.nullFallback !== "enforced" && ["1", "0", "true", "false"].includes(s.toLowerCase());
  if (known(l, left) || known(r, right)) return { sql: `${leftEmpty ? "''" : l} ${eqOp} ${rightEmpty ? "''" : r}`, useLeft: !leftEmpty, useRight: !rightEmpty };
  if (leftEmpty) return { sql: `('' ${eqOp} ${r} ${concat} ${r} ${nullExpr})`, useLeft: false, useRight: true, dupRight: true };
  if (rightEmpty) return { sql: `(${l} ${eqOp} '' ${concat} ${l} ${nullExpr})`, useLeft: true, useRight: false, dupLeft: true };
  return { sql: `COALESCE(${l}, '') ${eqOp} COALESCE(${r}, '')`, useLeft: true, useRight: true };
}

function wrapLike(v: unknown): string {
  const s = String(v);
  if (/(^|[^\\])%/.test(s)) return s;
  return "%" + s.replace(/([\\%_])/g, "\\$1") + "%";
}
