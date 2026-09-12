// Hardening, as the plugin that provides `hardening@1`: PocketBase's body limit and its rate limit rules, and the
// response policy (the headers on every response, the files' Content-Security-Policy, CORS and the CSRF check; the
// core's response-policy module has the knobs, all off unless set).
//
// Middleware is the one thing a plugin cannot mount for itself here. Hono composes handlers in the order they were
// registered, and the kernel loads after the routes are mounted (see app.ts on why), so a `use("*")` from a plugin
// would sit behind every route and never run. The plugin therefore provides the three handlers, and app.ts holds
// their place in the chain with slots that ask the provider at request time. Removing this plugin removes the
// limits and the policy, CORS included; replacing either is providing `hardening@1` from another plugin.
//
// One route is the exception, and it is a route because it has to hand something back: `GET /api/csrf`, the
// double-submit token. It is mounted whatever the knob says and answers 404 while the knob is off, since the knob
// is read per request and the routes are fixed when the app is built.
//
// The file is the one that sat in `packages/voidbase/src/server/plugins/hardening.ts`, with its six relative
// imports written as the four published names they already resolved to: `../csrf`, `../hardening` and
// `../response-policy` are one entry, `@voidbase-cloud/voidbase/hardening-middleware`, which 7.2 published for this
// plugin and holds exactly the five calls it makes; `../interfaces`, `../kernel` and `./manifest` become
// `/interfaces`, `/kernel` and `/plugins`. Nothing else about the plugin changed.
import {
  bodyLimitMiddleware,
  mountCsrfRoute,
  rateLimitMiddleware,
  responsePolicy,
  responsePolicyMiddleware,
} from "@voidbase-cloud/voidbase/hardening-middleware";
import type { Hardening } from "@voidbase-cloud/voidbase/interfaces";
import { serve, type Kernel } from "@voidbase-cloud/voidbase/kernel";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";

export const hardening: Plugin = {
  manifest: {
    name: "hardening",
    version: "0.1.0",
    tier: "official",
    voidbase: "*",
    provides: ["hardening@1"],
  },
  apply(ctx: Kernel) {
    mountCsrfRoute(ctx.app, (env) => responsePolicy(env).csrf);
    serve<Hardening>(ctx, "hardening@1", { bodyLimit: bodyLimitMiddleware(), rateLimit: rateLimitMiddleware(), responsePolicy: responsePolicyMiddleware(), policy: responsePolicy });
  },
};
