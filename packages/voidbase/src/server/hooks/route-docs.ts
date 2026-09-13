// The routes this instance's own code added, described: the part of the hooks runtime a plugin that describes the API
// reads. A module of its own rather than a function in ./index.ts, because a plugin package reaches it through the sdk
// entry, and ./index.ts brings the whole app's bootstrap into that package's type check. It reads the registries in
// ./runtime.ts and imports no platform module: #platform/hooks compiles pb_hooks, which reaches the modules that load
// the plugins, and a plugin package may not import its way back into those.
import { routes, sourceRouteDocs, toHonoPath, type HookMiddleware } from "./runtime";

export interface HookRouteDoc { method: string; path: string; superuser: boolean; response?: Record<string, unknown> }

/**
 * The routes this instance's own code added, for the API description (the openapi plugin): every route in the live
 * registry, pb_hooks' and a project entry file's alike, in OpenAPI's path form. Where a pb_hooks file's source could
 * be read (hooks-plugin.ts routeDocsOf) it says what the route answers and whether a superuser's guard is on it; a
 * route added from an entry file is known by its method and path, and by the guard when it carries one.
 */
export function hookRouteDocs(): HookRouteDoc[] {
  const documented = new Map(sourceRouteDocs.map((d) => [`${d.method} ${toHonoPath(d.path)}`, d]));
  const openApiPath = (p: string) => p.replace(/:(\w+)/g, "{$1}").replace(/\*$/, "{path}");
  const guarded = (mw: HookMiddleware[]) => mw.some((m) => (typeof m === "function" ? (m as { voidbaseGuard?: string }).voidbaseGuard : (m as { id?: string }).id) === "pbRequireSuperuserAuth");
  const out = new Map<string, HookRouteDoc>();
  for (const r of routes) {
    const k = `${r.method} ${r.path}`;
    if (out.has(k)) continue;
    const d = documented.get(k);
    out.set(k, { method: r.method, path: openApiPath(r.path), superuser: (d?.superuser ?? false) || guarded(r.middlewares), ...(d?.response ? { response: d.response } : {}) });
  }
  return [...out.values()];
}

