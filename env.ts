import { defineEnv, string } from "void/env";

export default defineEnv({
  // First superuser, upserted at bootstrap when both are set (mirrors the starter's entrypoint).
  VOIDBASE_SUPERUSER_EMAIL: string().optional(),
  VOIDBASE_SUPERUSER_PASSWORD: string().optional(),
  // A test user in `users`, created once at start when both are set (voidbase serve; the Worker ignores them)
  VOIDBASE_USER_EMAIL: string().optional(),
  VOIDBASE_USER_PASSWORD: string().optional(),
  // read by pb_hooks via $os.getenv (the starter's audit log uses AUDITLOG=posts,users)
  AUDITLOG: string().optional(),
  // Optional HTTP mail provider instead of SMTP (Resend-compatible JSON: POST {from,to,subject,html,text} with a
  // Bearer key). When set it takes precedence over settings.smtp; the panel's "Send test email" goes through it too.
  VOIDBASE_MAIL_HTTP_URL: string().optional(),
  VOIDBASE_MAIL_HTTP_KEY: string().optional(),
  // Optional error alerts: unhandled request errors (HTTP 500) are POSTed as JSON to this webhook
  VOIDBASE_ALERT_WEBHOOK_URL: string().optional(),
  // PocketBase's --encryptionEnv equivalent: when set (16, 24 or 32 chars) the settings row is stored AES-GCM encrypted
  VOIDBASE_ENCRYPTION_KEY: string().optional(),
});
