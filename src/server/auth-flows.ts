// Email-driven auth flows (apis/record_auth_{verification,password_reset,email_change}_{request,confirm}.go):
// request endpoints always answer 204 (unknown emails and resend limits are hidden, like PocketBase), confirm
// endpoints validate the signed token and apply the change through the record service so hooks and realtime fire.
import { requestHook } from "./hooks/runtime";
import { CollectionRef, HookRecord } from "./hooks/record";
import type { Context, Hono } from "hono";
import { findAuthRecordByToken } from "./auth";
import { verifyPassword } from "./password";
import type { Collection } from "./collections/model";
import { ident, one, run } from "./db";
import { ApiError, badRequest, unauthorized, forbidden } from "./errors";
import { nowString, randomString } from "./ids";
import { sendRecordChangeEmail, sendRecordPasswordReset, sendRecordVerification } from "./mail";
import { updateRecord, type RecordContext } from "./records/service";
import type { AppEnv, Row } from "./types";

type Fe = { code: string; message: string; params?: Record<string, unknown> };
const REQUIRED: Fe = { code: "validation_required", message: "Cannot be blank." };
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const validationFailed = (errs: Record<string, Fe>) => new ApiError(400, "An error occurred while validating the submitted data.", Object.fromEntries(Object.entries(errs).sort(([a], [b]) => (a < b ? -1 : 1))) as never);
const RESEND_TTL_MS = 2 * 60 * 1000;

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try { const v = await c.req.json(); if (!v || typeof v !== "object") throw new Error(); return v as Record<string, unknown>; }
  catch { throw badRequest("An error occurred while loading the submitted data."); }
}
const unverifiedClaims = (token: string): Record<string, unknown> => { try { const p = token.split(".")[1] ?? ""; return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>; } catch { return {}; } };

// PocketBase keeps the "already requested" flag in memory for 2 minutes; here it lives in _params so every isolate sees it
async function resendLimited(db: D1Database, key: string): Promise<boolean> {
  const row = await one<{ value: string }>(db, "SELECT value FROM `_params` WHERE id = ?", [key]);
  if (!row) return false;
  if (Number(row.value) > Date.now()) return true;
  await run(db, "DELETE FROM `_params` WHERE id = ?", [key]);
  return false;
}
const markResend = (db: D1Database, key: string) => run(db, "INSERT OR REPLACE INTO `_params` (id, value, created, updated) VALUES (?, ?, ?, ?)", [key, String(Date.now() + RESEND_TTL_MS), nowString(), nowString()]);
const clearResend = (db: D1Database, key: string) => run(db, "DELETE FROM `_params` WHERE id = ?", [key]);

const superCtx = (ctx: RecordContext): RecordContext => ({ ...ctx, superuser: true, hookEvent: undefined, request: { ...ctx.request, context: "default" } });
const passwordEnabled = (c: Collection) => ((c.options as Record<string, unknown>).passwordAuth as { enabled?: boolean } | undefined)?.enabled !== false;
const passwordMin = (c: Collection) => { const f = c.fields.find((x) => x.name === "password") as { min?: number } | undefined; return f?.min && f.min > 0 ? f.min : 1; };

