// The JSVM-compatible global API for pb_hooks files, plus the registries their calls populate.
// Per-request state ($app's database, the request) is carried by AsyncLocalStorage.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import type { Collection } from "../collections/model";
import { ApiError } from "../errors";
import { normalizeFilename, sniffMime } from "../records/files";
import type { RecordContext } from "../records/service";
import type { Upload } from "../records/values";
import type { Settings } from "../settings";
import type { AppEnv, AuthRecord } from "../types";
import { CollectionRef, HookRecord } from "./record";

export interface HookStore {
  c: Context<AppEnv> | null;
  ctx: () => Promise<RecordContext>;
  collections: Map<string, Collection>;
  settings: Settings;
  env: Record<string, unknown>;
}
export const hookStore = new AsyncLocalStorage<HookStore>();
const store = () => hookStore.getStore();
const mustStore = () => { const s = store(); if (!s) throw new Error("hooks: no request context"); return s; };

// ---- registries ------------------------------------------------------------------------------------
export interface RouteReg { method: string; path: string; handler: HookFn; middlewares: HookMiddleware[] }
export type HookFn = (e: unknown) => unknown;
export type HookMiddleware = HookFn | { func: HookFn; id?: string; priority?: number };
export const routes: RouteReg[] = [];
export const eventHooks = new Map<string, { fn: HookFn; tags: string[] }[]>();
export const crons = new Map<string, { expr: string; fn: () => unknown }>();

export function onEvent(name: string, fn: HookFn, tags: string[]) {
  const list = eventHooks.get(name) ?? [];
  list.push({ fn, tags });
  eventHooks.set(name, list);
}

// Runs the handlers for an event as a chain around `inner` (the core action). e.next() runs the rest once.
export const hasHandlers = (name: string, tag: string | null) => (eventHooks.get(name) ?? []).some((h) => h.tags.length === 0 || (tag !== null && h.tags.includes(tag)));

export async function trigger<T extends { next?: () => Promise<unknown> }>(name: string, e: T, tag: string | null, inner: () => Promise<unknown>): Promise<unknown> {
  const handlers = (eventHooks.get(name) ?? []).filter((h) => h.tags.length === 0 || (tag !== null && h.tags.includes(tag)));
  if (handlers.length === 0) return inner();
  let i = 0;
  let result: unknown;
  let innerDone = false;
  const next = async () => {
    if (i < handlers.length) { const h = handlers[i++]!; return h.fn(e); }
    if (!innerDone) { innerDone = true; result = await inner(); }
    return result;
  };
  (e as { next: () => Promise<unknown> }).next = next;
  await next();
  if (!innerDone) { innerDone = true; result = await inner(); } // handlers that never call next() still run the core action
  return result;
}

// ---- errors (JSVM names) -----------------------------------------------------------------------------
export class HookApiError extends ApiError {}
export class NotFoundError extends ApiError { constructor(message = "The requested resource wasn't found.", data?: Record<string, unknown>) { super(404, message, data ?? {}); } }
export class BadRequestError extends ApiError { constructor(message = "Something went wrong while processing your request.", data?: Record<string, unknown>) { super(400, message, data ?? {}); } }
export class ForbiddenError extends ApiError { constructor(message = "You are not allowed to perform this request.", data?: Record<string, unknown>) { super(403, message, data ?? {}); } }
export class UnauthorizedError extends ApiError { constructor(message = "Missing or invalid authentication.", data?: Record<string, unknown>) { super(401, message, data ?? {}); } }
export class InternalServerError extends ApiError { constructor(message = "Something went wrong while processing your request.", data?: Record<string, unknown>) { super(500, message, data ?? {}); } }
export class ValidationError extends Error { constructor(public code: string, message: string) { super(message); } }

