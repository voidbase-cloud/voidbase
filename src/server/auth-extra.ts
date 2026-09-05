// OTP (apis/record_auth_otp_request.go, record_auth_with_otp.go) and superuser impersonation.
import type { Context, Hono } from "hono";
import { newAuthToken, requireSuperuser } from "./auth";
import { recordAuthResponse } from "./auth-response";
import type { Collection } from "./collections/model";
import { all, ident, one, run, stmt } from "./db";
import { ApiError, badRequest, forbidden, notFound } from "./errors";
import { nowString, randomId } from "./ids";
import { sendRecordOTP } from "./mail";
import { hashPassword, verifyPassword } from "./password";
import { updateRecord, type RecordContext } from "./records/service";
import { requestHook } from "./hooks/runtime";
import { CollectionRef, HookRecord } from "./hooks/record";
import type { AppEnv, Row } from "./types";

type Fe = { code: string; message: string; params?: Record<string, unknown> };
const REQUIRED: Fe = { code: "validation_required", message: "Cannot be blank." };
const lengthErr = (min: number, max: number): Fe => ({ code: "validation_length_out_of_range", message: `The length must be between ${min} and ${max}.`, params: { max, min } });
const validationFailed = (errs: Record<string, Fe>) => new ApiError(400, "An error occurred while validating the submitted data.", Object.fromEntries(Object.entries(errs).sort(([a], [b]) => (a < b ? -1 : 1))) as never);
const opt = <T>(c: Collection, path: string, fallback: T): T => { let cur: unknown = c.options; for (const k of path.split(".")) { if (!cur || typeof cur !== "object") return fallback; cur = (cur as Record<string, unknown>)[k]; } return (cur === undefined || cur === null ? fallback : cur) as T; };
async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try { const v = await c.req.json(); if (!v || typeof v !== "object") throw new Error(); return v as Record<string, unknown>; }
  catch { throw badRequest("An error occurred while loading the submitted data."); }
}
const createdMs = (row: Row) => Date.parse(String(row.created).replace(" ", "T"));

