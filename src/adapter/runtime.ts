// Runs a Void app's server code inside voidbase, from a pb_hooks file.
//
// This module is bundled into `.voidbase/pb_hooks/void-app.js` together with the app's own routes, so it must not
// import anything from voidbase: a hook runs in a sandbox whose `require` reaches only its sibling hook files.
// PocketBase's API reaches it through `pb`, which reads the hook globals the generated `.pb.js` wrapper publishes
// before it requires this bundle. Its only imports are Void's own runtime, which is bundled along with it.
//
// Two things make Void code run unchanged:
//   - routes register through `routerAdd`, the registry every pb_hooks route uses, and the RequestEvent it hands
//     the handler carries `.c`, the real Hono context Void handlers expect;
//   - every handler body runs inside `withRuntimeEnv`, Void's AsyncLocalStorage for bindings, so `void/db`,
//     `void/storage`, `void/env` and `void/queues` resolve against voidbase's D1 and R2 with no shim.
import { withRuntimeEnv } from "void/_env";
import { convertReturnValue } from "void/response";
import type { Context } from "hono";
// types only: erased by the bundler, so this file keeps its promise of importing nothing from voidbase at runtime
import type { AppApi, RequestEvent } from "../server/hooks/runtime";
import type { CollectionRef, HookRecord } from "../server/hooks/record";

type Handler = (c: Context) => unknown;
export type Middleware = (c: Context, next: () => Promise<void>) => Promise<void>;

/** PocketBase's global request middleware: every request, before whatever answers it. */
export const REQUEST_HOOK = "routerUse";
/** The name of a PocketBase hook: `routerUse`, or one of its `on*` events. */
export type HookName = typeof REQUEST_HOOK | `on${string}`;
/** A `vb_hooks/` file's default export. */
export interface HookModule<E = HookEvent> { (e: E): unknown; hook: HookName; tags: string[] }
/** What a hook handler is given. Request hooks carry `.c`, the Hono context; every hook carries `.next()`. */
export type HookEvent = { next(): Promise<unknown> } & Record<string, unknown>;
type Bindings = Record<string, unknown>;

type ErrorClass = new (message?: string, data?: unknown) => Error;
// ApiError is the one that carries its own status, so it does not have the shape the rest of them share:
// `new ApiError(502, "...")`. Typing it as an ErrorClass made the correct call a type error and the call that
// satisfied the type set status to a string.
type ApiErrorClass = new (status?: number, message?: string, data?: unknown) => Error;
/* eslint-disable @typescript-eslint/no-explicit-any -- PocketBase events are many shapes; the hook API is loose by nature */
type EventRegistrar = (fn: (e: any) => unknown, ...tags: string[]) => void;

/**
 * PocketBase's API, as the app's own code sees it. A route compiled into pb_hooks cannot import voidbase, so the
 * generated hook publishes the hook globals and this reads them:
 *
 *     import { defineHandler } from "void";
 *     import { pb, requireAuth } from "@voidbase-cloud/voidbase/adapter";
 *
 *     export const GET = defineHandler(requireAuth("users"), async () => {
 *       return { posts: await pb.$app.findRecordsByFilter("posts", "published = true", "-created", 20, 0) };
 *     });
 *
 * It is filled in before any module body runs, so a plain module under `src/` can register PocketBase's *event*
 * hooks at import time, exactly as a hook file does — as long as a route or middleware imports it:
 *
 *     // src/server/audit.ts, imported by the routes that need it
 *     pb.onRecordAfterCreateSuccess((e) => { ... }, "posts");
 */
