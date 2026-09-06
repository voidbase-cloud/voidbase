// The programmatic API a project's main.ts receives (the counterpart of `pocketbase.New()` + app.OnServe() in Go):
// the same hook functions the JS hooks see ($app, $apis, routerAdd, cronAdd, on* events, Record, ...) plus the
// Hono router for raw routes. Registrations made here are committed with commit() before requests are served.
import type { Context, Hono } from "hono";
import { app } from "./app";
import { hookGlobals } from "./hooks";
import type { RequestEvent } from "./hooks/runtime";
import type { AppEnv } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookGlobals = Record<string, any>;
/** Hono-style handlers (c: Context) on any path, registered at any time; served after PocketBase's own routes. */
export interface LateRouter { get: LateRegister; post: LateRegister; patch: LateRegister; put: LateRegister; delete: LateRegister; all: LateRegister }
type LateRegister = (path: string, handler: (c: Context<AppEnv>) => Response | Promise<Response>) => void;
export interface VoidbaseApp {
  /** app.router.get("/api/x", (c) => c.json(...)): Hono-style routes, usable before or after the JS hooks loaded */
  router: LateRouter;
  /** the Hono instance itself (routes added here must be added before the first request) */
  hono: Hono<AppEnv>;
  /** $app, $apis, $os, $security, routerAdd, routerUse, cronAdd, cronRemove, on* event registrations, Record, Collection, ... */
  hooks: HookGlobals;
}
export function appApi(): VoidbaseApp {
  const hooks = hookGlobals() as HookGlobals;
  const late = (method: string): LateRegister => (path, handler) => hooks.routerAdd(method, path, (e: RequestEvent) => handler(e.c));
  return { router: { get: late("GET"), post: late("POST"), patch: late("PATCH"), put: late("PUT"), delete: late("DELETE"), all: late("ALL") }, hono: app, hooks };
}
