// Passkeys for the starter: the same four routes its Go backend (pb/webauthn/webauthn.go, go-webauthn) exposes,
// implemented with @simplewebauthn/server on Workers. Same request/response contract, same error strings.
// Credentials live in the app's `passkeys` collection (user, credential_id, credentials) exactly like the Go code;
// the pending challenge lives in _params (the Go version keeps it in memory, which a Worker cannot rely on).
import type { Context, Hono } from "hono";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { recordAuthResponse } from "./auth-response";
import { loadCollections } from "./collections/model";
import { all, ident, one, run } from "./db";
import { nowString, randomId } from "./ids";
import { loadSettings } from "./settings";
import type { AppEnv, Row } from "./types";

const RESPONSES = {
  failed: "Failed to authenticate",
  reg_error: "Failed to register",
  login_error: "Failed to login",
  reg_success: "Successfully registered",
  cred_error: "Failed to save credentials",
};
const SESSION_TTL_MS = 5 * 60 * 1000;

type Transport = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";
interface StoredCredential { id: string; publicKey: string; counter: number; transports?: Transport[]; deviceType?: string; backedUp?: boolean }

const b64url = {
  encode: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (ch) => ch.charCodeAt(0)),
};
const b64std = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

// RP settings: PocketBase's Meta.AppURL when configured, otherwise the origin the browser is talking to.
async function relyingParty(c: Context<AppEnv>) {
  const settings = await loadSettings(c.env.DB);
  const meta = (settings as { meta?: { appURL?: string; appName?: string } }).meta ?? {};
  const configured = meta.appURL && !/^https?:\/\/localhost:8090\/?$/.test(meta.appURL) ? meta.appURL.replace(/\/$/, "") : "";
  const origin = configured || c.req.header("Origin") || new URL(c.req.url).origin;
  return { origin, rpID: new URL(origin).hostname, rpName: meta.appName || "voidbase" };
}

async function findUser(db: D1Database, usernameOrEmail: string): Promise<Row | null> {
  const users = (await loadCollections(db)).get("users");
  if (!users) return null;
  const hasUsername = users.fields.some((f) => f.name === "username");
  const sql = hasUsername ? `SELECT * FROM ${ident("users")} WHERE username = ?1 OR email = ?1 LIMIT 1` : `SELECT * FROM ${ident("users")} WHERE email = ?1 LIMIT 1`;
  return one<Row>(db, sql, [usernameOrEmail]);
}

async function credentialsOf(db: D1Database, userId: string): Promise<{ row: Row; cred: StoredCredential }[]> {
  const rows = await all<Row>(db, `SELECT * FROM ${ident("passkeys")} WHERE user = ?`, [userId]);
  const out: { row: Row; cred: StoredCredential }[] = [];
  for (const row of rows) {
    try {
      const cred = (typeof row.credentials === "string" ? JSON.parse(row.credentials) : row.credentials) as StoredCredential;
      if (cred && cred.id && cred.publicKey) out.push({ row, cred });
    } catch { /* not ours */ }
  }
  return out;
}

async function saveCredential(db: D1Database, userId: string, cred: StoredCredential) {
  const credId = b64std(b64url.decode(cred.id)); // the Go code stores base64.StdEncoding of the raw id
  const existing = await one<Row>(db, `SELECT id FROM ${ident("passkeys")} WHERE credential_id = ? LIMIT 1`, [credId]);
  const now = nowString();
  if (existing) await run(db, `UPDATE ${ident("passkeys")} SET credentials = ?, updated = ? WHERE id = ?`, [JSON.stringify(cred), now, existing.id]);
  else await run(db, `INSERT INTO ${ident("passkeys")} (id, user, label, credential_id, credentials, created, updated) VALUES (?, ?, '', ?, ?, ?, ?)`, [randomId(), userId, credId, JSON.stringify(cred), now, now]);
}

async function putSession(db: D1Database, userId: string, challenge: string) {
  const now = nowString();
  await run(db, "INSERT OR REPLACE INTO `_params` (id, value, created, updated) VALUES (?, ?, ?, ?)", [`webauthn:session:${userId}`, JSON.stringify({ challenge, expires: Date.now() + SESSION_TTL_MS }), now, now]);
}
async function takeSession(db: D1Database, userId: string): Promise<string | null> {
  const row = await one<{ value: string }>(db, "SELECT value FROM `_params` WHERE id = ?", [`webauthn:session:${userId}`]);
  if (!row) return null;
  await run(db, "DELETE FROM `_params` WHERE id = ?", [`webauthn:session:${userId}`]);
  const s = JSON.parse(row.value) as { challenge: string; expires: number };
  return s.expires > Date.now() ? s.challenge : null;
}