// ---- request event (the `c` / `e` object handlers receive) ------------------------------------------
export class RequestEvent {
  private storeMap = new Map<string, unknown>();
  written: Response | null = null; // PocketBase handlers write the response (e.JSON) rather than return it
  next: () => Promise<unknown> = async () => undefined;
  record: HookRecord | null = null;
  collection: CollectionRef | null = null;
  constructor(public c: Context<AppEnv>, public auth: HookRecord | null) {}
  get request() { return this.c.req.raw; }
  get app() { return $app; }
  get response() { return this.c.res; }
  // goja values cross into Go maps, which marshal with sorted keys
  json(status: number, data: unknown) { return (this.written = this.c.json(sortKeysDeep(data) as Record<string, unknown>, status as 200)); }
  string(status: number, data: string) { return (this.written = this.c.text(data, status as 200)); }
  html(status: number, data: string) { return (this.written = this.c.html(data, status as 200)); }
  noContent(status = 204) { return (this.written = this.c.body(null, status as 204)); }
  redirect(status: number, url: string) { return (this.written = this.c.redirect(url, status as 302)); }
  get(key: string) { return this.storeMap.get(key); }
  set(key: string, value: unknown) { this.storeMap.set(key, value); }
  pathParam(name: string) { return this.c.req.param(name) ?? ""; }
  queryParam(name: string) { return this.c.req.query(name) ?? ""; }
  hasSuperuserAuth() { return !!this.auth?.isSuperuser(); }
  realIP() { return this.c.req.header("CF-Connecting-IP") ?? this.c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? ""; }
  async requestInfo() {
    const query: Record<string, string> = {}; new URL(this.c.req.url).searchParams.forEach((v, k) => { query[k] = v; });
    const headers: Record<string, string> = {}; this.c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase().replace(/-/g, "_")] = v; });
    return { method: this.c.req.method, query, headers, body: await this.bindBody({}), auth: this.auth, context: "default", hasSuperuserAuth: () => this.hasSuperuserAuth() };
  }
  async bindBody(target: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ct = this.c.req.header("content-type") ?? "";
    let data: Record<string, unknown> = {};
    try {
      if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) data = (await this.c.req.parseBody({ all: true })) as Record<string, unknown>;
      else { const t = await this.c.req.text(); data = t.trim() ? JSON.parse(t) : {}; }
    } catch { data = {}; }
    Object.assign(target, data);
    return target;
  }
}

// ---- $app ---------------------------------------------------------------------------------------------
export interface AppServices {
  saveCollection(ref: CollectionRef): Promise<CollectionRef>;
  deleteCollection(ref: CollectionRef): Promise<void>;
  saveRecord: (rec: HookRecord) => Promise<HookRecord>;
  deleteRecord: (rec: HookRecord) => Promise<void>;
  findRecordById: (collection: string, id: string) => Promise<HookRecord | null>;
  findRecordsByFilter: (collection: string, filter: string, sort: string, limit: number, offset: number, params?: Record<string, unknown>) => Promise<HookRecord[]>;
  countRecords: (collection: string, where: DbxExpr | string | null) => Promise<number>;
  findAuthRecordByEmail: (collection: string, email: string) => Promise<HookRecord | null>;
  findAuthRecordByToken: (token: string, type: string) => Promise<HookRecord | null>;
  expandRecords: (records: HookRecord[], expands: string[]) => Promise<void>;
  sendMail: (msg: MailerMessage) => Promise<void>;
}
// $dbx: the small subset generated hooks use ($dbx.exp("col = {:v}", {v}), $dbx.hashExp({col: v}))
export interface DbxExpr { sql: string; params: Record<string, unknown> }
export const $dbx = {
  exp: (sql: string, params: Record<string, unknown> = {}): DbxExpr => ({ sql, params }),
  hashExp: (pairs: Record<string, unknown>): DbxExpr => ({ sql: Object.keys(pairs).map((k) => `[[${k}]] = {:${k}}`).join(" AND "), params: { ...pairs } }),
};
let services: AppServices | null = null;
export function installServices(s: AppServices) { services = s; }
const svc = () => { if (!services) throw new Error("hooks: services not installed"); return services; };

