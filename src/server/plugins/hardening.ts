// Hardening, as the plugin that provides `hardening@1`: PocketBase's body limit and its rate limit rules.
//
// Middleware is the one thing a plugin cannot mount for itself here. Hono composes handlers in the order they were
// registered, and the kernel loads after the routes are mounted (see app.ts on why), so a `use("*")` from a plugin
// would sit behind every route and never run. The plugin therefore provides the two handlers, and app.ts holds
// their place in the chain with a slot that asks the provider at request time. Removing this plugin removes the
// limits; replacing the limiter is providing `hardening@1` from another plugin.
import { bodyLimitMiddleware, rateLimitMiddleware } from "../hardening";
import type { Hardening } from "../interfaces";
import { serve, type Kernel } from "../kernel";
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
    serve<Hardening>(ctx, "hardening@1", { bodyLimit: bodyLimitMiddleware(), rateLimit: rateLimitMiddleware() });
  },
};