export type PocketBaseApi = {
  /** the data API: findRecordById, findRecordsByFilter, save, delete, settings, ... */
  $app: AppApi;
  $apis: { requireAuth(...collections: string[]): unknown; requireSuperuserAuth(): unknown; requireGuestOnly(): unknown };
  $os: { getenv(name: string): string };
  /** the bindings of the request, cron tick or job running now */
  $env(): Bindings;
  /** voidbase's background queue */
  $jobs: {
    queueJob(job: { type: "queue"; queue: string; body: unknown }): Promise<unknown>;
    onJob(type: "queue", fn: (env: Bindings, job: { queue: string; body: unknown }) => Promise<void>): void;
  };
  Record: new (collection: CollectionRef, data?: Record<string, unknown>) => HookRecord;
  ApiError: ApiErrorClass;
  BadRequestError: ErrorClass;
  UnauthorizedError: ErrorClass;
  ForbiddenError: ErrorClass;
  NotFoundError: ErrorClass;
  InternalServerError: ErrorClass;
  ValidationError: ErrorClass;
  routerAdd(method: string, path: string, handler: (e: RequestEvent) => unknown): void;
  /** PocketBase's global middleware: every request, before the route that answers it */
  routerUse(...middlewares: ((e: RequestEvent) => unknown)[]): void;
  cronAdd(id: string, expr: string, fn: () => unknown): void;
} & { [K in `on${string}`]: EventRegistrar };
/* eslint-enable @typescript-eslint/no-explicit-any */

/** where the generated hook publishes the globals, before it requires this bundle */
const HANDOFF = "__voidbaseHooks";
const hookGlobals = () => (globalThis as Record<string, unknown>)[HANDOFF] as Record<string | symbol, unknown> | undefined;

// Registering something -- an event hook, a route, a cron -- is the one thing a module may do while it is being
// imported, and a module is imported in more places than the generated app: Void's build evaluates the same code
// to prerender the pages, with no PocketBase anywhere. So registrations made before the hook globals arrive are
// held and replayed once they do, and discarded with the process when they never do. Everything else -- $app and
// the rest of the data API -- has no answer outside the app and says so.
const REGISTRAR = /^(on[A-Z]|routerAdd$|routerUse$|cronAdd$)/;
const deferred: { prop: string; args: unknown[] }[] = [];
let replayed = false;
function replay(globals: Record<string | symbol, unknown>) {
  if (replayed) return;
  replayed = true;
  for (const call of deferred.splice(0)) (globals[call.prop] as (...a: unknown[]) => unknown)(...call.args);
}

export const pb: PocketBaseApi = new Proxy({} as PocketBaseApi, {
  get(_t, prop) {
    const globals = hookGlobals();
    if (globals) { replay(globals); return globals[prop]; }
    if (typeof prop === "string" && REGISTRAR.test(prop)) return (...args: unknown[]) => { deferred.push({ prop, args }); };
    throw new Error(`voidbase: pb.${String(prop)} is only available inside the generated app, where the hook publishes PocketBase's API`);
  },
});

/**
 * A `vb_hooks/` file: one PocketBase hook, registered once when the app mounts. The file names its hook here, so
 * the build can read it without running anything:
 *
 *     // vb_hooks/10.audit.ts
 *     import { defineHook } from "@voidbase-cloud/voidbase/adapter";
 *
 *     export default defineHook("onRecordAfterCreateSuccess", async (e) => {
 *       await e.next();
 *       console.log("created", e.record);
 *     }, "posts");
 *
 * The trailing arguments are PocketBase's tags, the collections the hook is limited to. A middleware that runs on
 * every request is Void's own thing and belongs in `middleware/`, written with `defineMiddleware`.
 */
export function defineHook<E = HookEvent>(hook: HookName, handler: (e: E) => unknown, ...tags: string[]): HookModule<E> {
  return Object.assign(handler, { hook, tags }) as HookModule<E>;
}

/**
 * `vb_secrets/main.ts`: the secrets the app needs, named where the build can read them. Their values live in
 * `vb_secrets/secrets.json` (git-ignored) on a dev machine and as the Worker's secrets once deployed; the app reads
 * them like any binding (`c.env.SMTP_PASSWORD`, `pb.$os.getenv("SMTP_PASSWORD")`):
 *
 *     export default defineSecrets({
 *       SMTP_PASSWORD: "the mail provider's SMTP password",
 *     });
 *
 * The result is the declaration itself, so `keyof typeof secrets` names them for the app's own typing.
 */
