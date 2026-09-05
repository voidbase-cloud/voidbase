// /api/settings (superuser): update, test email, test S3, Apple client secret (apis/settings.go).
import type { Context, Hono } from "hono";
import { ApiError, badRequest } from "./errors";
import { loadCollections } from "./collections/model";
import { sendRecordAuthAlert, sendRecordChangeEmail, sendRecordOTP, sendRecordPasswordReset, sendRecordVerification } from "./mail";
import { lengthErr, loadSettings, maxErr, mergeSettings, minErr, publicSettings, saveSettings, sortNested, validateSettings, type NestedErrors } from "./settings";
import { randomString } from "./ids";
import type { AppEnv, Row } from "./types";
import type { Field } from "./collections/fields";
import { requireSuperuser } from "./auth";
import { requestHook, trigger } from "./hooks/runtime";

const readBody = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
  try { const v = await c.req.json(); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(); return v as Record<string, unknown>; }
  catch { throw badRequest("An error occurred while loading the submitted data."); }
};
const req = { code: "validation_required", message: "Cannot be blank." };

export function mountSettingsApi(app: Hono<AppEnv>) {
  app.patch("/api/settings", async (c) => {
    requireSuperuser(c);
    const body = await readBody(c);
    const current = await loadSettings(c.env.DB);
    const merged = mergeSettings(current, body);
    return requestHook("onSettingsUpdateRequest", c, null, { oldSettings: structuredClone(current), newSettings: merged }, async (ev) => {
      const next = ev.newSettings as typeof merged;
      const errs = validateSettings(next);
      if (Object.keys(errs).length) throw new ApiError(400, "An error occurred while saving the new settings.", errs as never);
      await saveSettings(c.env.DB, next);
      await trigger("onSettingsReload", { app: undefined as unknown, next: async () => undefined as unknown }, null, async () => undefined);
      return c.json(publicSettings(next));
    });
  });

  app.post("/api/settings/test/email", async (c) => {
    requireSuperuser(c);
    const body = await readBody(c);
    const email = String(body.email ?? ""), template = String(body.template ?? ""), collName = String(body.collection ?? "");
    const errs: NestedErrors = {};
    const collections = await loadCollections(c.env.DB);
    if (collName) {
      if (collName.length > 255) errs.collection = lengthErr(1, 255);
      else { const cc = collections.get(collName); if (!cc || cc.type !== "auth") errs.collection = { code: "validation_invalid_auth_collection", message: "Must be a valid auth collection id or name." }; }
    }
    if (!email) errs.email = req; else if (email.length > 255) errs.email = lengthErr(1, 255); else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = { code: "validation_is_email", message: "Must be a valid email address." };
    if (!template) errs.template = req; else if (!["verification", "password-reset", "email-change", "otp", "login-alert"].includes(template)) errs.template = { code: "validation_in_invalid", message: "Must be a valid value." };
    if (Object.keys(errs).length) throw new ApiError(400, "Failed to send the test email.", sortNested(errs) as never);
    const collection = collections.get(collName || "_superusers")!;
    const row: Row = {};
    for (const f of collection.fields as Field[]) if (!f.hidden) row[f.name] = `__pb_test_${f.name}__`;
    row.tokenKey = randomString(50); row.email = email;
    try {
      if (template === "verification") await sendRecordVerification(c.env.DB, collection, row);
      else if (template === "password-reset") await sendRecordPasswordReset(c.env.DB, collection, row);
      else if (template === "email-change") await sendRecordChangeEmail(c.env.DB, collection, row, email);
      else if (template === "otp") await sendRecordOTP(c.env.DB, collection, row, "_PB_TEST_OTP_ID_", "123456");
      else await sendRecordAuthAlert(c.env.DB, collection, row, `${new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ".000Z")} - TEST_IP TEST_USER_AGENT`);
    } catch (err) { throw badRequest("Failed to send the test email. Raw error: \n" + (err instanceof Error ? err.message : String(err))); }
    return c.body(null, 204);
  });

  app.post("/api/settings/test/s3", async (c) => {
    requireSuperuser(c);
    const body = await readBody(c);
    const fs = String(body.filesystem ?? "");
    if (!fs) throw new ApiError(400, "Failed to test the S3 filesystem.", { filesystem: req } as never);
    if (!["storage", "backups"].includes(fs)) throw new ApiError(400, "Failed to test the S3 filesystem.", { filesystem: { code: "validation_in_invalid", message: "Must be a valid value." } } as never);
    const settings = await loadSettings(c.env.DB);
    const cfg = fs === "storage" ? settings.s3 : settings.backups.s3;
    if (!cfg.enabled) throw badRequest(`Failed to test the S3 filesystem. Raw error: \n${fs} S3 storage filesystem is not enabled`);
    throw badRequest("Failed to test the S3 filesystem. Raw error: \nS3 connection tests are not supported yet on this server (files live in R2)");
  });

  app.post("/api/settings/apple/generate-client-secret", async (c) => {
    requireSuperuser(c);
    const body = await readBody(c);
    const clientId = String(body.clientId ?? ""), teamId = String(body.teamId ?? ""), keyId = String(body.keyId ?? ""), privateKey = String(body.privateKey ?? ""), duration = Number(body.duration ?? 0);
    const errs: NestedErrors = {};
    if (!clientId) errs.clientId = req;
    if (!teamId) errs.teamId = req; else if (teamId.length !== 10) errs.teamId = lengthErr(10, 10);
    if (!keyId) errs.keyId = req; else if (keyId.length !== 10) errs.keyId = lengthErr(10, 10);
    if (!privateKey) errs.privateKey = req; else if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(privateKey.trim())) errs.privateKey = { code: "validation_match_invalid", message: "Must be in a valid format." };
    if (!duration) errs.duration = req; else if (duration < 1) errs.duration = minErr(1); else if (duration > 15777000) errs.duration = maxErr(15777000);
    if (Object.keys(errs).length) throw new ApiError(400, "Invalid client secret data.", sortNested(errs) as never);
    try {
      const pem = privateKey.trim().replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
      const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
      const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const b64 = (v: ArrayBuffer | Uint8Array | string) => { const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
      const now = Math.floor(Date.now() / 1000);
      const header = b64(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
      const claims = b64(JSON.stringify({ aud: ["https://appleid.apple.com"], exp: now + duration, iat: now, iss: teamId, sub: clientId }));
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
      return c.json({ secret: `${header}.${claims}.${b64(sig)}` });
    } catch (err) { throw badRequest("Failed to generate client secret. Raw error: \n" + (err instanceof Error ? err.message : String(err))); }
  });
}
