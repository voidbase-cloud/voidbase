// OAuth2 (apis/record_auth_with_oauth2*.go): auth-with-oauth2 code exchange with PKCE, external-auth linking,
// record creation with createData and the collection's mappedFields, and the browser flow's /api/oauth2-redirect
// which hands {state, code} to the waiting realtime client through the change feed (topic "@oauth2").
import type { Context, Hono } from "hono";
import { recordAuthResponse } from "../auth-response";
import { requestHook } from "../hooks/runtime";
import { CollectionRef, HookRecord } from "../hooks/record";
import type { Collection } from "../collections/model";
import { ident, one, run, stmt } from "../db";
import { ApiError, badRequest, forbidden } from "../errors";
import { nowString, randomId, randomString } from "../ids";
import { hashPassword } from "../password";
import { createRecord, type RecordContext } from "../records/service";
import type { AppEnv, Row } from "../types";
import { fetchProviderUser, PROVIDER_DEFAULTS, type AuthUser, type Token } from "./providers";
import { hubActive, publishToClient } from "../realtime/hub-client";

export interface ProviderConfig { name: string; clientId: string; clientSecret?: string; authURL?: string; tokenURL?: string; userInfoURL?: string; displayName?: string; pkce?: boolean | null; extra?: Record<string, unknown> }
interface OAuth2Options { enabled?: boolean; providers?: ProviderConfig[]; mappedFields?: { id?: string; name?: string; username?: string; avatarURL?: string } }

export const oauth2Options = (c: Collection): OAuth2Options => ((c.options as Record<string, unknown>).oauth2 ?? {}) as OAuth2Options;
export function providerConfig(c: Collection, name: string): ProviderConfig | null {
  const p = (oauth2Options(c).providers ?? []).find((x) => x.name === name);
  if (!p) return null;
  const d = PROVIDER_DEFAULTS[name];
  return { ...p, displayName: p.displayName || d?.displayName || name, authURL: p.authURL || d?.authURL, tokenURL: p.tokenURL || d?.tokenURL, userInfoURL: p.userInfoURL || d?.userInfoURL, pkce: typeof p.pkce === "boolean" ? p.pkce : (d?.pkce ?? false) };
}
// a provider's extra.scopes (array) replaces the catalog default: Cloudflare's resource scopes are chosen per OAuth client
export const providerScopes = (p: ProviderConfig | string) => {
  const name = typeof p === "string" ? p : p.name;
  const extra = typeof p === "string" ? undefined : (p.extra?.scopes as unknown);
  if (Array.isArray(extra) && extra.every((s) => typeof s === "string")) return extra as string[];
  if (typeof extra === "string" && extra.trim()) return extra.split(/[\s,]+/).filter(Boolean);
  return PROVIDER_DEFAULTS[name]?.scopes ?? [];
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function s256Challenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
// golang.org/x/oauth2 AuthCodeURL: the parameters come out of url.Values.Encode(), i.e. sorted by key
export function buildAuthURL(p: ProviderConfig, state: string, extra: Record<string, string>): string {
  const u = new URL(p.authURL ?? "");
  const params: Record<string, string> = { response_type: "code", client_id: p.clientId, state, ...extra };
  const scopes = providerScopes(p);
  if (scopes.length) params.scope = scopes.join(" ");
  const encoded = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!).replace(/%20/g, "+")}`).join("&");
  return `${u.origin}${u.pathname}?${u.search ? u.search.slice(1) + "&" : ""}${encoded}`;
}

// oauth2.Config.Exchange with AuthStyleAutoDetect: client credentials in the Authorization header first, in the body second
async function fetchToken(p: ProviderConfig, code: string, redirectURL: string, codeVerifier: string): Promise<Token> {
  if (!p.tokenURL) throw new Error("missing tokenURL");
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectURL });
  if (p.pkce && codeVerifier) form.set("code_verifier", codeVerifier);
  const attempt = async (style: "header" | "body") => {
    const body = new URLSearchParams(form);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (style === "header") headers.authorization = "Basic " + btoa(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret ?? "")}`);
    else { body.set("client_id", p.clientId); body.set("client_secret", p.clientSecret ?? ""); }
    return fetch(p.tokenURL!, { method: "POST", headers, body });
  };
  let res = await attempt("header");
  if (res.status === 401 || res.status === 400) res = await attempt("body");
  const text = await res.text();
  if (!res.ok) throw new Error(`oauth2: cannot fetch token: ${res.status}\nResponse: ${text}`);
  let token: Token;
  try { token = JSON.parse(text) as Token; } catch { token = Object.fromEntries(new URLSearchParams(text)) as unknown as Token; if (token.expires_in) token.expires_in = Number(token.expires_in); }
  if (!token.access_token) throw new Error("oauth2: server response missing access_token");
  return token;
}

