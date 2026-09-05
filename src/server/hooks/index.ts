// Loads the bundled pb_hooks files, exposes the JSVM-compatible globals, mounts routerAdd routes.
import type { Hono, MiddlewareHandler } from "hono";
import { files, hooks, hooksDir, modules } from "virtual:voidbase-hooks";
import { loadCollections } from "../collections/model";
import { loadSettings } from "../settings";
import type { AppEnv } from "../types";
import { CollectionRef, HookRecord } from "./record";
import {
  $apis, $app, $filesystem, $http, $security, BadRequestError, ForbiddenError, InternalServerError, MailerMessage, NotFoundError,
  RecordUpsertFormFactory, RequestEvent, UnauthorizedError, ValidationError, authToHookRecord, cronAdd, cronRemove, hookStore,
  crons, eventHooks, makeOs, onEvent, routerAdd, routerUse, routes, type HookMiddleware,
} from "./runtime";
import { ApiError } from "../errors";

const HOOKS_PREFIX = "/pb_hooks";
const $os = makeOs(files, HOOKS_PREFIX);
const moduleCache = new Map<string, unknown>();

class DateTime { d: Date; constructor(v?: string | number | Date) { this.d = v === undefined ? new Date() : new Date(v); } string() { return this.d.toISOString().replace("T", " "); } time() { return this.d; } unix() { return Math.floor(this.d.getTime() / 1000); } toJSON() { return this.string(); } }

function buildGlobals(): Record<string, unknown> {
  const g: Record<string, unknown> = {
    $app, $apis, $http, $os, $filesystem, $security,
    $mails: {}, $template: { loadFiles: () => ({ render: () => "" }) }, $dbx: {},
    routerAdd, routerUse, cronAdd, cronRemove,
    migrate: () => { /* migrations are applied by the migrations runner, not at hook load */ },
    Record: class Record extends HookRecord { constructor(collection: CollectionRef, data?: { [k: string]: unknown }) { super(collection, data ?? {}); } },
    Collection: CollectionRef,
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
      void h.run(GLOBALS).catch((err) => console.error(`voidbase: hook ${h.name} failed`, err));
    } catch (err) { console.error(`voidbase: hook ${h.name} failed`, err); }
  }
  console.log(`voidbase: loaded ${hooks.length} hook file(s) from ${hooksDir}, ${routes.length} route(s)`);
}

// Runs handlers registered with routerAdd. Registered after the core routes so PocketBase's own API wins.
export function mountHookRoutes(app: Hono<AppEnv>) {
  // Go's ServeMux picks the most specific pattern; Hono picks the first registered. Mount specific routes first.
  const specificity = (p: string) => (p.includes("*") ? 0 : 1000) + p.split("/").filter((s) => s && !s.startsWith(":")).length * 10 + p.split("/").length;
  const ordered = [...routes].sort((a, b) => specificity(b.path) - specificity(a.path));
  for (const r of ordered) {
    app.on(r.method, r.path, async (c) => {
      const ev = new RequestEvent(c, authToHookRecord(c.get("auth")));
      const chain: HookMiddleware[] = [...r.middlewares, r.handler];
      let i = 0;
      const next = async (): Promise<unknown> => {
        const m = chain[i++];
        if (!m) return undefined;
        const fn = typeof m === "function" ? m : m.func;
        return fn(ev);
      };
      ev.next = next;
      const result = await next();
      if (result instanceof Response) return result;
      if (ev.written) return ev.written;
      return c.body(null, 204);
    });
  }
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