export interface AppApi {
  findCollectionByNameOrId(idOrName: string): CollectionRef;
  findAllCollections(...types: string[]): CollectionRef[];
  findRecordById(collection: string | CollectionRef, id: string): Promise<HookRecord | null>;
  findRecordsByFilter(collection: string | CollectionRef, filter: string, sort?: string, limit?: number, offset?: number, params?: Record<string, unknown>): Promise<HookRecord[]>;
  findFirstRecordByFilter(collection: string | CollectionRef, filter: string, params?: Record<string, unknown>): Promise<HookRecord>;
  findFirstRecordByData(collection: string | CollectionRef, key: string, value: unknown): Promise<HookRecord>;
  countRecords(collection: string | CollectionRef, ...exprs: (DbxExpr | string)[]): Promise<number>;
  findAuthRecordByEmail(collection: string | CollectionRef, email: string): Promise<HookRecord>;
  findAuthRecordByToken(token: string, type?: string): Promise<HookRecord>;
  expandRecord(record: HookRecord, expands: string[], fetch?: unknown): Promise<void>;
  expandRecords(records: HookRecord[], expands: string[], fetch?: unknown): Promise<void>;
  save(model: HookRecord | CollectionRef): Promise<HookRecord | CollectionRef>;
  saveNoValidate(model: HookRecord | CollectionRef): Promise<HookRecord | CollectionRef>;
  delete(model: HookRecord | CollectionRef): Promise<void>;
  settings(): Settings;
  newMailClient(): { send: (msg: MailerMessage) => Promise<void> };
  logger(): Console;
  dao(): AppApi;
  isDev(): boolean;
  runInTransaction(fn: (txApp: AppApi) => unknown): Promise<unknown>;
}

export const $app: AppApi = {
  findCollectionByNameOrId(idOrName: string): CollectionRef {
    const c = mustStore().collections.get(idOrName);
    if (!c) throw new Error(`sql: no rows in result set (collection "${idOrName}")`);
    return new CollectionRef(c);
  },
  findAllCollections(...types: string[]): CollectionRef[] {
    const seen = new Set<string>(); const out: CollectionRef[] = [];
    for (const c of mustStore().collections.values()) { if (seen.has(c.id)) continue; seen.add(c.id); if (!types.length || types.includes(c.type)) out.push(new CollectionRef(c)); }
    return out;
  },
  findRecordById: (collection: string | CollectionRef, id: string) => svc().findRecordById(typeof collection === "string" ? collection : collection.name, id),
  findRecordsByFilter: (collection: string | CollectionRef, filter: string, sort = "", limit = 0, offset = 0, params?: Record<string, unknown>) => svc().findRecordsByFilter(typeof collection === "string" ? collection : collection.name, filter, sort, limit, offset, params),
  async findFirstRecordByFilter(collection: string | CollectionRef, filter: string, params?: Record<string, unknown>) {
    const rows = await svc().findRecordsByFilter(typeof collection === "string" ? collection : collection.name, filter, "", 1, 0, params);
    if (!rows[0]) throw new Error("sql: no rows in result set");
    return rows[0];
  },
  async findFirstRecordByData(collection: string | CollectionRef, key: string, value: unknown) {
    const rows = await svc().findRecordsByFilter(typeof collection === "string" ? collection : collection.name, `${key} = {:v}`, "", 1, 0, { v: value });
    if (!rows[0]) throw new Error("sql: no rows in result set");
    return rows[0];
  },
  countRecords: (collection: string | CollectionRef, ...exprs: (DbxExpr | string)[]) => svc().countRecords(typeof collection === "string" ? collection : collection.name, exprs.length ? (exprs.length === 1 ? exprs[0]! : { sql: exprs.map((x) => `(${typeof x === "string" ? x : x.sql})`).join(" AND "), params: Object.assign({}, ...exprs.map((x) => (typeof x === "string" ? {} : x.params))) }) : null),
  async findAuthRecordByEmail(collection: string | CollectionRef, email: string) {
    const rec = await svc().findAuthRecordByEmail(typeof collection === "string" ? collection : collection.name, email);
    if (!rec) throw new Error("sql: no rows in result set");
    return rec;
  },
  async findAuthRecordByToken(token: string, type = "auth") {
    const rec = await svc().findAuthRecordByToken(token, type);
    if (!rec) throw new Error("sql: no rows in result set");
    return rec;
  },
  expandRecord: (record: HookRecord, expands: string[]) => svc().expandRecords([record], expands),
  expandRecords: (records: HookRecord[], expands: string[]) => svc().expandRecords(records, expands),
  save: (model: HookRecord | CollectionRef) => (model instanceof CollectionRef ? svc().saveCollection(model) : svc().saveRecord(model)),
  saveNoValidate: (model: HookRecord | CollectionRef) => (model instanceof CollectionRef ? svc().saveCollection(model) : svc().saveRecord(model)),
  delete: (model: HookRecord | CollectionRef) => (model instanceof CollectionRef ? svc().deleteCollection(model) : svc().deleteRecord(model)),
  settings() { return mustStore().settings; },
  newMailClient() { return { send: (msg: MailerMessage) => svc().sendMail(msg) }; },
  logger() { return console; },
  dao() { return $app; }, // deprecated alias kept for older hooks
  isDev() { return false; },
  async runInTransaction(fn: (txApp: typeof $app) => unknown) { return fn($app); },
};