async function fetchAuthUser(p: ProviderConfig, token: Token): Promise<AuthUser> {
  const user = await fetchProviderUser({ name: p.name, clientId: p.clientId, clientSecret: p.clientSecret ?? "", userInfoURL: p.userInfoURL ?? "", extra: p.extra ?? {} }, token);
  if (p.name.startsWith("oidc") && !p.userInfoURL && token.id_token) { // audience check like PocketBase's id_token parser
    const aud = (user.rawUser as { aud?: unknown }).aud;
    if (!(aud === p.clientId || (Array.isArray(aud) && aud.includes(p.clientId)))) throw new Error("id_token audience mismatch");
  }
  return user;
}

// POST /api/collections/:collection/auth-with-oauth2
export async function authWithOAuth2(c: Context<AppEnv>, collection: Collection, ctx: RecordContext): Promise<Response> {
  const opts = oauth2Options(collection);
  if (!opts.enabled) throw forbidden("The collection is not configured to allow OAuth2 authentication.");
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { throw badRequest("An error occurred while loading the submitted data."); }
  const providerName = String(body.provider ?? "");
  const code = String(body.code ?? "");
  const errs: Record<string, { code: string; message: string; params?: Record<string, unknown> }> = {};
  if (!code) errs.code = { code: "validation_required", message: "Cannot be blank." };
  if (!providerName) errs.provider = { code: "validation_required", message: "Cannot be blank." };
  else if (!providerConfig(collection, providerName)) errs.provider = { code: "validation_invalid_provider", message: `Provider with name ${providerName} is missing or is not enabled.`, params: { name: providerName } };
  if (Object.keys(errs).length) throw new ApiError(400, "An error occurred while loading the submitted data.", errs);
  const provider = providerConfig(collection, providerName)!;
  const redirectURL = String(body.redirectURL ?? body.redirectUrl ?? "");
  let token: Token;
  try { token = await fetchToken(provider, code, redirectURL, String(body.codeVerifier ?? "")); } catch (err) { console.warn("voidbase: oauth2 token", err); throw badRequest("Failed to fetch OAuth2 token."); }
  let user: AuthUser;
  try { user = await fetchAuthUser(provider, token); } catch (err) { console.warn("voidbase: oauth2 user", err); throw badRequest("Failed to fetch OAuth2 user."); }

  const db = c.env.DB;
  const table = ident(collection.name);
  const fallback = ctx.auth && ctx.auth.collection.id === collection.id ? ctx.auth.row : null;
  let external = await one<Row>(db, "SELECT * FROM `_externalAuths` WHERE collectionRef = ? AND provider = ? AND providerId = ? LIMIT 1", [collection.id, providerName, user.id]);
  let row: Row | null = null;
  if (external) row = await one<Row>(db, `SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [external.recordRef]);
  else if (fallback) row = fallback;
  else if (user.email) row = await one<Row>(db, `SELECT * FROM ${table} WHERE email = ? LIMIT 1`, [user.email]);
  const isNew = !row;
  return requestHook("onRecordAuthWithOAuth2Request", c, collection.name, { collection: new CollectionRef(collection), providerName, providerClient: null, oAuth2User: user, createData: (body.createData as Record<string, unknown>) ?? {}, record: row ? HookRecord.fromRow(collection, row) : null, isNewRecord: isNew }, async (ev) => {

    try {
      if (!row) {
        if (collection.name === "_superusers") throw new Error("superusers are not allowed to sign-up with OAuth2");
        const payload: Record<string, unknown> = { ...((ev.createData as Record<string, unknown>) ?? {}) };
        if (!payload.email) payload.email = user.email;
        const mf = opts.mappedFields ?? {};
        if (mf.id && !(mf.id in payload)) payload[mf.id] = user.id;
        if (mf.name && !(mf.name in payload)) payload[mf.name] = user.name;
        if (mf.username && !(mf.username in payload) && user.username && canAssignUsername(collection, user.username)) payload[mf.username] = user.username;
        if (mf.avatarURL && !(mf.avatarURL in payload) && user.avatarURL) {
          const f = collection.fields.find((x) => x.name === mf.avatarURL);
          if (f && f.type !== "file") payload[mf.avatarURL] = user.avatarURL; // file avatars need a fetch through the record form; kept for auth.providers
        }
        if (!payload.id) payload.id = randomId();
        // forms/record_upsert.go: an OAuth2 sign-up without a password gets a random one
        if (!payload.password) { payload.password = randomString(30); payload.passwordConfirm = payload.password; }
        await createRecord({ ...ctx, request: { ...ctx.request, context: "oauth2" } }, collection, payload as never, {} as never);
        row = await one<Row>(db, `SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [payload.id]);
        if (!row) throw new Error("failed to create OAuth2 auth record");
        if (row.email === user.email && !row.verified) { await run(db, `UPDATE ${table} SET verified = 1, updated = ? WHERE id = ?`, [nowString(), row.id]); row.verified = 1; }
      } else {
        const sets: string[] = []; const params: unknown[] = [];
        const isLogged = fallback !== null && fallback.id === row.id;
        const verified = !!row.verified && row.verified !== 0 && row.verified !== "0" && row.verified !== "false";
        if (!isLogged && !verified) { sets.push("password = ?", "tokenKey = ?"); params.push(await hashPassword(randomString(30)), randomString(50)); }
        if (!verified) { await run(db, "DELETE FROM `_externalAuths` WHERE collectionRef = ? AND recordRef = ?", [collection.id, row.id]); external = null; }
        if (!row.email && user.email) { sets.push("email = ?"); params.push(user.email); row.email = user.email; }
        if (!verified && (!row.email || row.email === user.email)) { sets.push("verified = 1"); row.verified = 1; }
        if (sets.length) { sets.push("updated = ?"); params.push(nowString()); await run(db, `UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, [...params, row.id]); }
      }
      if (!external) {
        const now = nowString();
        await run(db, "INSERT INTO `_externalAuths` (id, collectionRef, recordRef, provider, providerId, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomId(), collection.id, row.id, providerName, user.id, now, now]);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      console.warn("voidbase: oauth2 submit", err);
      throw badRequest("Failed to authenticate.");
    }
    const fresh = (await one<Row>(db, `SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [row.id])) ?? row;
    const meta: Record<string, unknown> = { ...user, avatarUrl: user.avatarURL, isNew }; // avatarUrl: deprecated alias PocketBase still returns

  return recordAuthResponse(c, ctx, collection, fresh, "oauth2", { meta: sortKeys(meta), body });
  });
}

