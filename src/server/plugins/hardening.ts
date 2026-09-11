// Hardening, as the plugin that provides `hardening@1`: PocketBase's body limit and its rate limit rules, and the
// response policy (the headers on every response, the files' Content-Security-Policy, CORS and the CSRF check;
// response-policy.ts has the knobs, all off unless set).
//
// Middleware is the one thing a plugin cannot mount for itself here. Hono composes handlers in the order they were
// registered, and the kernel loads after the routes are mounted (see app.ts on why), so a `use("*")` from a plugin
// would sit behind every route and never run. The plugin therefore provides the three handlers, and app.ts holds
// their place in the chain with slots that ask the provider at request time. Removing this plugin removes the
// limits and the policy, CORS included; replacing either is providing `hardening@1` from another plugin.
import { bodyLimitMiddleware, rateLimitMiddleware } from "../hardening";
import type { Hardening } from "../interfaces";
import { serve, type Kernel } from "../kernel";
import { responsePolicy, responsePolicyMiddleware } from "../response-policy";
import type { Plugin } from "./manifest";

export const hardening: Plugin = {
  manifest: {
    name: "hardening",
    version: "0.1.0",
    tier: "official",
    voidbase: "*",
    provides: ["hardening@1"],
  },
  apply(ctx: Kernel) {
    serve<Hardening>(ctx, "hardening@1", { bodyLimit: bodyLimitMiddleware(), rateLimit: rateLimitMiddleware(), responsePolicy: responsePolicyMiddleware(), policy: responsePolicy });
  },
};
