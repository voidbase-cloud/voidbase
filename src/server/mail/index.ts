// Outbound mail: PocketBase's record emails (verification, password reset, email change, OTP, auth alert) and the
// generic mailer used by $app.newMailClient(). Delivery goes to whoever provides mail@1 when its binding is there
// (the shipped `mail` plugin: Cloudflare Email Service from the instance's own domain), else an HTTP mail API when
// configured, else the SMTP settings when enabled; otherwise the message is logged (PocketBase would hand it to
// sendmail, which a Worker does not have). System emails leave through the jobs queue when the deploy has one
// (src/server/jobs.ts), so the request never waits on the transport.
import type { Collection } from "../collections/model";
import { signJWT } from "../jwt";
import { env as voidEnv } from "#platform/env";
import { loadSettings } from "../settings";
import type { Row } from "../types";
import { trigger } from "../hooks/runtime";
import { HookRecord } from "../hooks/record";
import type { Mail } from "../interfaces";
import { buildMime, htmlToText, type MailMessage } from "./message";
import { sendSMTP } from "./smtp";
import { dispatch, registerJobHandler } from "../jobs";
import type { Bindings } from "../types";
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

export interface SendOptions { inline?: boolean } // inline: deliver now and surface transport errors to the caller

// Whoever provides mail@1, looked up on every message the way auth-slot.ts looks up auth, because a provider can be
// replaced while the instance runs. app.ts hands the kernel's lookup in once the plugins are loaded; before that, and
// in an instance without a provider, mail goes where it always went.
let lookup: () => Mail | undefined = () => undefined;
/** app.ts: how to reach whoever provides mail@1 now */
export function provideMailLookup(fn: () => Mail | undefined): void { lookup = fn; }

/** the provider's answer for these bindings and this sender: where it would carry the mail, or why it will not */
function providerRoute(env: Bindings, from: string, provider = lookup()): { carrier: string | null; refused: string | null } {
  const carrier = provider?.carrier(env) ?? null;
  const refused = carrier && from ? provider!.refuses(from, env) : null;
  return { carrier, refused };
}

/** where a message leaves this instance; `refused` is the provider's reason when nothing else could take it */
export type MailRoute = { via: "plugin"; carrier: string } | { via: "http"; host: string } | { via: "smtp"; host: string } | { via: "log"; refused?: string };
export function routeMail(env: Bindings, from: string, smtp: { enabled: boolean; host: string }, provider = lookup()): MailRoute {
  const { carrier, refused } = providerRoute(env, from, provider);
  if (carrier && !refused) return { via: "plugin", carrier };
  if (httpMail.url) return { via: "http", host: new URL(httpMail.url).host };
  if (smtp.enabled) return { via: "smtp", host: smtp.host };
  return { via: "log", ...(refused ? { refused } : {}) };
}

/** for /api/plugins: where this instance's own mail (the settings' sender) goes with these bindings */
export async function mailRoute(env: Bindings): Promise<MailRoute & { sender?: string }> {
  const settings = await loadSettings(env.DB).catch(() => null);
  const sender = settings?.meta.senderAddress || undefined;
  return { ...routeMail(env, sender ?? "", settings?.smtp ?? { enabled: false, host: "" }), ...(sender ? { sender } : {}) };
}

// The transport step: the mail@1 provider when its binding is there and it takes the sender, else an HTTP mail API
// when configured, else the SMTP settings, else a log line. On Cloudflare it runs from the jobs queue (retries, no
// request time spent on the transport); inline for the panel's test email and hooks.
export async function deliverMail(env: Bindings, m: MailMessage, text: string): Promise<void> {
  const provider = lookup();
  const { carrier, refused } = providerRoute(env, m.from.address, provider);
  if (carrier && !refused) { await provider!.send(env, m, text); return; }
  if (httpMail.url) { await sendHTTP(m, text); return; }
  const settings = await loadSettings(env.DB);
  if (!settings.smtp.enabled) {
    if (refused) throw new Error(`${refused}; SMTP is disabled, so the message was not sent`);
    console.log(`voidbase: mail not delivered (SMTP disabled): "${m.subject}" -> ${m.to.map((t) => t.address).join(", ")}`);
    return;
  }
  const mime = buildMime(m, text);
  await sendSMTP(settings.smtp, { from: mime.from, to: mime.rcpts, data: mime.data });
}
registerJobHandler("mail", (env, job) => deliverMail(env, job.message, job.text));