const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
function canAssignUsername(collection: Collection, username: string): boolean {
  const f = collection.fields.find((x) => x.name === oauth2Options(collection).mappedFields?.username);
  if (!f || f.type !== "text") return false;
  const pattern = String((f as { pattern?: string }).pattern ?? "");
  if (pattern) { try { if (!new RegExp(pattern).test(username)) return false; } catch { /* keep */ } }
  const min = Number((f as { min?: number }).min ?? 0), max = Number((f as { max?: number }).max ?? 0);
  if (min && username.length < min) return false;
  if (max && username.length > max) return false;
  return true;
}

// GET|POST /api/oauth2-redirect: the provider sends the browser back here; we forward {state, code, error} to the
// realtime client whose id is the state (through the change feed, so any isolate can deliver it) and redirect
// to the panel's "you can close this window" page.
const FAILURE = "../_/#/auth/oauth2-redirect-failure", SUCCESS = "../_/#/auth/oauth2-redirect-success";
export function mountOAuth2Redirect(app: Hono<AppEnv>) {
  const handler = async (c: Context<AppEnv>) => {
    const status = c.req.method === "GET" ? 307 : 303;
    let data: { state: string; code: string; error?: string } = { state: "", code: "" };
    if (c.req.method === "POST") {
      const ct = c.req.header("content-type") ?? "";
      const body = (ct.includes("json") ? await c.req.json().catch(() => ({})) : Object.fromEntries((await c.req.formData().catch(() => new FormData())).entries())) as Record<string, unknown>;
      data = { state: String(body.state ?? ""), code: String(body.code ?? ""), error: body.error ? String(body.error) : undefined };
    } else data = { state: c.req.query("state") ?? "", code: c.req.query("code") ?? "", error: c.req.query("error") || undefined };
    if (!data.state) return c.redirect(FAILURE, status);
    const client = await one<{ subscriptions: string }>(c.env.DB, "SELECT subscriptions FROM `_realtime_clients` WHERE id = ?", [data.state]);
    const subs = client ? (JSON.parse(client.subscriptions || "[]") as string[]) : [];
    if (!client || !subs.includes("@oauth2")) return c.redirect(FAILURE, status);
    const payload: Record<string, unknown> = { state: data.state, code: data.code };
    if (data.error) payload.error = data.error;
    // the stream drops its @oauth2 subscription itself once it has delivered the message
    if (hubActive()) await publishToClient(data.state, "@oauth2", payload);
    else await stmt(c.env.DB, "INSERT INTO `_changes` (collection, recordId, action, data, created) VALUES ('@oauth2', ?, 'message', ?, ?)", [data.state, JSON.stringify(payload), nowString()]).run();
    if (data.error || !data.code) return c.redirect(FAILURE, status);
    return c.redirect(SUCCESS, status);
  };
  app.get("/api/oauth2-redirect", handler);
  app.post("/api/oauth2-redirect", handler);
}
