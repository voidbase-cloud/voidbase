// `@voidbase-cloud/voidbase/hardening-middleware`: the handlers the hardening plugin provides, and its one route.
//
// plugins/hardening.ts provides `hardening@1` from these and mounts `GET /api/csrf`. Middleware is the one thing a
// plugin cannot mount for itself (hono composes in registration order and the kernel loads after the routes are
// mounted), so app.ts holds the place in the chain and asks the provider at request time; what the plugin hands it
// is these three handlers, plus `responsePolicy` so a caller can read the policy without running it.
export { mountCsrfRoute, type CsrfMode } from "../csrf";
export { bodyLimitMiddleware, rateLimitMiddleware } from "../hardening";
export { responsePolicy, responsePolicyMiddleware, type ResponsePolicy } from "../response-policy";