export function defineSecrets<const T extends Record<string, string | { description?: string }>>(secrets: T): T {
  return secrets;
}

const AUTH = Symbol.for("voidbase.auth");
/** The authenticated record of this request, exactly as a PocketBase hook sees it (`e.auth`). */
export function authOf(c: Context): HookRecord | null {
  return ((c as unknown as Record<symbol, HookRecord | null>)[AUTH]) ?? null;
}

/** Void-shaped counterparts of $apis.requireAuth / requireSuperuserAuth, for `defineHandler(mw, handler)`. */
export function requireAuth(...collections: string[]): Middleware {
  return async (c, next) => {
    const auth = authOf(c);
    if (!auth || (collections.length && !collections.includes(auth.collection().name))) throw new pb.UnauthorizedError("The request requires valid record authorization token.");
    await next();
  };
}
export function requireSuperuser(): Middleware {
  return async (c, next) => {
    const auth = authOf(c);
    if (!auth) throw new pb.UnauthorizedError("The request requires valid record authorization token.");
    if (!auth.isSuperuser()) throw new pb.ForbiddenError("The authorized record is not allowed to perform this action.");
    await next();
  };
}

export interface MountedRoute {
  url: string;
  hookPath: string;
  methods: string[];
  params: string[];
  splat?: string;
  /** the route module: { GET, POST, ... } */
  mod: Record<string, unknown>;
}
export interface MountedQueue {
  name: string;
  binding: string;
  /** the queue module's default export, a `defineQueue` consumer */
  consumer: (batch: QueueBatch, env: Bindings) => unknown;
}
export interface MountedCron {
  /** the cron id, taken from the file name */
  name: string;
  /** the schedule the module exports as `cron` */
  expr: string;
  handler: (controller: { cron: string; scheduledTime: number }, env: Bindings) => unknown;
}
export interface QueueMessage { id: string; body: unknown; timestamp: Date; attempts: number; ack(): void; retry(): void }
export interface QueueBatch { queue: string; messages: QueueMessage[]; ackAll(): void; retryAll(): void }

export interface MountedHook {
  /** the hook this file attaches to, read from its source at build time */
  hook: HookName;
  /** the file's default export */
  handler: HookModule;
}

export interface MountSpec {
  /** vb_hooks/, in file order: one PocketBase hook each, registered once */
  hooks?: MountedHook[];
  routes?: MountedRoute[];
  /** middleware/, in file order: Void's own, registered through routerUse so it runs on every request */
  middleware?: Middleware[];
  crons?: MountedCron[];
  queues?: MountedQueue[];
}

/** Producer bindings for the app's queues, overlaid on the real env so `void/queues` and `c.env.QUEUE_X` both work. */
function queueBindings(queues: MountedQueue[]): Bindings {
  const out: Bindings = {};
  for (const q of queues) {
    out[q.binding] = {
      send: (body: unknown) => pb.$jobs.queueJob({ type: "queue", queue: q.name, body }),
      sendBatch: async (messages: Iterable<{ body: unknown }>) => { for (const m of messages) await pb.$jobs.queueJob({ type: "queue", queue: q.name, body: m.body }); },
    };
  }
  return out;
}

/** Pulls `:param` and `[...splat]` values out of the path the router matched. */
function paramsOf(route: MountedRoute, path: string): Record<string, string> {
  const pattern = route.hookPath.split("/");
  const actual = path.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i]!;
    if (seg === "*") { if (route.splat) params[route.splat] = actual.slice(i).join("/"); break; }
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(actual[i] ?? "");
  }
  return params;
}

/** The Hono context a Void handler sees: real context, with the route's params and the queue bindings overlaid. */
function voidContext(c: Context, params: Record<string, string>, env: Bindings, auth: HookRecord | null): Context {
  const bind = <T extends object>(target: T, prop: string | symbol) => {
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  };
  const req = new Proxy(c.req, {
    get(target, prop) {
      if (prop === "param") return (name?: string) => (name === undefined ? { ...target.param(), ...params } : params[name] ?? target.param(name as never));
      return bind(target, prop);
    },
  });
  return new Proxy(c, {
    get(target, prop) {
      if (prop === "req") return req;
      if (prop === "env") return env;
      if (prop === AUTH) return auth;
      return bind(target, prop);
    },
    set(target, prop, value) { return Reflect.set(target, prop, value, target); },
  }) as Context;
}

