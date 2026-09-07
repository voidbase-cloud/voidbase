// Loads the bundled pb_hooks files, exposes the JSVM-compatible globals, mounts routerAdd routes.
import { logger } from "#platform/log";
import type { Hono, MiddlewareHandler } from "hono";
import { files, hooks, hooksDir, modules } from "#platform/hooks";
import { loadCollections } from "../collections/model";
import { dispatch, registerJobHandler, type Job } from "../jobs";
import { loadSettings } from "../settings";
import type { AppEnv } from "../types";
import { CollectionRef, HookRecord } from "./record";
import {
  $apis, $app, $dbx, $filesystem, $http, $security, BadRequestError, ForbiddenError, InternalServerError, MailerMessage, NotFoundError,
  RecordUpsertFormFactory, RequestEvent, UnauthorizedError, ValidationError, authToHookRecord, cronAdd, cronRemove, globalMiddlewares, hookStore,
  crons, eventHooks, makeOs, onEvent, routerAdd, routerUse, routes, type HookMiddleware,
} from "./runtime";
import { ApiError } from "../errors";

const HOOKS_PREFIX = "/pb_hooks";
const $os = makeOs(files, HOOKS_PREFIX);
const moduleCache = new Map<string, unknown>();

class DateTime { d: Date; constructor(v?: string | number | Date) { this.d = v === undefined ? new Date() : new Date(v); } string() { return this.d.toISOString().replace("T", " "); } time() { return this.d; } unix() { return Math.floor(this.d.getTime() / 1000); } toJSON() { return this.string(); } }

// new Field({...}) / new TextField({...}) in JSVM code produce plain field data
function fieldClass(type?: string) {
  return class { constructor(data: Record<string, unknown> = {}) { return { ...(type ? { type } : {}), ...data }; } };
}

function buildGlobals(): Record<string, unknown> {
  const g: Record<string, unknown> = {
    $app, $apis, $http, $os, $filesystem, $security,
    $mails: {}, $template: { loadFiles: () => ({ render: () => "" }) }, $dbx,
    // voidbase extensions a hook cannot get at otherwise: the Cloudflare bindings of the request, cron tick or
    // migration running now, and the background jobs queue
    $env: () => (hookStore.getStore()?.env ?? {}) as Record<string, unknown>,
    $jobs: { queueJob: (job: Job) => dispatch(job), onJob: (type: Job["type"], fn: Parameters<typeof registerJobHandler>[1]) => registerJobHandler(type, fn) },
    routerAdd, routerUse, cronAdd, cronRemove,
    migrate: () => { /* migrations are applied by the migrations runner, not at hook load */ },
    Record: class Record extends HookRecord { constructor(collection: CollectionRef, data?: { [k: string]: unknown }) { super(collection, data ?? {}); } },
    Collection: CollectionRef,
    Field: fieldClass(), TextField: fieldClass("text"), EditorField: fieldClass("editor"), NumberField: fieldClass("number"), BoolField: fieldClass("bool"),
    EmailField: fieldClass("email"), URLField: fieldClass("url"), DateField: fieldClass("date"), AutodateField: fieldClass("autodate"), SelectField: fieldClass("select"),
    FileField: fieldClass("file"), RelationField: fieldClass("relation"), JSONField: fieldClass("json"), GeoPointField: fieldClass("geoPoint"), PasswordField: fieldClass("password"),
    RecordUpsertForm: RecordUpsertFormFactory($app),
    MailerMessage, DateTime, RequestInfo: class {},
    ApiError, NotFoundError, BadRequestError, ForbiddenError, UnauthorizedError, InternalServerError, ValidationError,
    __hooks: HOOKS_PREFIX,
    console,
    toString: (v: unknown) => String(v), sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)), arrayOf: () => [], unmarshal: (v: unknown, dst: unknown) => Object.assign(dst as object, v as object),
    module: { exports: {} }, exports: {},
    require: (path: string) => requireModule(path),
  };
  for (const name of Object.keys(g)) void name;
  // event hook registration functions: onRecordCreate(fn, ...tags) etc.
  const proxy = new Proxy(g, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && prop.startsWith("on")) return (fn: (e: unknown) => unknown, ...tags: string[]) => onEvent(prop, fn, tags);
      return undefined;
    },
  });
  return proxy;
}

