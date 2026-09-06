// HTTP mail provider transport (VOIDBASE_MAIL_HTTP_URL / _KEY): builds the production Worker with the variables in
// .env.local, boots vp preview on an isolated D1 and checks that a password reset email is POSTed to the provider
// endpoint (test/smtp-sink.ts serves it at /send) with the bearer key, instead of going to SMTP; also that an
// unhandled error reaches VOIDBASE_ALERT_WEBHOOK_URL as a JSON alert.
//   bun test/smtp-sink.ts &   then   bun test/mail-http.ts [port=5184]
import { $ } from "bun";
import { unlinkSync, writeFileSync, existsSync } from "node:fs";
const port = Number(process.argv[2] ?? 5184); const base = `http://127.0.0.1:${port}`; const SINK = "http://127.0.0.1:2526";
const STATE = ".void-mail";
if (existsSync(".env.local")) { console.error(".env.local exists; refusing to overwrite it"); process.exit(1); }
writeFileSync(".env.local", `VOIDBASE_MAIL_HTTP_URL=${SINK}/send\nVOIDBASE_MAIL_HTTP_KEY=test-provider-key\nVOIDBASE_ALERT_WEBHOOK_URL=${SINK}/send\n`);
let pass = 0, fail = 0; const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + detail}`); };
let preview: ReturnType<typeof Bun.spawn> | null = null;
try {
  await $`rm -rf ${STATE}`.quiet();
  // fixture hooks provide /api/hooktest/boom for the alert-webhook check
  const buildEnv = { ...process.env, VOIDBASE_PERSIST_TO: STATE, VOIDBASE_HOOKS_DIR: "test/fixtures/hooks", VOIDBASE_MIGRATIONS_DIR: "test/fixtures/migrations" }; delete buildEnv.VOIDBASE_SUPERUSER_EMAIL; delete buildEnv.VOIDBASE_SUPERUSER_PASSWORD;
  await $`bun run build`.env(buildEnv).quiet();
  await $`bun scripts/seed-d1.ts ${STATE}`.quiet();
  preview = Bun.spawn(["setsid", "./node_modules/.bin/vp", "preview", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], { env: { ...process.env, VOIDBASE_PERSIST_TO: STATE }, stdout: Bun.file(".void/preview-mail.log"), stderr: Bun.file(".void/preview-mail.log") });
  let health = 0; for (let i = 0; i < 90 && health !== 200; i++) { await Bun.sleep(1000); health = await fetch(`${base}/api/health`).then((r) => r.status).catch(() => 0); }
  check("preview up", health === 200, String(health));
  await fetch(`${SINK}/messages`, { method: "DELETE" });
  const email = process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com";
  const r = await fetch(`${base}/api/collections/_superusers/request-password-reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  check("request-password-reset accepted", r.status === 204, String(r.status));
  let mails: { to: string[]; subject: string; html: string; headers: Record<string, string> }[] = [];
  for (let i = 0; i < 40 && !mails.length; i++) { await Bun.sleep(250); mails = (await fetch(`${SINK}/messages`).then((x) => x.json())) as typeof mails; }
  const m = mails[0];
  check("mail delivered through the HTTP provider", !!m && m.headers.via === "http", JSON.stringify(mails).slice(0, 200));
  check("bearer key sent", m?.headers.authorization === "Bearer test-provider-key", m?.headers.authorization ?? "");
  check("recipient and PocketBase template", !!m && m.to.includes(email) && /Reset your .* password/.test(m.subject) && m.html.includes("confirm-password-reset"), `${m?.to} ${m?.subject}`);
  // the panel's test email goes through the same transport
  const su = (await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: email, password: process.env.VOIDBASE_SUPERUSER_PASSWORD ?? "changeme123" }) }).then((x) => x.json())) as { token: string };
  await fetch(`${SINK}/messages`, { method: "DELETE" });
  const t = await fetch(`${base}/api/settings/test/email`, { method: "POST", headers: { "content-type": "application/json", authorization: su.token }, body: JSON.stringify({ email: "someone@example.com", template: "verification", collection: "_superusers" }) });
  let test: typeof mails = []; for (let i = 0; i < 40 && !test.length; i++) { await Bun.sleep(250); test = (await fetch(`${SINK}/messages`).then((x) => x.json())) as typeof mails; }
  check("settings test email uses the HTTP provider", t.status === 204 && test[0]?.headers.via === "http" && test[0]?.to.includes("someone@example.com"), `${t.status} ${JSON.stringify(test).slice(0, 160)}`);
  // error alert webhook: an unhandled exception in a hook route is a generic 500 and a JSON alert to the webhook
  await fetch(`${SINK}/messages`, { method: "DELETE" });
  const boom = await fetch(`${base}/api/hooktest/boom`);
  let alerts: { raw: string }[] = []; for (let i = 0; i < 40 && !alerts.length; i++) { await Bun.sleep(250); alerts = (await fetch(`${SINK}/messages`).then((x) => x.json())) as typeof alerts; }
  const alert = alerts[0] ? JSON.parse(alerts[0].raw) as { source: string; path: string; error: string; status: number } : null;
  check("unhandled error -> 500 + alert webhook", boom.status === 500 && alert?.source === "voidbase" && alert.path === "/api/hooktest/boom" && /boom/.test(alert.error) && alert.status === 500, `${boom.status} ${JSON.stringify(alert).slice(0, 200)}`);
} catch (err) {
  console.error("mail-http: aborted:", err instanceof Error ? err.message : err); fail++;
} finally {
  if (preview) { try { process.kill(-preview.pid, "SIGTERM"); } catch { preview.kill("SIGTERM"); } await preview.exited; }
  try { unlinkSync(".env.local"); } catch { /* gone */ }
  await $`bun run build`.quiet(); // leave dist/ built without the test variables
}
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