/** A handler's return value becomes a Response exactly as Void converts it. */
async function runHandler(c: Context, handler: Handler): Promise<Response> {
  c.res = convertReturnValue(await handler(c));
  return c.res;
}

export function mountVoidApp(spec: MountSpec): void {
  const { hooks = [], routes = [], middleware = [], crons = [], queues = [] } = spec;

  const envFor = (base: Bindings): Bindings => (queues.length ? { ...base, ...queueBindings(queues) } : base);

  // vb_hooks/ first, in file order: one PocketBase hook per file, registered once. An onBootstrap has to be in
  // place before voidbase opens the database, and nothing else here depends on the order.
  for (const h of hooks) {
    const register = pb[h.hook] as (fn: (e: HookEvent) => unknown, ...tags: string[]) => void;
    if (typeof register !== "function") throw new Error(`voidbase: "${h.hook}" is not one of PocketBase's hooks`);
    register(h.handler, ...(h.handler.tags ?? []));
  }

  // Void's middleware/ means every request, and PocketBase's routerUse is exactly that: in file order, before
  // whatever answers, PocketBase's own endpoints and the admin panel included. So a middleware that throws takes
  // the whole backend with it.
  for (const voidMw of middleware) {
    pb.routerUse(async (e: RequestEvent) => {
      const c = e.c;
      const env = envFor(c.env as unknown as Bindings);
      const ctx = voidContext(c, {}, env, e.auth ?? null);
      let called = false;
      const res = await withRuntimeEnv(env, () => voidMw(ctx, async () => { called = true; await e.next(); }));
      if (!called && res === undefined) await e.next(); // a middleware that returned without calling next() still passes through
      return res;
    });
  }

  for (const route of routes) {
    for (const method of route.methods) {
      const handler = route.mod[method] as Handler | undefined;
      if (typeof handler !== "function") continue;
      pb.routerAdd(method === "ALL" ? "ANY" : method, route.hookPath, async (e) => {
        const c = e.c;
        const env = envFor(c.env as unknown as Bindings);
        const ctx = voidContext(c, paramsOf(route, new URL(c.req.url).pathname), env, e.auth ?? null);
        return withRuntimeEnv(env, () => runHandler(ctx, handler));
      });
    }
  }

  for (const cron of crons) {
    // cronAdd's callback takes no arguments: the bindings come from the hook store the cron runner opens
    pb.cronAdd(cron.name, cron.expr, async () => {
      const env = pb.$env();
      const controller = { cron: cron.expr, scheduledTime: Date.now() };
      await withRuntimeEnv(envFor(env), () => cron.handler(controller, env));
    });
  }

  if (queues.length) {
    const byName = new Map(queues.map((q) => [q.name, q]));
    // One handler for every app queue: voidbase carries the message on its own jobs queue (or runs it inline when
    // the deploy has none), so a Void consumer sees a one-message batch. A throw is the retry signal.
    pb.$jobs.onJob("queue", async (env, job) => {
      const q = byName.get(job.queue);
      if (!q) throw new Error(`voidbase: no consumer for queue "${job.queue}"`);
      let retry = false;
      const message: QueueMessage = { id: crypto.randomUUID(), body: job.body, timestamp: new Date(), attempts: 1, ack: () => { retry = false; }, retry: () => { retry = true; } };
      const batch: QueueBatch = { queue: q.name, messages: [message], ackAll: () => { retry = false; }, retryAll: () => { retry = true; } };
      await withRuntimeEnv(envFor(env), () => q.consumer(batch, env));
      if (retry) throw new Error(`voidbase: queue "${job.queue}" asked to retry`);
    });
  }
}