export class MailerMessage {
  from: { address: string; name?: string } = { address: "" };
  to: { address: string; name?: string }[] = [];
  cc: { address: string; name?: string }[] = [];
  bcc: { address: string; name?: string }[] = [];
  subject = "";
  html = "";
  text = "";
  headers: Record<string, string> = {};
  constructor(init: Partial<MailerMessage> = {}) { Object.assign(this, init); }
}

export const $apis = {
  // $apis.enrichRecord(e, record, ...expands): expands and applies the auth-aware export (as the API would)
  async enrichRecord(_e: unknown, record: HookRecord, ...expands: string[]): Promise<HookRecord> { if (expands.length) await svc().expandRecords([record], expands); return record; },
  async enrichRecords(_e: unknown, records: HookRecord[], ...expands: string[]): Promise<HookRecord[]> { if (expands.length) await svc().expandRecords(records, expands); return records; },
  requireAuth(...collections: string[]): HookMiddleware {
    return { id: "pbRequireAuth", func: async (e) => {
      const ev = e as RequestEvent;
      if (!ev.auth || (collections.length && !collections.includes(ev.auth.collection().name))) throw new UnauthorizedError("The request requires valid record authorization token.");
      return ev.next();
    } };
  },
  requireSuperuserAuth(): HookMiddleware {
    return { id: "pbRequireSuperuserAuth", func: async (e) => {
      const ev = e as RequestEvent;
      if (!ev.auth) throw new UnauthorizedError("The request requires valid record authorization token.");
      if (!ev.auth.isSuperuser()) throw new ForbiddenError("The authorized record is not allowed to perform this action.");
      return ev.next();
    } };
  },
  requireGuestOnly(): HookMiddleware {
    return { id: "pbRequireGuestOnly", func: async (e) => { const ev = e as RequestEvent; if (ev.auth) throw new BadRequestError("The request can be accessed only by guests."); return ev.next(); } };
  },
  requireSuperuserOrOwnerAuth(ownerIdPathParam = "id"): HookMiddleware {
    return { id: "pbRequireSuperuserOrOwnerAuth", func: async (e) => {
      const ev = e as RequestEvent;
      if (!ev.auth) throw new UnauthorizedError("The request requires superuser or record authorization token.");
      if (!ev.auth.isSuperuser() && ev.auth.id !== ev.pathParam(ownerIdPathParam)) throw new ForbiddenError("You are not allowed to perform this request.");
      return ev.next();
    } };
  },
};