export async function sendMail(db: D1Database, message: MailMessage, opts: SendOptions = {}): Promise<void> {
  const ev = { app: undefined as unknown, message, mailer: null as unknown, next: async () => undefined as unknown };
  // hooks (onMailerSend) run here, in the request, on the message that is then queued or delivered
  await trigger("onMailerSend", ev, null, async () => {
    const m = ev.message;
    const text = m.text || htmlToText(m.html);
    await dispatch({ type: "mail", message: m, text }, { env: { DB: db } as Bindings, inline: opts.inline });
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

async function recordMail(db: D1Database, c: Collection, row: Row, template: EmailTemplate, placeholders: Record<string, string>, to: string, hook: string, meta: Record<string, unknown>, opts: SendOptions = {}): Promise<MailMessage> {
  const settings = await loadSettings(db);
  const { subject, body } = resolveEmailTemplate(settings.meta, c, row, template, placeholders);
  const message: MailMessage = { from: { name: settings.meta.senderName, address: settings.meta.senderAddress }, to: [{ address: to }], subject, html: body };
  const ev = { app: undefined as unknown, message, record: HookRecord.fromRow(c, row), meta, mailer: null as unknown, next: async () => undefined as unknown };
  await trigger(hook, ev, c.name, () => sendMail(db, ev.message, opts));
  return ev.message;
}

export async function sendRecordVerification(db: D1Database, c: Collection, row: Row, opts: SendOptions = {}): Promise<{ token: string; message: MailMessage }> {
  const token = await recordToken(c, row, "verification");
  const message = await recordMail(db, c, row, collectionTemplate(c, "verificationTemplate"), { [PLACEHOLDER.token]: token }, String(row.email), "onMailerRecordVerificationSend", { token }, opts);
  return { token, message };
}
export async function sendRecordPasswordReset(db: D1Database, c: Collection, row: Row, opts: SendOptions = {}): Promise<{ token: string; message: MailMessage }> {
  const token = await recordToken(c, row, "passwordReset");
  const message = await recordMail(db, c, row, collectionTemplate(c, "resetPasswordTemplate"), { [PLACEHOLDER.token]: token }, String(row.email), "onMailerRecordPasswordResetSend", { token }, opts);
  return { token, message };
}
export async function sendRecordChangeEmail(db: D1Database, c: Collection, row: Row, newEmail: string, opts: SendOptions = {}): Promise<{ token: string; message: MailMessage }> {
  const token = await recordToken(c, row, "emailChange", { newEmail });
  const message = await recordMail(db, c, row, collectionTemplate(c, "confirmEmailChangeTemplate"), { [PLACEHOLDER.token]: token }, newEmail, "onMailerRecordEmailChangeSend", { token, newEmail }, opts);
  return { token, message };
}
export async function sendRecordOTP(db: D1Database, c: Collection, row: Row, otpId: string, pass: string, opts: SendOptions = {}): Promise<MailMessage> {
  return recordMail(db, c, row, collectionTemplate(c, "otp"), { [PLACEHOLDER.otpId]: otpId, [PLACEHOLDER.otp]: pass }, String(row.email), "onMailerRecordOTPSend", { otpId, password: pass }, opts);
}
export async function sendRecordAuthAlert(db: D1Database, c: Collection, row: Row, info: string, opts: SendOptions = {}): Promise<MailMessage> {
  const escaped = info.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
  return recordMail(db, c, row, collectionTemplate(c, "authAlert"), { [PLACEHOLDER.alertInfo]: escaped }, String(row.email), "onMailerRecordAuthAlertSend", { info: escaped }, opts);
}