export function mountWebAuthn(app: Hono<AppEnv>) {
  app.get("/api/webauthn/registration-options", async (c) => {
    const user = await findUser(c.env.DB, c.req.query("usernameOrEmail") ?? "");
    if (!user) return c.json(RESPONSES.failed, 400);
    try {
      const rp = await relyingParty(c);
      const existing = await credentialsOf(c.env.DB, String(user.id));
      const options = await generateRegistrationOptions({
        rpName: rp.rpName, rpID: rp.rpID,
        userID: new TextEncoder().encode(String(user.id)),
        userName: String(user.username || user.email || user.id),
        userDisplayName: String(user.name ?? ""),
        excludeCredentials: existing.map((e) => ({ id: e.cred.id, transports: e.cred.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      await putSession(c.env.DB, String(user.id), options.challenge);
      return c.json({ publicKey: options });
    } catch (err) {
      console.error("voidbase: webauthn registration-options", err);
      return c.json(RESPONSES.reg_error, 500);
    }
  });

  app.post("/api/webauthn/register", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const user = await findUser(c.env.DB, String(body.usernameOrEmail ?? ""));
    if (!user) return c.json(RESPONSES.failed, 400);
    try {
      const rp = await relyingParty(c);
      const challenge = await takeSession(c.env.DB, String(user.id));
      if (!challenge) return c.json(RESPONSES.reg_error, 500);
      const { usernameOrEmail: _u, ...response } = body;
      const verification = await verifyRegistrationResponse({ response: response as never, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false });
      if (!verification.verified || !verification.registrationInfo) return c.json(RESPONSES.reg_error, 500);
      const info = verification.registrationInfo;
      const cred: StoredCredential = {
        id: info.credential.id, publicKey: b64url.encode(info.credential.publicKey), counter: info.credential.counter,
        transports: info.credential.transports as Transport[] | undefined, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
      };
      try { await saveCredential(c.env.DB, String(user.id), cred); } catch (err) { console.error("voidbase: webauthn save", err); return c.json(RESPONSES.cred_error, 500); }
      return c.json(RESPONSES.reg_success);
    } catch (err) {
      console.error("voidbase: webauthn register", err);
      return c.json(RESPONSES.reg_error, 500);
    }
  });

  app.get("/api/webauthn/login-options", async (c) => {
    const user = await findUser(c.env.DB, c.req.query("usernameOrEmail") ?? "");
    if (!user) return c.json(RESPONSES.failed, 400);
    try {
      const rp = await relyingParty(c);
      const creds = await credentialsOf(c.env.DB, String(user.id));
      const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred", allowCredentials: creds.map((e) => ({ id: e.cred.id, transports: e.cred.transports })) });
      await putSession(c.env.DB, String(user.id), options.challenge);
      return c.json({ publicKey: options });
    } catch (err) {
      console.error("voidbase: webauthn login-options", err);
      return c.json(RESPONSES.login_error, 500);
    }
  });

  app.post("/api/webauthn/login", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const user = await findUser(c.env.DB, String(body.usernameOrEmail ?? ""));
    if (!user) return c.json(RESPONSES.failed, 400);
    try {
      const rp = await relyingParty(c);
      const challenge = await takeSession(c.env.DB, String(user.id));
      if (!challenge) return c.json(RESPONSES.login_error, 500);
      const { usernameOrEmail: _u, ...response } = body;
      const match = (await credentialsOf(c.env.DB, String(user.id))).find((e) => e.cred.id === response.id);
      if (!match) return c.json(RESPONSES.login_error, 500);
      const verification = await verifyAuthenticationResponse({
        response: response as never, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false,
        credential: { id: match.cred.id, publicKey: b64url.decode(match.cred.publicKey), counter: match.cred.counter, transports: match.cred.transports },
      });
      if (!verification.verified) return c.json(RESPONSES.login_error, 500);
      try { await saveCredential(c.env.DB, String(user.id), { ...match.cred, counter: verification.authenticationInfo.newCounter }); } catch { return c.json(RESPONSES.cred_error, 500); }
      const users = (await loadCollections(c.env.DB)).get("users")!;
      const { recordContextFor } = await import("./app");
      return recordAuthResponse(c, await recordContextFor(c), users, user, "passkey", { body });
    } catch (err) {
      console.error("voidbase: webauthn login", err);
      return c.json(RESPONSES.login_error, 500);
    }
  });
}
