// Outbound mail: PocketBase's record emails (verification, password reset, email change, OTP, auth alert) and the
// generic mailer used by $app.newMailClient(). Delivery goes through the SMTP settings when enabled; otherwise the
// message is logged (PocketBase would hand it to sendmail, which a Worker does not have).
import type { Collection } from "../collections/model";
import { signJWT } from "../jwt";
import { env as voidEnv } from "void/env";
import { loadSettings } from "../settings";
import type { Row } from "../types";
import { trigger } from "../hooks/runtime";
import { HookRecord } from "../hooks/record";
import { buildMime, htmlToText, type MailMessage } from "./message";
import { sendSMTP } from "./smtp";
import { collectionTemplate, PLACEHOLDER, resolveEmailTemplate, type EmailTemplate } from "./templates";

export type { MailMessage } from "./message";

// Alternative transport: an HTTP mail API (Resend-compatible request shape). Configured by environment, not by the
// PocketBase settings, so the settings JSON stays wire-identical.
const httpMail = { get url() { return String((voidEnv as Record<string, unknown>).VOIDBASE_MAIL_HTTP_URL ?? "").trim(); }, get key() { return String((voidEnv as Record<string, unknown>).VOIDBASE_MAIL_HTTP_KEY ?? ""); } };
const addr = (a: { name?: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address);
async function sendHTTP(m: MailMessage, text: string): Promise<void> {
  const payload: Record<string, unknown> = { from: addr(m.from), to: m.to.map(addr), subject: m.subject, html: m.html, text };
  if (m.cc?.length) payload.cc = m.cc.map(addr);
  if (m.bcc?.length) payload.bcc = m.bcc.map(addr);
  if (m.headers && Object.keys(m.headers).length) payload.headers = m.headers;
  const res = await fetch(httpMail.url, { method: "POST", headers: { "content-type": "application/json", ...(httpMail.key ? { authorization: `Bearer ${httpMail.key}` } : {}) }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`mail provider ${new URL(httpMail.url).host} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function sendMail(db: D1Database, message: MailMessage): Promise<void> {
  const settings = await loadSettings(db);
  const ev = { app: undefined as unknown, message, mailer: null as unknown, next: async () => undefined as unknown };
  await trigger("onMailerSend", ev, null, async () => {
    const m = ev.message;
    const text = m.text || htmlToText(m.html);
    if (httpMail.url) { await sendHTTP(m, text); return; }
    if (!settings.smtp.enabled) {
      console.log(`voidbase: mail not delivered (SMTP disabled): "${m.subject}" -> ${m.to.map((t) => t.address).join(", ")}`);
      return;
    }
    const mime = buildMime(m, text);
    await sendSMTP(settings.smtp, { from: mime.from, to: mime.rcpts, data: mime.data });
  });
}

const tokenOption = (c: Collection, key: string) => ((c.options as Record<string, unknown>)[key] ?? {}) as { secret?: string; duration?: number };

async function recordToken(c: Collection, row: Row, type: "verification" | "passwordReset" | "emailChange", extra: Record<string, unknown> = {}): Promise<string> {
  const optKey = type === "verification" ? "verificationToken" : type === "passwordReset" ? "passwordResetToken" : "emailChangeToken";
  const opt = tokenOption(c, optKey);
  const key = String(row.tokenKey ?? "") + String(opt.secret ?? "");
  if (!key) throw new Error("missing or invalid signing key");
  return signJWT({ type, id: String(row.id), collectionId: c.id, email: String(row.email ?? ""), ...extra }, key, Number(opt.duration ?? 0) || 604800);
}

async function recordMail(db: D1Database, c: Collection, row: Row, template: EmailTemplate, placeholders: Record<string, string>, to: string, hook: string, meta: Record<string, unknown>): Promise<MailMessage> {
  const settings = await loadSettings(db);
  const { subject, body } = resolveEmailTemplate(settings.meta, c, row, template, placeholders);
  const message: MailMessage = { from: { name: settings.meta.senderName, address: settings.meta.senderAddress }, to: [{ address: to }], subject, html: body };
  const ev = { app: undefined as unknown, message, record: HookRecord.fromRow(c, row), meta, mailer: null as unknown, next: async () => undefined as unknown };
  await trigger(hook, ev, c.name, () => sendMail(db, ev.message));
  return ev.message;
}

export async function sendRecordVerification(db: D1Database, c: Collection, row: Row): Promise<{ token: string; message: MailMessage }> {
  const token = await recordToken(c, row, "verification");
  const message = await recordMail(db, c, row, collectionTemplate(c, "verificationTemplate"), { [PLACEHOLDER.token]: token }, String(row.email), "onMailerRecordVerificationSend", { token });
  return { token, message };
}
export async function sendRecordPasswordReset(db: D1Database, c: Collection, row: Row): Promise<{ token: string; message: MailMessage }> {
  const token = await recordToken(c, row, "passwordReset");
  const message = await recordMail(db, c, row, collectionTemplate(c, "resetPasswordTemplate"), { [PLACEHOLDER.token]: token }, String(row.email), "onMailerRecordPasswordResetSend", { token });
  return { token, message };
}
export async function sendRecordChangeEmail(db: D1Database, c: Collection, row: Row, newEmail: string): Promise<{ token: string; message: MailMessage }> {
  const token = await recordToken(c, row, "emailChange", { newEmail });
  const message = await recordMail(db, c, row, collectionTemplate(c, "confirmEmailChangeTemplate"), { [PLACEHOLDER.token]: token }, newEmail, "onMailerRecordEmailChangeSend", { token, newEmail });
  return { token, message };
}
export async function sendRecordOTP(db: D1Database, c: Collection, row: Row, otpId: string, pass: string): Promise<MailMessage> {
  return recordMail(db, c, row, collectionTemplate(c, "otp"), { [PLACEHOLDER.otpId]: otpId, [PLACEHOLDER.otp]: pass }, String(row.email), "onMailerRecordOTPSend", { otpId, password: pass });
}
export async function sendRecordAuthAlert(db: D1Database, c: Collection, row: Row, info: string): Promise<MailMessage> {
  const escaped = info.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
  return recordMail(db, c, row, collectionTemplate(c, "authAlert"), { [PLACEHOLDER.alertInfo]: escaped }, String(row.email), "onMailerRecordAuthAlertSend", { info: escaped });
}
