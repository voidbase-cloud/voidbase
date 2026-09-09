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
import type { Context, Hono } from "hono";
import { authMethods, authRefresh, authWithPassword, findAuthRecordByToken, isSuperuser, tokenFromRequest } from "../auth";
import { mountAuthExtra } from "../auth-extra";
import { mountAuthFlows } from "../auth-flows";
import type { Field } from "../collections/fields";
import { findCollection, isAuth, listCollections, SUPERUSERS } from "../collections/model";
import { notFound } from "../errors";
import type { Auth } from "../interfaces";
import { serve, type Kernel } from "../kernel";
import { authWithOAuth2, mountOAuth2Redirect } from "../oauth2";
import type { AppEnv } from "../types";
import { mountWebAuthn } from "../webauthn";
import type { Plugin } from "./manifest";

/** what every auth record answers to in a rule, whatever its collection declares (filter/compile.ts asks) */
const STATIC: Pick<Field, "name" | "type">[] = [
  { name: "id", type: "text" }, { name: "collectionId", type: "text" }, { name: "collectionName", type: "text" },
  { name: "email", type: "email" }, { name: "emailVisibility", type: "bool" }, { name: "verified", type: "bool" },
];

export const provider: Auth = {
  authenticate(request, env) { const token = tokenFromRequest(request); return token ? findAuthRecordByToken(env.DB, token) : Promise.resolve(null); },
  fromToken: (token, env, type = "auth") => findAuthRecordByToken(env.DB, token, type),
  schema: () => STATIC.map((f) => ({ ...f })),
  collections: async (env) => (await listCollections(env.DB)).filter(isAuth).map((c) => c.name),
  isSuperuser,
};

function mountRoutes(app: Hono<AppEnv>) {
  const collection = async (c: Context<AppEnv>) => { const coll = await findCollection(c.env.DB, c.req.param("collection") ?? ""); if (!coll) throw notFound("Missing collection context."); return coll; };
  const authCollection = async (c: Context<AppEnv>) => { const coll = await collection(c); if (!isAuth(coll)) throw notFound("Missing or invalid auth collection context."); return coll; };
  // the record context is the app's, and the app imports this module: asked for at request time, as ../auth.ts does
  const ctx = async (c: Context<AppEnv>) => (await import("../app")).recordContextFor(c);
  app.post("/api/collections/:collection/auth-with-password", async (c) => authWithPassword(c, await collection(c)));
  app.post("/api/collections/:collection/auth-with-oauth2", async (c) => authWithOAuth2(c, await authCollection(c), await ctx(c)));
  app.post("/api/collections/:collection/auth-refresh", async (c) => authRefresh(c, await collection(c)));
  app.get("/api/collections/:collection/auth-methods", async (c) => authMethods(c, await collection(c)));
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
