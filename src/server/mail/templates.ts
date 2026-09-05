// PocketBase's email templates (core/collection_model_auth_templates.go + mails/templates): the per-collection
// template resolves {APP_NAME}, {APP_URL}, {TOKEN}, {OTP}, {OTP_ID}, {ALERT_INFO} and {RECORD:field}, and the
// result is wrapped in the shared HTML layout.
import type { Collection } from "../collections/model";
import type { Row } from "../types";
import { fromColumn } from "../records/values";
import type { Field } from "../collections/fields";

export interface EmailTemplate { subject: string; body: string }
export const PLACEHOLDER = { appName: "{APP_NAME}", appURL: "{APP_URL}", token: "{TOKEN}", otp: "{OTP}", otpId: "{OTP_ID}", alertInfo: "{ALERT_INFO}" };

export const DEFAULT_TEMPLATES: Record<"verification" | "resetPassword" | "confirmEmailChange" | "otp" | "authAlert", EmailTemplate> = {
  verification: { subject: "Verify your {APP_NAME} email", body: `<p>Hello,</p>
<p>Thank you for joining us at {APP_NAME}.</p>
<p>Click on the button below to verify your email address.</p>
<p>
  <a class="btn" href="{APP_URL}/_/#/auth/confirm-verification/{TOKEN}" target="_blank" rel="noopener">Verify</a>
</p>
<p><i>If you didn't recently register, please ignore this email.</i></p>
<p>
  Thanks,<br/>
  {APP_NAME} team
</p>` },
  resetPassword: { subject: "Reset your {APP_NAME} password", body: `<p>Hello,</p>
<p>Click on the button below to reset your password.</p>
<p>
  <a class="btn" href="{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}" target="_blank" rel="noopener">Reset password</a>
</p>
<p><i>If you didn't ask to reset your password, please ignore this email.</i></p>
<p>
  Thanks,<br/>
  {APP_NAME} team
</p>` },
  confirmEmailChange: { subject: "Confirm your {APP_NAME} new email address", body: `<p>Hello,</p>
<p>Click on the button below to confirm your new email address.</p>
<p>
  <a class="btn" href="{APP_URL}/_/#/auth/confirm-email-change/{TOKEN}" target="_blank" rel="noopener">Confirm new email</a>
</p>
<p><i>If you didn't ask to change your email address, please ignore this email.</i></p>
<p>
  Thanks,<br/>
  {APP_NAME} team
</p>` },
  otp: { subject: "OTP for {APP_NAME}", body: `<p>Hello,</p>
<p>Your one-time password is: <strong>{OTP}</strong></p>
<p><i>If you didn't ask for the one-time password, you can ignore this email.</i></p>
<p>
  Thanks,<br/>
  {APP_NAME} team
</p>` },
  authAlert: { subject: "Login from a new location", body: `<p>Hello,</p>
<p>We noticed a login to your {APP_NAME} account from a new location:</p>
<p><em>{ALERT_INFO}</em></p>
<p><strong>If this wasn't you, you should immediately change your {APP_NAME} account password to revoke access from all other locations.</strong></p>
<p>If this was you, you may disregard this email.</p>
<p>
  Thanks,<br/>
  {APP_NAME} team
</p>` },
};

export const LAYOUT = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
        body, html {
            padding: 0;
            margin: 0;
            border: 0;
            color: #16161a;
            background: #fff;
            font-size: 14px;
            line-height: 20px;
            font-weight: normal;
            font-family: Source Sans Pro, sans-serif, emoji;
        }
        body {
            padding: 20px 30px;
        }
        strong {
            font-weight: bold;
        }
        em, i {
            font-style: italic;
        }
        p {
            display: block;
            margin: 10px 0;
            font-family: inherit;
        }
        small {
            font-size: 12px;
            line-height: 16px;
        }
        hr {
            display: block;
            height: 1px;
            border: 0;
            width: 100%;
            background: #e1e6ea;
            margin: 10px 0;
        }
        a {
            color: inherit;
        }
        .hidden {
            display: none !important;
        }
        .btn {
            display: inline-block;
            vertical-align: top;
            border: 0;
            cursor: pointer;
            color: #fff !important;
            background: #16161a !important;
            text-decoration: none !important;
            line-height: 40px;
            width: auto;
            min-width: 150px;
            text-align: center;
            padding: 0 20px;
            margin: 5px 0;
            font-family: Source Sans Pro, sans-serif, emoji;;
            font-size: 14px;
            font-weight: bold;
            border-radius: 6px;
            box-sizing: border-box;
        }
    </style>
</head>
<body>
    {{CONTENT}}
</body>
</html>
`;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
const NONESCAPE_TYPES = ["editor"];

export function collectionTemplate(c: Collection, key: "verificationTemplate" | "resetPasswordTemplate" | "confirmEmailChangeTemplate" | "otp" | "authAlert"): EmailTemplate {
  const o = c.options as Record<string, unknown>;
  if (key === "otp") { const t = (o.otp as { emailTemplate?: EmailTemplate } | undefined)?.emailTemplate; return t?.subject ? t : DEFAULT_TEMPLATES.otp; }
  if (key === "authAlert") { const t = (o.authAlert as { emailTemplate?: EmailTemplate } | undefined)?.emailTemplate; return t?.subject ? t : DEFAULT_TEMPLATES.authAlert; }
  const t = o[key] as EmailTemplate | undefined;
  if (t?.subject) return t;
  return key === "verificationTemplate" ? DEFAULT_TEMPLATES.verification : key === "resetPasswordTemplate" ? DEFAULT_TEMPLATES.resetPassword : DEFAULT_TEMPLATES.confirmEmailChange;
}

// mails/record.go resolveEmailTemplate
export function resolveEmailTemplate(meta: { appName: string; appURL: string }, c: Collection, row: Row, template: EmailTemplate, placeholders: Record<string, string>): { subject: string; body: string } {
  const all: Record<string, string> = { ...placeholders };
  if (!(PLACEHOLDER.appName in all)) all[PLACEHOLDER.appName] = meta.appName;
  if (!(PLACEHOLDER.appURL in all)) all[PLACEHOLDER.appURL] = meta.appURL;
  for (const f of c.fields as Field[]) {
    if (f.hidden) continue;
    const key = `{RECORD:${f.name}}`;
    if (key in all) continue;
    const v = fromColumn(f, row[f.name]);
    const str = v == null ? "" : Array.isArray(v) ? String(v[0] ?? "") : typeof v === "object" ? JSON.stringify(v) : String(v);
    all[key] = NONESCAPE_TYPES.includes(f.type) ? str : escapeHtml(str);
  }
  let subject = template.subject, body = template.body;
  for (const [k, v] of Object.entries(all)) { subject = subject.split(k).join(v); body = body.split(k).join(v); }
  return { subject, body: LAYOUT.replace("{{CONTENT}}", body) };
}