function requireModule(path: string): unknown {
  const rel = path.replace(/^\.\//, "").replace(new RegExp("^" + HOOKS_PREFIX + "/?"), "").replace(/\.js$/, "");
  if (moduleCache.has(rel)) return moduleCache.get(rel);
  const factory = modules[rel];
  if (!factory) throw new Error(`Cannot find module '${path}'`);
  const module = { exports: {} as Record<string, unknown> };
  const target: Record<string, unknown> = { ...Object.fromEntries(Object.entries(GLOBALS)), module, exports: module.exports };
  const g = new Proxy(target, {
    get(t, prop: string) { return prop in t ? t[prop] : (GLOBALS as Record<string, unknown>)[prop]; },
  });
  const result = factory(g);
  // module bodies rarely await at the top level; when they do, the promise resolves to module.exports
  const exported = result instanceof Promise ? module.exports : (result ?? module.exports);
  moduleCache.set(rel, exported);
  return exported;
}

const GLOBALS = buildGlobals();
export const hookGlobals = () => GLOBALS;

let loaded = false;
export function loadHooks() {
  if (loaded) return;
  loaded = true;
  // a dev reload re-evaluates this module while runtime.ts keeps its registries: start from empty
  routes.length = 0;
  eventHooks.clear();
  crons.clear();
  for (const h of hooks) {
    try {
      // top-level registrations run synchronously inside run(); the returned promise only settles handlers
      void h.run(GLOBALS).catch((err) => logger.error("voidbase: hook file failed", { hook: h.name, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    } catch (err) { logger.error("voidbase: hook file failed", { hook: h.name, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }); }
  }
  console.log(`voidbase: loaded ${hooks.length} hook file(s) from ${hooksDir}, ${routes.length} route(s)`);
}

// Runs handlers registered with routerAdd. Registered after the core routes so PocketBase's own API wins.
// Hook routes (routerAdd from pb_hooks or a project's main.ts) are served by one catch-all registered after the core
// routes, matching against the live registry at request time. Hono builds its matcher on the first request and
// ignores routes added afterwards, so registrations may happen at any time (a main.ts composes after the JS hooks).
interface Compiled { route: (typeof routes)[number]; re: RegExp; keys: string[]; score: number }
let compiled: Compiled[] | null = null; let compiledFor = -1;
function compile(): Compiled[] {
  if (compiled && compiledFor === routes.length) return compiled;
  // Go's ServeMux picks the most specific pattern: literal segments beat params beat wildcards
  const score = (p: string) => (p.includes("*") ? 0 : 1000) + p.split("/").filter((s) => s && !s.startsWith(":")).length * 10 + p.split("/").length;
  compiled = routes.map((route) => {
    const keys: string[] = [];
    const src = route.path.split("/").map((seg) => {
      if (seg === "*") return ".*";
      if (seg.startsWith(":")) { keys.push(seg.slice(1)); return "([^/]+)"; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    return { route, re: new RegExp(`^${src}/?$`), keys, score: score(route.path) };
  }).sort((a, b) => b.score - a.score);
  compiledFor = routes.length;
  return compiled;
}
export function mountHookRoutes(app: Hono<AppEnv>) {
  app.all("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    for (const { route, re, keys } of compile()) {
      if (route.method !== "ALL" && route.method !== c.req.method) continue;
      const m = re.exec(path); if (!m) continue;
      const ev = new RequestEvent(c, authToHookRecord(c.get("auth")));
      keys.forEach((k, i) => { ev.params[k] = decodeURIComponent(m[i + 1] ?? ""); });
      const chain: HookMiddleware[] = [...route.middlewares, route.handler];
      let i = 0;
      const next = async (): Promise<unknown> => { const mw = chain[i++]; if (!mw) return undefined; return (typeof mw === "function" ? mw : mw.func)(ev); };
      ev.next = next;
      const result = await next();
      if (result instanceof Response) return result;
      if (ev.written) return ev.written;
      return c.body(null, 204);
    }
    return c.notFound();
  });
}

/** PocketBase's routerUse middleware, around every request voidbase serves (its own endpoints included). */
export function globalHookMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!globalMiddlewares.length) return next();
    const ev = new RequestEvent(c, authToHookRecord(c.get("auth")));
    let i = 0, reachedRoute = false;
    const step = async (): Promise<unknown> => {
      const mw = globalMiddlewares[i++];
      if (!mw) { reachedRoute = true; await next(); return undefined; }
      return (typeof mw === "function" ? mw : mw.func)(ev);
    };
    ev.next = step;
    const result = await step();
    if (result instanceof Response) return result;
    if (ev.written) return ev.written;
    // a middleware that stopped the chain without answering: an empty 204, as a hook route in the same state gets
    if (!reachedRoute) return c.body(null, 204);
    return undefined;
  };
}

// Per-request state for $app and friends.
export function hookMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const collections = await loadCollections(c.env.DB);
    const settings = await loadSettings(c.env.DB);
    const { recordContextFor } = await import("../app");
    return hookStore.run({ c, ctx: () => recordContextFor(c), collections, settings, env: c.env as unknown as Record<string, unknown> }, next);
  };
}