export function mountAuthExtra(app: Hono<AppEnv>, deps: { collection: (c: Context<AppEnv>) => Promise<Collection>; ctx: (c: Context<AppEnv>) => Promise<RecordContext> }) {
  app.post("/api/collections/:collection/request-otp", async (c) => {
    const collection = await deps.collection(c);
    if (!opt<boolean>(collection, "otp.enabled", false)) throw forbidden("The collection is not configured to allow OTP authentication.");
    const body = await readBody(c);
    const email = String(body.email ?? "");
    if (!email) throw validationFailed({ email: REQUIRED });
    if (email.length > 255) throw validationFailed({ email: lengthErr(1, 255) });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validationFailed({ email: { code: "validation_is_email", message: "Must be a valid email address." } });
    const row = await one<Row>(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE email = ? LIMIT 1`, [email]);
    const length = Number(opt<number>(collection, "otp.length", 8)) || 8;
    const durationMs = (Number(opt<number>(collection, "otp.duration", 180)) || 180) * 1000;
    const digits = crypto.getRandomValues(new Uint8Array(length));
    const generated = [...digits].map((d) => String(d % 10)).join("");
    return requestHook("onRecordRequestOTPRequest", c, collection.name, { collection: new CollectionRef(collection), record: row ? HookRecord.fromRow(collection, row) : null, password: generated }, async (ev) => {
    const pass = String(ev.password ?? generated);
    if (!row) return c.json({ otpId: randomId() }); // same shape for unknown emails, like PocketBase
    // too many recent OTPs: reuse the newest instead of issuing another (and drop the expired ones while here)
    const existing = await all<Row>(c.env.DB, "SELECT * FROM `_otps` WHERE collectionRef = ? AND recordRef = ? ORDER BY created DESC", [collection.id, String(row.id)]);
    const expired = existing.filter((o) => Date.now() - createdMs(o) > durationMs);
    if (expired.length) await c.env.DB.batch(expired.map((o) => stmt(c.env.DB, "DELETE FROM `_otps` WHERE id = ?", [o.id])));
    const recent = existing.filter((o) => Date.now() - createdMs(o) <= durationMs);
    if (recent.length > 9) return c.json({ otpId: String(existing[0]!.id) });
    const id = randomId(); const now = nowString();
    await run(c.env.DB, "INSERT INTO `_otps` (id, collectionRef, recordRef, password, sentTo, created, updated) VALUES (?, ?, ?, ?, '', ?, ?)", [id, collection.id, String(row.id), await hashPassword(pass), now, now]);
    c.executionCtx.waitUntil((async () => {
      try {
        await sendRecordOTP(c.env.DB, collection, row, id, pass);
        await run(c.env.DB, "UPDATE `_otps` SET sentTo = ?, updated = ? WHERE id = ? AND sentTo = ''", [String(row.email), nowString(), id]);
      } catch (err) { console.error("voidbase: failed to send OTP email", err); await run(c.env.DB, "DELETE FROM `_otps` WHERE id = ?", [id]); }
    })());
    return c.json({ otpId: id });
    });
  });

  app.post("/api/collections/:collection/auth-with-otp", async (c) => {
    const collection = await deps.collection(c);
    if (!opt<boolean>(collection, "otp.enabled", false)) throw forbidden("The collection is not configured to allow OTP authentication.");
    const body = await readBody(c);
    const otpId = String(body.otpId ?? ""), password = String(body.password ?? "");
    const errs: Record<string, Fe> = {};
    if (!otpId) errs.otpId = REQUIRED; else if (otpId.length > 255) errs.otpId = lengthErr(1, 255);
    if (!password) errs.password = REQUIRED; else if (password.length > 71) errs.password = lengthErr(1, 71);
    if (Object.keys(errs).length) throw validationFailed(errs);
    const otp = await one<Row>(c.env.DB, "SELECT * FROM `_otps` WHERE id = ? LIMIT 1", [otpId]);
    if (!otp || otp.collectionRef !== collection.id) throw badRequest("Invalid or expired OTP");
    const durationMs = (Number(opt<number>(collection, "otp.duration", 180)) || 180) * 1000;
    if (Date.now() - createdMs(otp) > durationMs) throw badRequest("Invalid or expired OTP");
    const row = await one<Row>(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE id = ? LIMIT 1`, [otp.recordRef]);
    if (!row) throw badRequest("Invalid or expired OTP");
    // 5 attempts per 180s per record (checkRateLimit "@pb_otp_<id>")
    const key = `@pb_otp_${row.id}`;
    const bucket = await one<{ value: string }>(c.env.DB, "SELECT value FROM `_params` WHERE id = ?", [key]);
    let state = bucket ? (JSON.parse(bucket.value) as { count: number; resetAt: number }) : { count: 0, resetAt: Date.now() + 180_000 };
    if (state.resetAt < Date.now()) state = { count: 0, resetAt: Date.now() + 180_000 };
    state.count++;
    await run(c.env.DB, "INSERT OR REPLACE INTO `_params` (id, value, created, updated) VALUES (?, ?, ?, ?)", [key, JSON.stringify(state), nowString(), nowString()]);
    if (state.count > 5) throw new ApiError(429, "Too many attempts, please try again later with a new OTP.", {});
    if (!(await verifyPassword(password, String(otp.password ?? "")))) throw badRequest("Invalid or expired OTP");
    const ctx = await deps.ctx(c);
    return requestHook("onRecordAuthWithOTPRequest", c, collection.name, { collection: new CollectionRef(collection), record: HookRecord.fromRow(collection, row), otp }, async () => {
    await run(c.env.DB, "DELETE FROM `_otps` WHERE id = ?", [otpId]);
    let fresh = row;
    if (!row.verified && otp.sentTo && String(row.email) === String(otp.sentTo)) {
      const patch: Record<string, unknown> = { verified: true };
      if (!opt<boolean>(collection, "mfa.enabled", false)) { const pw = randomString30(); patch.password = pw; patch.passwordConfirm = pw; }
      try { await updateRecord({ ...ctx, superuser: true, hookEvent: undefined }, collection, String(row.id), patch, {} as never); fresh = (await one<Row>(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE id = ? LIMIT 1`, [row.id])) ?? row; }
      catch (err) { console.error("voidbase: failed to update record verified state after OTP", err); }
    }
    return recordAuthResponse(c, { ...ctx, request: { ...ctx.request, context: "otp" } }, collection, fresh, "otp", { body });
    });
  });

  app.post("/api/collections/:collection/impersonate/:id", async (c) => {
    requireSuperuser(c); // RequireSuperuserAuth middleware: 401 anonymous, 403 for other records
    const collection = await deps.collection(c);
    const row = await one<Row>(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE id = ? LIMIT 1`, [c.req.param("id") ?? ""]);
    if (!row) throw notFound();
    const body = await readBody(c);
    const duration = Number(body.duration ?? 0);
    if (duration < 0) throw validationFailed({ duration: { code: "validation_min_greater_equal_than_required", message: "Must be no less than 0.", params: { threshold: 0 } } });
    const token = await newAuthToken({ collection, row }, false, duration > 0 ? duration : undefined);
    const ctx = await deps.ctx(c);
    return recordAuthResponse(c, ctx, collection, row, "", { token, body });
  });
}
const randomString30 = () => { const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; return [...crypto.getRandomValues(new Uint8Array(30))].map((b) => chars[b % chars.length]).join(""); };
