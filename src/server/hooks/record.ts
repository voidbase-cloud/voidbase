// JSVM-compatible Record / Collection wrappers used by hook code ($app, Record, RecordUpsertForm).
import { isMultiple, type Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import { recordToJSON } from "../records/json";
import { fromColumn, normalizeInput, type Upload } from "../records/values";
import type { Row } from "../types";

export class CollectionRef {
  constructor(public readonly data: Collection) {}
  get id() { return this.data.id; }
  get name() { return this.data.name; }
  get type() { return this.data.type; }
  get fields() { return this.data.fields; }
  get system() { return this.data.system; }
  isAuth() { return this.data.type === "auth"; }
  isView() { return this.data.type === "view"; }
  isBase() { return this.data.type === "base"; }
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
  fieldsData() { return { ...this.values }; }
  // JSON export as the API would return it (email included when visibility is ignored)
  publicExport(): Record<string, unknown> {
    const row: Row = {};
    for (const f of this.fields()) row[f.name] = this.values[f.name];
    const out = recordToJSON(this.coll.data, row, { own: this.emailVisible });
    for (const n of this.hidden) delete out[n];
    return out;
  }
  toJSON() { return this.publicExport(); }
}