export function mountAuthFlows(app: Hono<AppEnv>, deps: { collection: (c: Context<AppEnv>) => Promise<Collection>; ctx: (c: Context<AppEnv>) => Promise<RecordContext> }) {
  app.post("/api/collections/:collection/request-verification", async (c) => {
    const collection = await deps.collection(c);
    if (collection.name === "_superusers") throw badRequest("All superusers are verified by default.");
    const body = await readBody(c);
    const email = String(body.email ?? "");
    if (!email) throw validationFailed({ email: REQUIRED });
    if (email.length > 255) throw validationFailed({ email: { code: "validation_length_out_of_range", message: "The length must be between 1 and 255.", params: { max: 255, min: 1 } } });
    if (!isEmail(email)) throw validationFailed({ email: { code: "validation_is_email", message: "Must be a valid email address." } });
    const row = await one<Row>(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE email = ? LIMIT 1`, [email]);
    if (!row) return c.body(null, 204);
    const key = `@limitVerificationEmail_${collection.id}${row.id}`;
    if (!row.verified && (await resendLimited(c.env.DB, key))) return c.body(null, 204);
    return requestHook("onRecordRequestVerificationRequest", c, collection.name, { collection: new CollectionRef(collection), record: HookRecord.fromRow(collection, row) }, async () => {
      if (row.verified) return c.body(null, 204);
      c.executionCtx.waitUntil((async () => {
        try { await sendRecordVerification(c.env.DB, collection, row); await markResend(c.env.DB, key); } catch (err) { console.error("voidbase: failed to send verification email", err); }
      })());
      return c.body(null, 204);
    });
  });

  app.post("/api/collections/:collection/confirm-verification", async (c) => {
    const collection = await deps.collection(c);
    if (collection.name === "_superusers") throw badRequest("All superusers are verified by default.");
    const body = await readBody(c);
    const token = String(body.token ?? "");
    if (!token) throw validationFailed({ token: REQUIRED });
    const claims = unverifiedClaims(token);
    if (!claims.email) throw validationFailed({ token: { code: "validation_invalid_token_claims", message: "Missing email token claim." } });
    const auth = await findAuthRecordByToken(c.env.DB, token, "verification");
    if (!auth) throw validationFailed({ token: { code: "validation_invalid_token", message: "Invalid or expired token." } });
    if (auth.collection.id !== collection.id) throw validationFailed({ token: { code: "validation_token_collection_mismatch", message: "The provided token is for different auth collection." } });
    if (String(auth.row.email ?? "") !== String(claims.email)) throw validationFailed({ token: { code: "validation_token_email_mismatch", message: "The record email doesn't match with the requested token claims." } });
    return requestHook("onRecordConfirmVerificationRequest", c, collection.name, { collection: new CollectionRef(collection), record: HookRecord.fromRow(collection, auth.row) }, async () => {
      if (!auth.row.verified) {
        const patch: Record<string, unknown> = { verified: true };
        if (!passwordEnabled(collection)) { const pw = randomString(30); patch.password = pw; patch.passwordConfirm = pw; }
        try { await updateRecord(superCtx(await deps.ctx(c)), collection, String(auth.row.id), patch, {} as never); }
        catch (err) { if (err instanceof ApiError) throw new ApiError(400, "An error occurred while saving the verified state.", err.data as never); throw err; }
      }
      await clearResend(c.env.DB, `@limitVerificationEmail_${collection.id}${auth.row.id}`);
      return c.body(null, 204);
    });
  });

  app.post("/api/collections/:collection/request-password-reset", async (c) => {
    const collection = await deps.collection(c);
    if (!passwordEnabled(collection)) throw badRequest("The collection is not configured to allow password authentication.");
    const body = await readBody(c);
    const email = String(body.email ?? "");
    if (!email) throw validationFailed({ email: REQUIRED });
    if (email.length > 255) throw validationFailed({ email: { code: "validation_length_out_of_range", message: "The length must be between 1 and 255.", params: { max: 255, min: 1 } } });
    if (!isEmail(email)) throw validationFailed({ email: { code: "validation_is_email", message: "Must be a valid email address." } });
    const row = await one<Row>(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE email = ? LIMIT 1`, [email]);
    if (!row) return c.body(null, 204);
    const key = `@limitPasswordResetEmail_${collection.id}${row.id}`;
    if (await resendLimited(c.env.DB, key)) return c.body(null, 204);
    return requestHook("onRecordRequestPasswordResetRequest", c, collection.name, { collection: new CollectionRef(collection), record: HookRecord.fromRow(collection, row) }, async () => {
      c.executionCtx.waitUntil((async () => {
        try { await sendRecordPasswordReset(c.env.DB, collection, row); await markResend(c.env.DB, key); } catch (err) { console.error("voidbase: failed to send password reset email", err); }
      })());
      return c.body(null, 204);
    });
  });

  app.post("/api/collections/:collection/confirm-password-reset", async (c) => {
    const collection = await deps.collection(c);
    const body = await readBody(c);
    const token = String(body.token ?? ""), password = String(body.password ?? ""), confirm = String(body.passwordConfirm ?? "");
    const errs: Record<string, Fe> = {};
    let auth: Awaited<ReturnType<typeof findAuthRecordByToken>> = null;
    if (!token) errs.token = REQUIRED;
    else {
      auth = await findAuthRecordByToken(c.env.DB, token, "passwordReset");
      if (!auth) errs.token = { code: "validation_invalid_token", message: "Invalid or expired token." };
      else if (auth.collection.id !== collection.id) errs.token = { code: "validation_token_collection_mismatch", message: "The provided token is for different auth collection." };
    }
    const min = passwordMin(collection);
    if (!password) errs.password = REQUIRED; else if (password.length < min || password.length > 255) errs.password = { code: "validation_length_out_of_range", message: `The length must be between ${min} and 255.`, params: { max: 255, min } };
    if (!confirm) errs.passwordConfirm = REQUIRED; else if (confirm !== password) errs.passwordConfirm = { code: "validation_values_mismatch", message: "Values don't match." };
    if (Object.keys(errs).length) throw validationFailed(errs);
    const found = auth!;
    return requestHook("onRecordConfirmPasswordResetRequest", c, collection.name, { collection: new CollectionRef(collection), record: HookRecord.fromRow(collection, found.row) }, async () => {
      const patch: Record<string, unknown> = { password, passwordConfirm: confirm };
      if (!found.row.verified && String(found.row.email ?? "") === String(unverifiedClaims(token).email ?? "")) patch.verified = true;
      try { await updateRecord(superCtx(await deps.ctx(c)), collection, String(found.row.id), patch, {} as never); }
      catch (err) { if (err instanceof ApiError) throw new ApiError(400, "Failed to set new password.", err.data as never); throw err; }
      await clearResend(c.env.DB, `@limitPasswordResetEmail_${collection.id}${found.row.id}`);
      return c.body(null, 204);
    });
  });

  app.post("/api/collections/:collection/request-email-change", async (c) => {
    const collection = await deps.collection(c);
    if (collection.name === "_superusers") throw badRequest("All superusers can change their emails directly.");
    const auth = c.get("auth");
    if (!auth) throw unauthorized("The request requires valid record authorization token.");
    if (auth.collection.id !== collection.id) throw forbidden(`The request requires auth record from ${auth.collection.name} collection.`); // RequireSameCollectionContextAuth
    const body = await readBody(c);
    const newEmail = String(body.newEmail ?? "");
    if (!newEmail) throw validationFailed({ newEmail: REQUIRED });
    if (newEmail.length > 255) throw validationFailed({ newEmail: { code: "validation_length_out_of_range", message: "The length must be between 1 and 255.", params: { max: 255, min: 1 } } });
    if (!isEmail(newEmail)) throw validationFailed({ newEmail: { code: "validation_is_email", message: "Must be a valid email address." } });
    if (newEmail === String(auth.row.email ?? "")) throw validationFailed({ newEmail: { code: "validation_not_in_invalid", message: "Must not be in list." } });
    const taken = await one<Row>(c.env.DB, `SELECT id FROM ${ident(collection.name)} WHERE email = ? LIMIT 1`, [newEmail]);
    if (taken && taken.id !== auth.row.id) throw validationFailed({ newEmail: { code: "validation_invalid_new_email", message: "Invalid new email address." } });
    return requestHook("onRecordRequestEmailChangeRequest", c, collection.name, { collection: new CollectionRef(collection), record: HookRecord.fromRow(collection, auth.row), newEmail }, async (ev) => {
      try { await sendRecordChangeEmail(c.env.DB, collection, auth.row, String(ev.newEmail ?? newEmail)); }
      catch (err) { throw badRequest("Failed to request email change."); void err; }
      return c.body(null, 204);
    });
  });

  app.post("/api/collections/:collection/confirm-email-change", async (c) => {
    const collection = await deps.collection(c);
    if (collection.name === "_superusers") throw badRequest("All superusers can change their emails directly.");
    const body = await readBody(c);
    const token = String(body.token ?? ""), password = String(body.password ?? "");
    const errs: Record<string, Fe> = {};
    let auth: Awaited<ReturnType<typeof findAuthRecordByToken>> = null; let newEmail = "";
    const parse = async (): Promise<Fe | null> => {
      newEmail = String(unverifiedClaims(token).newEmail ?? "");
      if (!newEmail) return { code: "validation_invalid_token_payload", message: "Invalid token payload - newEmail must be set." };
      auth = await findAuthRecordByToken(c.env.DB, token, "emailChange");
      if (!auth) return { code: "validation_invalid_token", message: "Invalid or expired token." };
      if (auth.collection.id !== collection.id) return { code: "validation_token_collection_mismatch", message: "The provided token is for different auth collection." };
      if (await one(c.env.DB, `SELECT id FROM ${ident(collection.name)} WHERE email = ? LIMIT 1`, [newEmail])) return { code: "validation_invalid_token_email", message: "The new email address is invalid." };
      return null;
    };
    if (!token) errs.token = REQUIRED; else { const e = await parse(); if (e) errs.token = e; }
    if (!password) errs.password = REQUIRED;
    else if (password.length > 100) errs.password = { code: "validation_length_out_of_range", message: "The length must be between 1 and 100.", params: { max: 100, min: 1 } };
    else if (!auth || !(await verifyPassword(password, String((auth as { row: Row }).row.password ?? "")))) errs.password = { code: "validation_invalid_password", message: "Missing or invalid auth record password." };
    if (Object.keys(errs).length) throw validationFailed(errs);
    const found = auth! as { row: Row };
    return requestHook("onRecordConfirmEmailChangeRequest", c, collection.name, { collection: new CollectionRef(collection), record: HookRecord.fromRow(collection, found.row), newEmail }, async (ev) => {
      try { await updateRecord(superCtx(await deps.ctx(c)), collection, String(found.row.id), { email: String(ev.newEmail ?? newEmail), verified: true }, {} as never); }
      catch (err) { if (err instanceof ApiError) throw new ApiError(400, "Failed to confirm email change.", err.data as never); throw err; }
      return c.body(null, 204);
    });
  });
}
