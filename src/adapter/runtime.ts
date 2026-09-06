// Runs a Void app's server code inside voidbase. The generated `.voidbase/void-app.ts` imports the app's own
// route/middleware/cron/queue modules and hands them here; nothing in this file knows the app's shape.
//
// Two things make Void code run unchanged:
//   - routes register through `routerAdd`, the same registry pb_hooks use, because voidbase mounts a catch-all
//     dispatcher for it (src/server/hooks/index.ts) and anything added to the Hono app after boot sits behind that
//     catch-all and would never match. The dispatcher hands the handler its RequestEvent, whose `.c` is the real
//     Hono context Void handlers expect.
//   - every handler body runs inside `withRuntimeEnv`, Void's AsyncLocalStorage for bindings, so `void/db`,
//     `void/storage`, `void/env` and `void/queues` resolve against voidbase's D1 and R2 with no shim.
import { withRuntimeEnv } from "void/_env";
import { convertReturnValue } from "void/response";
import type { Context } from "hono";
import type { VoidbaseApp } from "../server/api";
import { currentBindings } from "../server/api";
import { dispatch, registerJobHandler } from "../server/jobs";
import type { Bindings } from "../server/types";

type Handler = (c: Context) => unknown;
type Middleware = (c: Context, next: () => Promise<void>) => unknown;

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
function queueBindings(queues: MountedQueue[], env: Bindings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of queues) {
    out[q.binding] = {
      send: (body: unknown) => dispatch({ type: "queue", queue: q.name, body }, { env }),
      sendBatch: async (messages: Iterable<{ body: unknown }>) => { for (const m of messages) await dispatch({ type: "queue", queue: q.name, body: m.body }, { env }); },
    };
  }
  return out;
}

/** Pulls `:param` and `[...splat]` values out of the path the dispatcher matched. */
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
function voidContext(c: Context, params: Record<string, string>, env: Record<string, unknown>): Context {
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

export function mountVoidApp(app: VoidbaseApp, spec: MountSpec): void {
  const { routes = [], middleware = [], crons = [], queues = [] } = spec;
  const envFor = (base: Bindings): Record<string, unknown> => (queues.length ? { ...base, ...queueBindings(queues, base) } : (base as unknown as Record<string, unknown>));

  for (const route of routes) {
    for (const method of route.methods) {
      const handler = route.mod[method] as Handler | undefined;
      if (typeof handler !== "function") continue;
      app.hooks.routerAdd(method === "ALL" ? "ANY" : method, route.hookPath, async (e: { c: Context }) => {
        const c = e.c;
        const env = envFor(c.env as Bindings);
        const ctx = voidContext(c, paramsOf(route, new URL(c.req.url).pathname), env);
        return withRuntimeEnv(env, () => runChain(ctx, middleware, handler));
      });
    }
  }

  for (const cron of crons) {
    // cronAdd's callback takes no arguments: the bindings come from the hook store the cron runner opens.
    app.hooks.cronAdd(cron.name, cron.expr, async () => {
      const env = (currentBindings() ?? {}) as Bindings;
      const controller = { cron: cron.expr, scheduledTime: Date.now() };
      await withRuntimeEnv(envFor(env), () => cron.handler(controller, env));
    });
  }

  if (queues.length) {
    const byName = new Map(queues.map((q) => [q.name, q]));
    // One handler for every app queue: voidbase carries the message on its own jobs queue (or runs it inline when
    // the deploy has none), so a Void consumer sees a one-message batch. A throw is the retry signal.
    registerJobHandler("queue", async (env, job) => {
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
