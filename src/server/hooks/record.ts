// JSVM-compatible Record / Collection wrappers used by hook code ($app, Record, RecordUpsertForm).
import { isMultiple, type Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import { recordToJSON } from "../records/json";
import { fromColumn, normalizeInput, type Upload } from "../records/values";
import type { Row } from "../types";

// Field list with the JSVM helpers generated migrations use (collection.fields.addAt(...), removeById(...)).
export type FieldList = Field[] & {
  add(...fields: Field[]): void; addAt(index: number, ...fields: Field[]): void;
  removeById(id: string): void; removeByName(name: string): void;
  getById(id: string): Field | undefined; getByName(name: string): Field | undefined;
};
export function fieldList(fields: Field[]): FieldList {
  const list = fields as FieldList;
  if (typeof list.addAt === "function") return list;
  Object.defineProperties(list, {
    add: { value(...fs: Field[]) { list.push(...fs); } },
    addAt: { value(index: number, ...fs: Field[]) { list.splice(Math.max(0, Math.min(index, list.length)), 0, ...fs); } },
    removeById: { value(id: string) { const i = list.findIndex((f) => f.id === id); if (i >= 0) list.splice(i, 1); } },
    removeByName: { value(name: string) { const i = list.findIndex((f) => f.name === name); if (i >= 0) list.splice(i, 1); } },
    getById: { value(id: string) { return list.find((f) => f.id === id); } },
    getByName: { value(name: string) { return list.find((f) => f.name === name); } },
  });
  return list;
}

// `new Collection({...})` in hooks and migrations, and what $app.findCollectionByNameOrId returns.
// Property reads and writes fall through to the underlying collection data (unmarshal({...}, collection) works).
export class CollectionRef {
  readonly data: Collection;
  constructor(data: Collection | Record<string, unknown> = {}) {
    const d = { fields: [], indexes: [], ...(data as Record<string, unknown>) } as unknown as Collection;
    d.fields = fieldList([...(d.fields as Field[])].map((f) => ({ ...f })));
    this.data = d;
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        return (target.data as unknown as Record<string | symbol, unknown>)[prop];
      },
      set(target, prop, value) {
        if (prop in target && typeof prop === "string" && !["id", "name", "type", "system", "fields"].includes(prop)) return Reflect.set(target, prop, value);
        (target.data as unknown as Record<string | symbol, unknown>)[prop] = prop === "fields" ? fieldList(value as Field[]) : value;
        return true;
      },
      has(target, prop) { return prop in target || prop in (target.data as object); },
    });
  }
  get id() { return this.data.id; }
  set id(v: string) { this.data.id = v; }
  get name() { return this.data.name; }
  set name(v: string) { this.data.name = v; }
  get type() { return this.data.type; }
  set type(v: string) { (this.data as { type: string }).type = v; }
  get fields(): FieldList { return fieldList(this.data.fields as Field[]); }
  set fields(v: Field[]) { this.data.fields = fieldList(v); }
  get system() { return this.data.system; }
  isAuth() { return this.data.type === "auth"; }
  isView() { return this.data.type === "view"; }
  isBase() { return this.data.type === "base"; }
  // plain JSON for the collections service
  toRaw(): Record<string, unknown> { return JSON.parse(JSON.stringify(this.data)) as Record<string, unknown>; }
}

export class HookRecord {
  values: Record<string, unknown>;
  private originalValues: Record<string, unknown>;
  private hidden = new Set<string>();
  private emailVisible = false;
  uploads: Record<string, Upload[]> = {};
  isNewRecord: boolean;

  constructor(public readonly coll: CollectionRef, data: Record<string, unknown> = {}, opts: { fromRow?: boolean; isNew?: boolean } = {}) {
    this.values = {};
    this.originalValues = {};
    for (const f of this.fields()) {
      this.values[f.name] = opts.fromRow ? fromColumn(f, data[f.name]) : this.empty(f);
      if (f.hidden) this.hidden.add(f.name);
    }
    this.isNewRecord = opts.isNew ?? !opts.fromRow;
    if (opts.fromRow) this.originalValues = { ...this.values };
    if (!opts.fromRow) this.load(data);
    if (opts.fromRow && data.password !== undefined) this.values.password = data.password; // keep the hash for auth checks
  }

