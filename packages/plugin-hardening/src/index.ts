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
    tier: "core",
    voidbase: "*",
    provides: ["hardening@1"],
    // every one is read per request (response-policy.ts), so every change takes effect at once
    config: {
      cors_origins: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_CORS_ORIGINS", description: "The origins a browser may call the API from, comma separated. Empty allows any." },
      referrer_policy: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_REFERRER_POLICY", description: "The Referrer-Policy header, when it names one." },
      permissions_policy: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_PERMISSIONS_POLICY", description: "The Permissions-Policy header, when it names one." },
      hsts: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_HSTS", description: "Strict-Transport-Security: 1 for one year, or the header's own value." },
      csp: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_CSP", description: "The Content-Security-Policy for everything no route or file policy covers." },
      csp_files: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_CSP_FILES", description: "The Content-Security-Policy on served files. Empty keeps the built-in one." },
      csp_routes: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_CSP_ROUTES", description: "<path glob>:<policy> entries separated by ;, the first match deciding." },
      csrf: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_CSRF", description: "double-submit requires the X-CSRF-Token header on a cookie request." },
      cross_origin: { type: "string", applies: "runtime", default: "", knob: "VOIDBASE_CROSS_ORIGIN", description: "1 sends Cross-Origin-Embedder-Policy require-corp and Cross-Origin-Resource-Policy same-origin." },
    },
  },
  apply(ctx: Kernel) {
    mountCsrfRoute(ctx.app, (env) => responsePolicy(env).csrf);
    serve<Hardening>(ctx, "hardening@1", { bodyLimit: bodyLimitMiddleware(), rateLimit: rateLimitMiddleware(), responsePolicy: responsePolicyMiddleware(), policy: responsePolicy });
  },
};
