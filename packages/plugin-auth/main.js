import { authMethods, authRefresh, authWithPassword, findAuthRecordByToken, isSuperuserRecord as isSuperuser, tokenFromRequest } from "@voidbase-cloud/voidbase/auth-routes";
import { AUTH_CLEAR_PATH, authClearCookieFor } from "@voidbase-cloud/voidbase/auth-routes";
import { mountAuthExtra } from "@voidbase-cloud/voidbase/auth-routes";
import { mountAuthFlows } from "@voidbase-cloud/voidbase/auth-routes";
import { findCollection, isAuth, listCollections, SUPERUSERS } from "@voidbase-cloud/voidbase/sdk";
import { notFound } from "@voidbase-cloud/voidbase/sdk";
import { serve } from "@voidbase-cloud/voidbase/kernel";
import { authWithOAuth2, mountOAuth2Redirect } from "@voidbase-cloud/voidbase/auth-routes";
import { recordContextFor } from "@voidbase-cloud/voidbase/record-slot";
import { mountWebAuthn } from "@voidbase-cloud/voidbase/auth-routes";
/** what every auth record answers to in a rule, whatever its collection declares (filter/compile.ts asks) */
const STATIC = [
  { name: "id", type: "text" }, { name: "collectionId", type: "text" }, { name: "collectionName", type: "text" },
  { name: "email", type: "email" }, { name: "emailVisibility", type: "bool" }, { name: "verified", type: "bool" },
];
export const provider = {
  authenticate(request, env) { const token = tokenFromRequest(request, env); return token ? findAuthRecordByToken(env.DB, token) : Promise.resolve(null); },
  fromToken: (token, env, type = "auth") => findAuthRecordByToken(env.DB, token, type),
  schema: () => STATIC.map((f) => ({ ...f })),
  collections: async (env) => (await listCollections(env.DB)).filter(isAuth).map((c) => c.name),
  isSuperuser,
};
function mountRoutes(app) {
  const collection = async (c) => { const coll = await findCollection(c.env.DB, c.req.param("collection") ?? ""); if (!coll)
    throw notFound("Missing collection context."); return coll; };
  const authCollection = async (c) => { const coll = await collection(c); if (!isAuth(coll))
    throw notFound("Missing or invalid auth collection context."); return coll; };
  // the record context is the app's, and the app imports this module, so it is asked for through the core's slot
  // (../record-slot.ts) rather than by importing the app: built per request, as the record routes build it
  const ctx = (c) => recordContextFor(c);
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
    if (cookie)
      c.header("Set-Cookie", cookie);
    return c.body(null, 204);
  });
  mountWebAuthn(app); // passkeys: the routes answer only where a `passkeys` collection exists
  mountOAuth2Redirect(app);
  mountAuthFlows(app, { collection: authCollection, ctx });
  mountAuthExtra(app, { collection: authCollection, ctx });
}
const auth = {
  apply(ctx) {
    serve(ctx, "auth@1", provider);
    mountRoutes(ctx.app);
  },
};

// what the plugin does; its declaration is manifest.json beside this file, which the instance reads
export default auth;
