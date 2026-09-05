import type { Context } from "hono";
import { findCollection, isAuth, option, SUPERUSERS, type Collection } from "./collections/model";
import { one } from "./db";
import { ident } from "./db";
import { ApiError, badRequest, forbidden, unauthorized, V, validationFailed, type FieldErrors } from "./errors";
import { decodeJWT, signJWT, verifyJWT } from "./jwt";
import { verifyPassword } from "./password";
import { recordToJSON } from "./records/json";
import { buildAuthURL, providerConfig, s256Challenge } from "./oauth2";
import catalog from "./collections/oauth2-providers.json";
import { randomString } from "./ids";
import { recordAuthResponse } from "./auth-response";
import type { AppEnv, AuthRecord, Row } from "./types";

export function tokenFromRequest(req: Request): string {
  const h = req.headers.get("Authorization") ?? "";
  return /^bearer /i.test(h) ? h.slice(7) : h;
}

// Resolve the auth record for a token: decode, load collection + record, verify with tokenKey + collection secret.
export async function findAuthRecordByToken(db: D1Database, token: string, type = "auth"): Promise<AuthRecord | null> {
  if (!token) return null;
  const claims = decodeJWT(token);
  if (!claims || claims.type !== type || typeof claims.id !== "string" || typeof claims.collectionId !== "string") return null;
  const collection = await findCollection(db, claims.collectionId);
  if (!collection || !isAuth(collection)) return null;
  const row = await one(db, `SELECT * FROM ${ident(collection.name)} WHERE id = ? LIMIT 1`, [claims.id]);
  if (!row) return null;
  // each token type is signed with its own collection secret (core/record_tokens.go)
  const optionKey = ({ auth: "authToken", verification: "verificationToken", passwordReset: "passwordResetToken", emailChange: "emailChangeToken", file: "fileToken" } as Record<string, string>)[type] ?? "authToken";
  const secret = option<string>(collection, `${optionKey}.secret`, "");
  const verified = await verifyJWT(token, String(row.tokenKey ?? "") + secret);
  return verified ? { collection, row } : null;
}

export async function loadAuth(c: Context<AppEnv>): Promise<AuthRecord | null> {
  const token = tokenFromRequest(c.req.raw);
  return token ? findAuthRecordByToken(c.env.DB, token) : null;
}

export const isSuperuser = (auth: AuthRecord | null | undefined) => !!auth && auth.collection.name === SUPERUSERS;

export function requireAuth(c: Context<AppEnv>): AuthRecord {
  const auth = c.get("auth");
  if (!auth) throw unauthorized("The request requires valid record authorization token.");
  return auth;
}

export function requireSuperuser(c: Context<AppEnv>): AuthRecord {
  const auth = c.get("auth");
  if (!auth) throw unauthorized("The request requires valid record authorization token.");
  if (!isSuperuser(auth)) throw forbidden("The authorized record is not allowed to perform this action.");
  return auth;
}

export async function newAuthToken(auth: AuthRecord, refreshable = true, durationOverride?: number): Promise<string> {
  const secret = option<string>(auth.collection, "authToken.secret", "");
  const duration = durationOverride ?? option<number>(auth.collection, "authToken.duration", 604800);
  const key = String(auth.row.tokenKey ?? "") + secret;
  if (!key) throw new ApiError(500, "Missing signing key.");
  return signJWT({ collectionId: auth.collection.id, id: String(auth.row.id), refreshable, type: "auth" }, key, duration);
}

export async function authResponse(auth: AuthRecord, meta?: unknown) {
  const token = await newAuthToken(auth);
  const record = recordToJSON(auth.collection, auth.row, { auth, own: true });
  return meta === undefined ? { record, token } : { meta, record, token };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const ct = c.req.header("content-type") ?? "";
  try {
    if (ct.includes("application/json")) return (await c.req.json()) ?? {};
    if (ct.includes("form")) return Object.fromEntries((await c.req.formData()).entries());
    const text = await c.req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("Failed to read the request body.");
  }
}

