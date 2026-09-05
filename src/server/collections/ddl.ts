// SQL generation mirroring PocketBase core/collection_record_table_sync.go.
// Everything returns statement strings; the service runs them in one D1 batch.
import { ident } from "../db";
import { columnType, isMultiple, type Field } from "./fields";
import type { Collection } from "./model";

export interface ParsedIndex {
  unique: boolean;
  optional: boolean;
  name: string;
  table: string;
  columns: string;
  where: string;
  raw: string;
}

// CREATE [UNIQUE] INDEX [IF NOT EXISTS] `name` ON `table` (cols) [WHERE expr]
const INDEX_RE = /^\s*CREATE\s+(UNIQUE\s+)?\s*INDEX\s*(IF\s+NOT\s+EXISTS\s+)?([^\s(]*)\s+ON\s+([^\s(]*)\s*\(([\s\S]*)\)(?:\s*WHERE\s+([\s\S]*))?\s*;?\s*$/i;

export function parseIndex(raw: string): ParsedIndex | null {
  const m = INDEX_RE.exec(raw);
  if (!m) return null;
  const unq = (v: string) => v.trim().replace(/^[`"']|[`"']$/g, "");
  return { unique: !!m[1], optional: !!m[2], name: unq(m[3] ?? ""), table: unq(m[4] ?? ""), columns: (m[5] ?? "").trim(), where: (m[6] ?? "").trim(), raw };
}

// Mirrors dbutils.Index.Build(): backticked names, multi-column bodies on indented lines, COLLATE and sort kept.
export function buildIndex(idx: ParsedIndex, table: string): string {
  const cols = idx.columns.split(",").map((c) => c.trim()).filter(Boolean).map((raw) => {
    const m = /^([\s\S]+?)(?:\s+collate\s+(\w+))?(?:\s+(asc|desc))?$/i.exec(raw);
    const name = (m?.[1] ?? raw).trim().replace(/^[`"']|[`"']$/g, "");
    const quoted = name.includes("(") || name.includes(" ") ? name : "`" + name + "`";
    return quoted + (m?.[2] ? ` COLLATE ${m[2]}` : "") + (m?.[3] ? ` ${m[3].toUpperCase()}` : "");
  });
  let out = `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX ${idx.optional ? "IF NOT EXISTS " : ""}\`${idx.name}\` ON \`${table}\` (`;
  out += cols.length > 1 ? "\n  " + cols.join(",\n  ") + "\n" : cols.join("");
  out += ")";
  if (idx.where) out += ` WHERE ${idx.where}`;
  return out;
}

// Normalize an index expression the way PocketBase stores it: parsed, table name replaced, rebuilt.
export function normalizeIndex(raw: string, table: string): string {
  const idx = parseIndex(raw);
  return idx ? buildIndex(idx, table) : raw;
}

export function createTableSQL(c: Collection): string {
  const cols = (c.fields as Field[]).map((f) => `${ident(f.name)} ${columnType(f)}`);
  return `CREATE TABLE ${ident(c.name)} (${cols.join(", ")})`;
}

export function createIndexesSQL(c: Collection): string[] {
  return c.indexes.map((raw) => {
    const idx = parseIndex(raw);
    if (!idx) throw new Error(`invalid index expression: ${raw}`);
    return buildIndex(idx, c.name);
  });
}

export function dropIndexesSQL(c: Collection): string[] {
  return c.indexes.map((raw) => parseIndex(raw)).filter((i): i is ParsedIndex => !!i && !!i.name).map((i) => `DROP INDEX IF EXISTS ${ident(i.name)}`);
}

export const dropTableSQL = (name: string) => `DROP TABLE IF EXISTS ${ident(name)}`;
export const dropViewSQL = (name: string) => `DROP VIEW IF EXISTS ${ident(name)}`;
export const truncateSQL = (name: string) => `DELETE FROM ${ident(name)}`;
export const createViewSQL = (name: string, query: string) => `CREATE VIEW ${ident(name)} AS ${query.trim().replace(/;\s*$/, "")}`;

let tempCounter = 0;
const temp = (base: string) => `${base}_vb${(++tempCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Statements to bring the table for `oldC` in line with `newC` (fields matched by id, as PocketBase does).
export function syncTableSQL(oldC: Collection, newC: Collection): string[] {
  const out: string[] = [];
  const oldFields = oldC.fields as Field[];
  const newFields = newC.fields as Field[];
  const renameTable = oldC.name.toLowerCase() !== newC.name.toLowerCase();
  const indexesChanged = renameTable || JSON.stringify(oldFields) !== JSON.stringify(newFields) || JSON.stringify(oldC.indexes) !== JSON.stringify(newC.indexes);

  if (indexesChanged) out.push(...dropIndexesSQL(oldC));
  if (renameTable) out.push(`ALTER TABLE ${ident(oldC.name)} RENAME TO ${ident(newC.name)}`);
  const table = newC.name;

  // removed columns
  for (const of of oldFields) {
    if (!newFields.some((f) => f.id === of.id)) out.push(`ALTER TABLE ${ident(table)} DROP COLUMN ${ident(of.name)}`);
  }
  // added + renamed columns, via temp names so swaps cannot collide
  const toRename: Array<[string, string]> = [];
  for (const f of newFields) {
    const of = oldFields.find((x) => x.id === f.id);
    if (!of) {
      const t = temp(f.name);
      toRename.push([t, f.name]);
      out.push(`ALTER TABLE ${ident(table)} ADD COLUMN ${ident(t)} ${columnType(f)}`);
    } else if (of.name !== f.name) {
      const t = temp(f.name);
      toRename.push([t, f.name]);
      out.push(`ALTER TABLE ${ident(table)} RENAME COLUMN ${ident(of.name)} TO ${ident(t)}`);
    }
  }
  for (const [t, name] of toRename) out.push(`ALTER TABLE ${ident(table)} RENAME COLUMN ${ident(t)} TO ${ident(name)}`);

  // single <-> multiple value conversions (select, file, relation)
  for (const f of newFields) {
    const of = oldFields.find((x) => x.id === f.id);
    if (!of || of.type !== f.type) continue;
    const wasMulti = isMultiple(of);
    const isMulti = isMultiple(f);
    if (wasMulti === isMulti) continue;
    const col = ident(f.name);
    const old = temp("_" + f.name);
    out.push(`ALTER TABLE ${ident(table)} RENAME COLUMN ${col} TO ${ident(old)}`);
    out.push(`ALTER TABLE ${ident(table)} ADD COLUMN ${col} ${columnType(f)}`);
    const o = ident(old);
    out.push(
      isMulti
        ? `UPDATE ${ident(table)} SET ${col} = (CASE WHEN COALESCE(${o}, '') = '' THEN '[]' ELSE (CASE WHEN json_valid(${o}) AND json_type(${o}) = 'array' THEN ${o} ELSE json_array(${o}) END) END)`
        : `UPDATE ${ident(table)} SET ${col} = (CASE WHEN COALESCE(${o}, '[]') = '[]' THEN '' ELSE (CASE WHEN json_valid(${o}) AND json_type(${o}) = 'array' THEN COALESCE(json_extract(${o}, '$[#-1]'), '') ELSE ${o} END) END)`,
    );
    out.push(`ALTER TABLE ${ident(table)} DROP COLUMN ${o}`);
  }

  if (indexesChanged) out.push(...createIndexesSQL(newC));
  return out;
}
