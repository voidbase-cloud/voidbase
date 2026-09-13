// Auth, as the core plugin that provides `auth@1`: who is making a request, what a superuser is, which collections
// hold accounts, and the fields every account answers to in a rule.
//
// The implementation is unchanged and still lives in ../auth.ts, ../auth-flows.ts, ../auth-extra.ts, ../oauth2 and
// ../webauthn.ts: password, OAuth2, OTP, MFA, passkeys and the token kinds, about twelve hundred lines. What
// changes is the seam. app.ts no longer imports any of it: every route of it is mounted here, onto the app the
// kernel hands over, and every question the core has about auth goes through ../auth-slot.ts to whoever provides
// the interface, which is this plugin until another one takes its place. The tier is `core`: an instance runs
// without it and says so, rather than refusing to start, because replacing auth is the entire point of moving it
// out (plan.md, decision 0.3).
//
// Not yet moved: the auth collections (_superusers, _externalAuths, _authOrigins, _otps, _mfas) are still created
// by the bootstrap. The manifest owns them, so no other plugin can claim them; handing their creation over is next.
//
// The file is the one that sat in `packages/voidbase/src/server/plugins/auth.ts`, with its relative imports written as
// the published names they already resolved to: the sign-in flows through `/auth-routes` (where the core's own
// `isSuperuser` is `isSuperuserRecord`), the collections and errors through `/sdk`, and the rest by their entries.
// The implementation stays in the core behind `/auth-routes`, as it did before; this package is the plugin.
import type { Context, Hono } from "hono";
import { authMethods, authRefresh, authWithPassword, findAuthRecordByToken, isSuperuserRecord as isSuperuser, tokenFromRequest } from "@voidbase-cloud/voidbase/auth-routes";
import { AUTH_CLEAR_PATH, authClearCookieFor } from "@voidbase-cloud/voidbase/auth-routes";
import { mountAuthExtra } from "@voidbase-cloud/voidbase/auth-routes";
import { mountAuthFlows } from "@voidbase-cloud/voidbase/auth-routes";
import type { Field } from "@voidbase-cloud/voidbase/types";
import { findCollection, isAuth, listCollections, SUPERUSERS } from "@voidbase-cloud/voidbase/sdk";
import { notFound } from "@voidbase-cloud/voidbase/sdk";
import type { Auth } from "@voidbase-cloud/voidbase/interfaces";
import { serve, type Kernel } from "@voidbase-cloud/voidbase/kernel";
import { authWithOAuth2, mountOAuth2Redirect } from "@voidbase-cloud/voidbase/auth-routes";
import { recordContextFor } from "@voidbase-cloud/voidbase/record-slot";
import type { AppEnv } from "@voidbase-cloud/voidbase/types";
import { mountWebAuthn } from "@voidbase-cloud/voidbase/auth-routes";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";

/** what every auth record answers to in a rule, whatever its collection declares (filter/compile.ts asks) */
const STATIC: Pick<Field, "name" | "type">[] = [
  { name: "id", type: "text" }, { name: "collectionId", type: "text" }, { name: "collectionName", type: "text" },
  { name: "email", type: "email" }, { name: "emailVisibility", type: "bool" }, { name: "verified", type: "bool" },
];

export const provider: Auth = {
  authenticate(request, env) { const token = tokenFromRequest(request, env); return token ? findAuthRecordByToken(env.DB, token) : Promise.resolve(null); },
  fromToken: (token, env, type = "auth") => findAuthRecordByToken(env.DB, token, type),
  schema: () => STATIC.map((f) => ({ ...f })),
  collections: async (env) => (await listCollections(env.DB)).filter(isAuth).map((c) => c.name),
  isSuperuser,
};

function mountRoutes(app: Hono<AppEnv>) {
  const collection = async (c: Context<AppEnv>) => { const coll = await findCollection(c.env.DB, c.req.param("collection") ?? ""); if (!coll) throw notFound("Missing collection context."); return coll; };
  const authCollection = async (c: Context<AppEnv>) => { const coll = await collection(c); if (!isAuth(coll)) throw notFound("Missing or invalid auth collection context."); return coll; };
  // the record context is the app's, and the app imports this module, so it is asked for through the core's slot
  // (../record-slot.ts) rather than by importing the app: built per request, as the record routes build it
  const ctx = (c: Context<AppEnv>) => recordContextFor(c);
  app.post("/api/collections/:collection/auth-with-password", async (c) => authWithPassword(c, await collection(c)));
  app.post("/api/collections/:collection/auth-with-oauth2", async (c) => authWithOAuth2(c, await authCollection(c), await ctx(c)));
  app.post("/api/collections/:collection/auth-refresh", async (c) => authRefresh(c, await collection(c)));
  app.get("/api/collections/:collection/auth-methods", async (c) => authMethods(c, await collection(c)));
  // sign-out: the other half of VOIDBASE_AUTH_COOKIE. A bearer client clears its own store and never needs this;
  // a cookie session cannot, because the cookie is HttpOnly, so the server takes it away. Idempotent, and it needs
  // no valid session of its own: clearing a cookie nobody holds is a 204 either way.
  app.post(`/api/collections/:collection/${AUTH_CLEAR_PATH}`, async (c) => {
    await authCollection(c); // the collection still has to exist and hold accounts, as on every other auth route
    const cookie = authClearCookieFor(c);
    if (cookie) c.header("Set-Cookie", cookie);
    return c.body(null, 204);
  });
  mountWebAuthn(app); // passkeys: the routes answer only where a `passkeys` collection exists
  mountOAuth2Redirect(app);
  mountAuthFlows(app, { collection: authCollection, ctx });
  mountAuthExtra(app, { collection: authCollection, ctx });
}

export const auth: Plugin = {
  manifest: {
    name: "auth",
    version: "0.1.0",
    tier: "core",
    voidbase: "*",
    provides: ["auth@1"],
    collections: [SUPERUSERS, "_externalAuths", "_authOrigins", "_otps", "_mfas"],
  },
  apply(ctx: Kernel) {
    serve<Auth>(ctx, "auth@1", provider);
    mountRoutes(ctx.app);
  },
};
