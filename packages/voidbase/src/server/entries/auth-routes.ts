// `@voidbase-cloud/voidbase/auth-routes`: the auth routes' handlers, for the plugin that mounts them.
//
// plugins/auth.ts is the only importer of any of this, and what it does is mount: the four `/api/collections/:c/*`
// auth routes, the OAuth2 redirect, the extra flows (verification, password reset, email change, OTP, impersonate)
// and the passkey routes. The handlers themselves stay in the core, because they are the auth *implementation* the
// `auth@1` provider exposes and half the core reads them back (the panel guard, the hooks, the SDK's typed client).
//
// `mountWebAuthn` is here and there is no `/passkeys` entry, which is the same fact said twice. Its login handler
// finishes by building the request's record context through the slot the application fills, so it cannot stand on a
// consumer's own router — it works only mounted by the plugin that voidbase's own app loads. Published under this
// name it is what it is: one of the routes the auth plugin mounts, not a feature a consumer bolts on.
//
// `isSuperuserRecord` is ../auth.ts's own `isSuperuser` under a name that says which of the two it is. This one is
// the shipped auth plugin's answer — the record's collection is `_superusers` — and it is what that plugin hands
// the `auth@1` slot. What every other plugin wants is `isSuperuser` from `@voidbase-cloud/voidbase/sdk`, which asks
// whichever plugin provides `auth@1` and so is right on an instance whose auth is somebody else's. The two are the
// same answer only while the shipped plugin is the provider, which is exactly what a plugin package cannot assume.
export { authMethods, authRefresh, authWithPassword, findAuthRecordByToken, isSuperuser as isSuperuserRecord, tokenFromRequest } from "../auth";
export { AUTH_CLEAR_PATH, authClearCookieFor } from "../auth-cookie";
export { mountAuthExtra } from "../auth-extra";
export { mountAuthFlows } from "../auth-flows";
export { authWithOAuth2, mountOAuth2Redirect } from "../oauth2";
export { mountWebAuthn } from "../webauthn";
