// Runs a Void app's server code inside voidbase, from a pb_hooks file.
//
// This module is bundled into `.voidbase/pb_hooks/void-app.js` together with the app's own routes, so it must not
// import anything from voidbase: a hook runs in a sandbox whose `require` reaches only its sibling hook files.
// Everything it needs from the host arrives as the `HookApi` argument, which the generated `.pb.js` wrapper fills
// in from the hook globals. Its only imports are Void's own runtime, which is bundled along with it.
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
type Middleware = (c: Context, next: () => Promise<void>) => unknown;
type Bindings = Record<string, unknown>;

type ErrorClass = new (message?: string, data?: unknown) => Error;

/**
 * PocketBase's own API, as a route sees it. A route compiled into pb_hooks cannot import voidbase, so the hook
 * wrapper hands these in and `pb` below reads them:
 *
 *     import { defineHandler } from "void";
 *     import { pb, requireAuth } from "@voidbase-cloud/voidbase/adapter";
 *
 *     export const GET = defineHandler(requireAuth("users"), async () => {
 *       return { posts: await pb.$app.findRecordsByFilter("posts", "published = true", "-created", 20, 0) };
 *     });
 */
export interface PocketBaseApi {
  /** the data API: findRecordById, findRecordsByFilter, save, delete, settings, ... */
  $app: AppApi;
  $apis: { requireAuth(...collections: string[]): unknown; requireSuperuserAuth(): unknown; requireGuestOnly(): unknown };
  $os: { getenv(name: string): string };
  Record: new (collection: CollectionRef, data?: Record<string, unknown>) => HookRecord;
  ApiError: ErrorClass;
  BadRequestError: ErrorClass;
  UnauthorizedError: ErrorClass;
  ForbiddenError: ErrorClass;
  NotFoundError: ErrorClass;
  InternalServerError: ErrorClass;
  ValidationError: ErrorClass;
}

let globals: PocketBaseApi | null = null;
/** PocketBase's API inside a route. Reading it before the hook has registered the app is a programming error. */
export const pb: PocketBaseApi = new Proxy({} as PocketBaseApi, {
  get(_t, prop) {
    if (!globals) throw new Error("voidbase: PocketBase's API is not available yet (a route module used `pb` at import time)");
    return (globals as unknown as Record<string | symbol, unknown>)[prop];
  },
});

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

/** What the generated hook wrapper passes in, taken from the hook globals. */
export interface HookApi extends PocketBaseApi {
  routerAdd(method: string, path: string, handler: (e: RequestEvent) => unknown): void;
  cronAdd(id: string, expr: string, fn: () => unknown): void;
  /** $env: the bindings of the request, cron tick or job running now */
  env(): Bindings;
  /** $jobs: voidbase's background queue */
  jobs: {
    queueJob(job: { type: "queue"; queue: string; body: unknown }): Promise<unknown>;
    onJob(type: "queue", fn: (env: Bindings, job: { queue: string; body: unknown }) => Promise<void>): void;
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

export interface MountSpec {
  routes?: MountedRoute[];
  /** global middleware in order; applied to the app's own routes only (see docs/adapter.md) */
  middleware?: Middleware[];
  crons?: MountedCron[];
  queues?: MountedQueue[];
}

/** Producer bindings for the app's queues, overlaid on the real env so `void/queues` and `c.env.QUEUE_X` both work. */
function queueBindings(api: HookApi, queues: MountedQueue[]): Bindings {
  const out: Bindings = {};
  for (const q of queues) {
    out[q.binding] = {
      send: (body: unknown) => api.jobs.queueJob({ type: "queue", queue: q.name, body }),
      sendBatch: async (messages: Iterable<{ body: unknown }>) => { for (const m of messages) await api.jobs.queueJob({ type: "queue", queue: q.name, body: m.body }); },
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

/** Void's own chain: middleware in order, then the handler, whose return value is converted like Void converts it. */
async function runChain(c: Context, middleware: Middleware[], handler: Handler): Promise<Response> {
  let i = 0;
  const dispatchNext = async (): Promise<void> => {
    const mw = middleware[i++];
    if (mw) {
      const res = await mw(c, dispatchNext);
      if (res instanceof Response) c.res = res;
      return;
    }
    c.res = convertReturnValue(await handler(c));
  };
  await dispatchNext();
  return c.res;
}

export function mountVoidApp(api: HookApi, spec: MountSpec): void {
  globals = api; // `pb`, requireAuth() and authOf() read PocketBase's API from here
  const { routes = [], middleware = [], crons = [], queues = [] } = spec;
  const envFor = (base: Bindings): Bindings => (queues.length ? { ...base, ...queueBindings(api, queues) } : base);

  for (const route of routes) {
    for (const method of route.methods) {
      const handler = route.mod[method] as Handler | undefined;
      if (typeof handler !== "function") continue;
      api.routerAdd(method === "ALL" ? "ANY" : method, route.hookPath, async (e) => {
        const c = e.c;
        const env = envFor(c.env as unknown as Bindings);
        const ctx = voidContext(c, paramsOf(route, new URL(c.req.url).pathname), env, e.auth ?? null);
        return withRuntimeEnv(env, () => runChain(ctx, middleware, handler));
      });
    }
  }

  for (const cron of crons) {
    // cronAdd's callback takes no arguments: the bindings come from the hook store the cron runner opens
    api.cronAdd(cron.name, cron.expr, async () => {
      const env = api.env();
      const controller = { cron: cron.expr, scheduledTime: Date.now() };
      await withRuntimeEnv(envFor(env), () => cron.handler(controller, env));
    });
  }

  if (queues.length) {
    const byName = new Map(queues.map((q) => [q.name, q]));
    // One handler for every app queue: voidbase carries the message on its own jobs queue (or runs it inline when
    // the deploy has none), so a Void consumer sees a one-message batch. A throw is the retry signal.
    api.jobs.onJob("queue", async (env, job) => {
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