// POST /api/collections/:collection/auth-with-password
export async function authWithPassword(c: Context<AppEnv>, collection: Collection) {
  if (!isAuth(collection)) throw c.get("auth") ? forbidden() : unauthorized("The request requires valid record authorization token.");
  if (!option<boolean>(collection, "passwordAuth.enabled", false)) {
    throw forbidden("The collection is not configured to allow password authentication.");
  }
  const body = await readBody(c);
  const identity = String(body.identity ?? "");
  const password = String(body.password ?? "");
  const identityField = body.identityField ? String(body.identityField) : "";
  const errors: FieldErrors = {};
  if (!identity) errors.identity = V.required;
  else if (identity.length > 255) errors.identity = V.length(1, 255);
  if (!password) errors.password = V.required;
  else if (password.length > 255) errors.password = V.length(1, 255);
  const identityFields = option<string[]>(collection, "passwordAuth.identityFields", ["email"]);
  if (identityField && !identityFields.includes(identityField)) {
    errors.identityField = { code: "validation_in_invalid", message: "Must be a valid value." };
  }
  if (Object.keys(errors).length) throw validationFailed(errors);

  let row: Row | null = null;
  const candidates = identityField ? [identityField] : identityFields;
  for (const name of candidates) {
    if (name === "email" && !EMAIL_RE.test(identity)) continue;
    row = await one(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE ${ident(name)} = ? LIMIT 1`, [identity]);
    if (row) break;
  }
  const ok = row ? await verifyPassword(password, String(row.password ?? "")) : await dummyPasswordCheck();
  if (!row || !ok) throw badRequest("Failed to authenticate.");
  const { recordContextFor } = await import("./app");
  const ctx = await recordContextFor(c);
  return recordAuthResponse(c, { ...ctx, request: { ...ctx.request, context: "password" } }, collection, row, "password", { body });
}

// Burn roughly the same time as a real check so missing accounts are not distinguishable by timing.
async function dummyPasswordCheck(): Promise<false> {
  await verifyPassword("dummy", "$2a$10$KBcKN2Yv4i5cs/Q1I.nfkeBXf1RqxyRmiPJPLHxCXDqmlt6SlP4Ea");
  return false;
}

// POST /api/collections/:collection/auth-refresh
export async function authRefresh(c: Context<AppEnv>, collection: Collection) {
  const auth = c.get("auth");
  if (!auth || auth.collection.id !== collection.id) {
    throw unauthorized("The request requires valid record authorization token.");
  }
  const { recordContextFor } = await import("./app");
  return recordAuthResponse(c, await recordContextFor(c), collection, auth.row, "", {});
}

// GET /api/collections/:collection/auth-methods
const providerLogo = (name: string) => (catalog as { name: string; logo: string }[]).find((p) => p.name === name)?.logo ?? "";

export async function authMethods(c: Context<AppEnv>, collection: Collection) {
  if (!isAuth(collection)) throw badRequest("The collection is not configured to allow authentication.");
  const identityFields = option<string[]>(collection, "passwordAuth.identityFields", ["email"]);
  const mfaEnabled = option<boolean>(collection, "mfa.enabled", false);
  const otpEnabled = option<boolean>(collection, "otp.enabled", false);
  const oauth2Enabled = option<boolean>(collection, "oauth2.enabled", false);
  const providers: Record<string, unknown>[] = [];
  if (oauth2Enabled) {
    for (const cfg of option<{ name: string }[]>(collection, "oauth2.providers", [])) {
      const p = providerConfig(collection, cfg.name);
      if (!p || !p.authURL || !p.tokenURL) continue; // PocketBase skips providers it cannot init
      const info: Record<string, unknown> = { name: p.name, displayName: p.displayName, logo: providerLogo(p.name), state: randomString(30), authURL: "", authUrl: "", codeVerifier: "", codeChallenge: "", codeChallengeMethod: "" };
      const extra: Record<string, string> = {};
      if (p.name === "apple") extra.response_mode = "form_post";
      if (p.pkce) {
        info.codeVerifier = randomString(43);
        info.codeChallenge = await s256Challenge(String(info.codeVerifier));
        info.codeChallengeMethod = "S256";
        extra.code_challenge = String(info.codeChallenge); extra.code_challenge_method = "S256";
      }
      info.authURL = buildAuthURL(p, String(info.state), extra) + "&redirect_uri="; // empty redirect_uri so clients can append theirs
      info.authUrl = info.authURL;
      providers.push(info);
    }
  }
  const legacy = oauth2Enabled ? providers.map((p) => ({ ...p, logo: "" })) : null;
  return c.json({
    password: { identityFields, enabled: option<boolean>(collection, "passwordAuth.enabled", false) },
    oauth2: { providers, enabled: oauth2Enabled },
    mfa: { enabled: mfaEnabled, duration: mfaEnabled ? option<number>(collection, "mfa.duration", 0) : 0 },
    otp: { enabled: otpEnabled, duration: otpEnabled ? option<number>(collection, "otp.duration", 0) : 0 },
    // deprecated fields PocketBase still returns
    authProviders: legacy,
    usernamePassword: identityFields.includes("username"),
    emailPassword: identityFields.includes("email"),
  });
}