export const $http = {
  async send(cfg: { url: string; method?: string; body?: string; headers?: Record<string, string>; timeout?: number }) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), (cfg.timeout ?? 120) * 1000);
    try {
      const r = await fetch(cfg.url, { method: cfg.method ?? "GET", body: cfg.body, headers: cfg.headers, signal: ac.signal });
      const raw = await r.text();
      let json: unknown = null; try { json = JSON.parse(raw); } catch { json = null; }
      const headers: Record<string, string[]> = {}; r.headers.forEach((v, k) => { headers[k] = [v]; });
      return { statusCode: r.status, headers, cookies: {}, raw, json, body: new TextEncoder().encode(raw) };
    } finally { clearTimeout(t); }
  },
};

export const $filesystem = {
  async fileFromURL(url: string): Promise<Upload> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`failed to download ${url}: ${r.status}`);
    const bytes = await r.arrayBuffer();
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "file");
    const sniffed = sniffMime(new Uint8Array(bytes), r.headers.get("content-type") ?? "", name);
    return { name: normalizeFilename(name, sniffed.ext), type: sniffed.type, size: bytes.byteLength, bytes };
  },
  async fileFromBytes(bytes: ArrayBuffer | Uint8Array | number[], name: string): Promise<Upload> {
    const buf = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer as ArrayBuffer;
    const sniffed = sniffMime(new Uint8Array(buf), "", name);
    return { name: normalizeFilename(name, sniffed.ext), type: sniffed.type, size: buf.byteLength, bytes: buf };
  },
  async fileFromPath(): Promise<never> { throw new Error("$filesystem.fileFromPath is not available on Workers"); },
};

export const $security = {
  randomString: (n: number) => { const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; const b = crypto.getRandomValues(new Uint8Array(n)); let s = ""; for (let i = 0; i < n; i++) s += a[b[i]! % a.length]; return s; },
  randomStringWithAlphabet: (n: number, a: string) => { const b = crypto.getRandomValues(new Uint8Array(n)); let s = ""; for (let i = 0; i < n; i++) s += a[b[i]! % a.length]; return s; },
  pseudorandomString: (n: number) => $security.randomString(n),
  sha256: async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join(""),
};

export function makeOs(files: Record<string, string>, hooksDir: string) {
  return {
    getenv: (name: string) => { const v = store()?.env[name]; return v == null ? "" : String(v); },
    readFile: (path: string) => {
      const rel = path.startsWith(hooksDir) ? path.slice(hooksDir.length).replace(/^\/+/, "") : path;
      const text = files[rel];
      if (text === undefined) throw new Error(`open ${path}: no such file or directory`);
      return Array.from(new TextEncoder().encode(text));
    },
    writeFile: () => { throw new Error("$os.writeFile is not available on Workers"); },
    exec: () => { throw new Error("$os.exec is not available on Workers"); },
    cmd: () => { throw new Error("$os.cmd is not available on Workers"); },
    args: [] as string[],
  };
}

export function routerAdd(method: string, path: string, handler: HookFn, ...middlewares: HookMiddleware[]) {
  routes.push({ method: method.toUpperCase(), path: toHonoPath(path), handler, middlewares });
}
export function routerUse(..._middlewares: HookMiddleware[]) { /* global hook middleware: milestone six */ }
export function cronAdd(id: string, expr: string, fn: () => unknown) { crons.set(id, { expr, fn }); }
export function cronRemove(id: string) { crons.delete(id); }

// Go 1.22 mux patterns -> Hono: {name} -> :name, {path...} -> *
export function toHonoPath(p: string): string {
  return p.replace(/\{(\w+)\.\.\.\}/g, "*").replace(/\{(\w+)\}/g, ":$1");
}

export const RecordUpsertFormFactory = (_app: AppApi) =>
  class RecordUpsertForm {
    constructor(private a: AppApi, private record: HookRecord) {}
    submit() { return this.a.save(this.record); }
    setRecord(r: HookRecord) { this.record = r; }
  };

export const authToHookRecord = (auth: AuthRecord | null) => (auth ? HookRecord.fromRow(auth.collection, auth.row) : null);

export function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object" && !(v instanceof HookRecord) && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeysDeep(x)]));
  }
  if (v instanceof HookRecord) return v.publicExport();
  return v;
}