  static fromRow(coll: Collection, row: Row) { return new HookRecord(new CollectionRef(coll), row, { fromRow: true }); }

  private fields() { return this.coll.data.fields as Field[]; }
  private empty(f: Field): unknown {
    if (f.type === "bool") return false;
    if (f.type === "number") return 0;
    if (f.type === "json") return null;
    if (f.type === "geoPoint") return { lon: 0, lat: 0 };
    return isMultiple(f) ? [] : "";
  }

  get id() { return String(this.values.id ?? ""); }
  set id(v: string) { this.values.id = v; }
  collection() { return this.coll; }
  isNew() { return this.isNewRecord; }
  original() { const r = new HookRecord(this.coll, {}, { isNew: this.isNewRecord }); r.values = { ...this.originalValues }; r.originalValues = { ...this.originalValues }; return r; }
  fresh() { const r = new HookRecord(this.coll, {}, { isNew: this.isNewRecord }); r.values = { ...this.values }; r.originalValues = { ...this.originalValues }; return r; }
  clone() { return this.fresh(); }
  setOriginal(values: Record<string, unknown>) { this.originalValues = { ...values }; }
  markAsNew() { this.isNewRecord = true; }
  markAsNotNew() { this.isNewRecord = false; }

  load(data: Record<string, unknown>) { for (const [k, v] of Object.entries(data ?? {})) this.set(k, v); }
  get(name: string): unknown { return this.values[name]; }
  set(name: string, value: unknown) {
    const f = this.fields().find((x) => x.name === name);
    if (!f) { this.values[name] = value; return; }
    if (f.type === "file") {
      const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
      const names: string[] = [];
      for (const item of list) {
        if (item && typeof item === "object" && "bytes" in (item as object)) { const up = item as Upload; (this.uploads[name] ??= []).push(up); names.push(up.name); }
        else if (typeof item === "string") names.push(item);
      }
      this.values[name] = isMultiple(f) ? names : (names[names.length - 1] ?? "");
      return;
    }
    if (f.type === "password") { this.values[name] = value == null ? "" : String(value); return; }
    this.values[name] = normalizeInput(f, value);
  }
  getString(name: string) { const v = this.values[name]; return v == null ? "" : Array.isArray(v) ? String(v[0] ?? "") : typeof v === "object" ? JSON.stringify(v) : String(v); }
  getBool(name: string) { return !!this.values[name]; }
  getInt(name: string) { return Math.trunc(Number(this.values[name]) || 0); }
  getFloat(name: string) { return Number(this.values[name]) || 0; }
  getStringSlice(name: string) { const v = this.values[name]; return Array.isArray(v) ? v.map(String) : v ? [String(v)] : []; }
  getDateTime(name: string) { return this.getString(name); }
  getRaw(name: string) { return this.values[name]; }
  email() { return this.getString("email"); }
  verified() { return this.getBool("verified"); }
  tokenKey() { return this.getString("tokenKey"); }
  isSuperuser() { return this.coll.name === "_superusers"; }
  ignoreEmailVisibility(v = true) { this.emailVisible = v; return this; }
  hide(...names: string[]) { for (const n of names) this.hidden.add(n); return this; }
  unhide(...names: string[]) { for (const n of names) this.hidden.delete(n); return this; }
  hiddenFields(): string[] { return [...this.hidden]; }
  expand: Record<string, unknown> | null = null; // set by $apis.enrichRecord / $app.expandRecord
  fieldsData() { return { ...this.values }; }
  // JSON export as the API would return it (email included when visibility is ignored)
  publicExport(): Record<string, unknown> {
    const row: Row = {};
    for (const f of this.fields()) row[f.name] = this.values[f.name];
    const out = recordToJSON(this.coll.data, row, { own: this.emailVisible, expand: this.expand ?? undefined });
    for (const n of this.hidden) delete out[n];
    return out;
  }
  toJSON() { return this.publicExport(); }
}
