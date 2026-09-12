// Drives the unmodified 0.40 panel's admin screens against voidbase: logs, application/mail/backups/crons/SQL
// settings, export/import pages and the auth record actions (impersonate, send verification/reset emails).
//   bun test/smtp-sink.ts &   then   bun test/panel-admin.ts [base=http://127.0.0.1:5180]
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://127.0.0.1:5180";
const SINK = "http://127.0.0.1:2526/messages";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const api: string[] = []; const failed: string[] = []; const consoleErrors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) api.push(`${r.status()} ${r.request().method()} ${u.pathname}`); if (r.status() >= 400 && u.pathname.startsWith("/api/")) failed.push(`${r.status()} ${r.request().method()} ${u.pathname}${u.search}`); });
const dom = (fn: string) => page.evaluate(fn) as Promise<unknown>;
const clickText = (sel: string, re: string) => dom(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.offsetParent !== null || b.closest(".overlay-panel")).find(b => ${re}.test(b.textContent.trim())); if (!b) return "missing"; b.click(); return "clicked"; })()`);
// dropdown items in the record modal are in the DOM but hidden until the menu opens: click them regardless of visibility
const clickAny = (sel: string, re: string) => dom(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(b => ${re}.test(b.textContent.trim())); if (!b) return "missing"; b.click(); return "clicked"; })()`);
const type = (sel: string, value: string) => dom(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].pop(); if (!el) return "missing"; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return "typed"; })()`);
const text = () => dom("document.body.innerText.replace(/\\s+/g, ' ')") as Promise<string>;
const waitApi = (method: string, path: RegExp, ms = 15000) => page.waitForResponse((r) => r.request().method() === method && path.test(new URL(r.url()).pathname), { timeout: ms }).then((r) => r.status()).catch(() => "timeout");
const results: Record<string, unknown> = {};

const su = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: "changeme123" }) }).then((r) => r.json()) as { token: string };
const H = { authorization: su.token, "content-type": "application/json" };
const settings = await fetch(`${base}/api/settings`, { headers: H }).then((r) => r.json()) as { smtp: Record<string, unknown>; meta: { appName: string } };
await fetch(`${base}/api/settings`, { method: "PATCH", headers: H, body: JSON.stringify({ smtp: { enabled: true, host: "127.0.0.1", port: 2525, username: "", password: "", authMethod: "", tls: false, localName: "" } }) });
const restore = async () => { await fetch(`${base}/api/settings`, { method: "PATCH", headers: H, body: JSON.stringify({ smtp: { ...settings.smtp, password: "" }, meta: settings.meta }) }); };
try {
  await page.goto(`${base}/_/`, { waitUntil: "networkidle" });
  await page.waitForSelector("form.auth-with-password-form input[name=identity]", { timeout: 20000 });
  await page.fill("form.auth-with-password-form input[name=identity]", "admin@example.com");
  await page.fill("form.auth-with-password-form input[name=password]", "changeme123");
  await page.click("form.auth-with-password-form button.next");
  await page.waitForURL(/#\/collections/, { timeout: 15000 });

  // logs
  await page.goto(`${base}/_/#/logs`, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
  results.logs = { rows: await dom("document.querySelectorAll('table tbody tr').length"), stats: api.some((l) => l.startsWith("200 GET /api/logs/stats")), list: api.some((l) => l.startsWith("200 GET /api/logs")) };

  // application settings: rename and save
  await page.goto(`${base}/_/#/settings`, { waitUntil: "networkidle" }); await page.waitForTimeout(1200);
  results.appNameTyped = await type('input[name="meta.appName"], input#meta\\.appName, input[id*="appName"]', "Panel Renamed");
  const savedApp = waitApi("PATCH", /^\/api\/settings$/);
  results.appSaveClick = await clickText("button", "/^Save changes$/");
  results.appSave = await savedApp;
  results.appName = ((await fetch(`${base}/api/settings`, { headers: H }).then((r) => r.json())) as { meta: { appName: string } }).meta.appName;

  // mail settings: send a test email through the modal
  await page.goto(`${base}/_/#/settings/mail`, { waitUntil: "networkidle" }); await page.waitForTimeout(1200);
  await fetch(SINK, { method: "DELETE" });
  results.testEmailOpen = await clickText("button", "/^Send test email$/");
  await page.waitForTimeout(600);
  results.testEmailTyped = await type('.modal input[type="email"]', "panel-test@example.com");
  const sentTest = waitApi("POST", /^\/api\/settings\/test\/email$/);
  results.testEmailSubmit = await clickText(".modal .modal-footer button", "/^Send$/");
  results.testEmail = await sentTest;
  await page.waitForTimeout(1200);
  results.testEmailInSink = ((await fetch(SINK).then((r) => r.json())) as { to: string[] }[]).some((m) => m.to.includes("panel-test@example.com"));

  // backups: create, then delete from the list
  await page.goto(`${base}/_/#/settings/backups`, { waitUntil: "networkidle" }); await page.waitForTimeout(1200);
  results.backupInit = await clickText("button", "/^Initialize new backup$/");
  await page.waitForTimeout(600);
  await type('.modal input[name="name"]', "panel_backup_test.zip");
  const created = waitApi("POST", /^\/api\/backups$/, 60000);
  results.backupStart = await clickText(".modal .modal-footer button", "/^Start backup$/");
  results.backupCreate = await created;
  await page.waitForTimeout(1500);
  results.backupListed = (await text()).includes("panel_backup_test.zip");
  const deleted = waitApi("DELETE", /^\/api\/backups\//);
  results.backupMenu = await dom(`(() => { const row = [...document.querySelectorAll("table tr, .list-item, .backup-item, li")].find(r => r.textContent.includes("panel_backup_test.zip") && r.querySelector("button")); if (!row) return "no row"; const del = [...row.querySelectorAll("button, .dropdown-item")].find(b => /^\\s*Delete\\s*$/.test(b.textContent) || /delete/i.test(b.getAttribute("aria-label") || "")); if (del) { del.click(); return "delete clicked"; } const more = [...row.querySelectorAll("button")].find(b => b.querySelector(".ri-more-line, .ri-more-2-line")) || [...row.querySelectorAll("button")].pop(); if (!more) return "no buttons"; more.click(); return "menu opened"; })()`);
  await page.waitForTimeout(500);
  if (results.backupMenu === "menu opened") results.backupDeleteItem = await clickText(".dropdown .dropdown-item, .dropdown-item, button", "/^Delete$/");
  await page.waitForTimeout(500);
  results.backupConfirm = await clickText(".modal .modal-footer button, .modal button", "/^(Yes|Confirm|Delete)/");
  results.backupDelete = await deleted;
  await fetch(`${base}/api/backups/panel_backup_test.zip`, { method: "DELETE", headers: H }); // in case the UI path did not

  // crons: list and run one
  await page.goto(`${base}/_/#/settings/crons`, { waitUntil: "networkidle" }); await page.waitForTimeout(1200);
  results.cronsListed = (await text()).includes("__pbLogsCleanup__");
  const ran = waitApi("POST", /^\/api\/crons\//);
  results.cronRunClick = await dom(`(() => { const row = [...document.querySelectorAll("tr, .list-item")].find(r => r.textContent.includes("__pbLogsCleanup__")); const b = row && [...row.querySelectorAll("button")].find(b => /run/i.test(b.textContent) || /run/i.test(b.getAttribute("aria-label") || "")); if (!b) return "missing"; b.click(); return "clicked"; })()`);
  results.cronRun = await ran;

  // SQL console
  await page.goto(`${base}/_/#/settings/sql`, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
  await page.click(".editor-content"); await page.keyboard.press("Control+A"); await page.keyboard.type("SELECT email FROM _superusers");
  results.sqlTyped = String(await dom(`document.querySelector(".editor-content").textContent`)).includes("_superusers") ? "typed" : "not typed";
  const sql = waitApi("POST", /^\/api\/sql$/);
  results.sqlExecute = await clickText("button", "/^Execute$/");
  results.sql = await sql;
  await page.waitForTimeout(800);
  results.sqlShowsEmail = (await dom(`[...document.querySelectorAll("table td")].some(td => td.textContent.includes("admin@example.com"))`)) === true;

  // export and import pages render
  await page.goto(`${base}/_/#/settings/export-collections`, { waitUntil: "networkidle" }); await page.waitForTimeout(1200);
  results.exportShowsPosts = (await text()).includes('"posts"') || (await dom("document.body.innerText.includes('posts')")) === true;
  await page.goto(`${base}/_/#/settings/import-collections`, { waitUntil: "networkidle" }); await page.waitForTimeout(800);
  results.importPage = /import/i.test(await text());

  // auth record actions: users -> open user@example.com -> menu -> send verification email / impersonate
  await page.goto(`${base}/_/#/collections?collection=users`, { waitUntil: "networkidle" }); await page.waitForTimeout(1200);
  results.openUser = await dom(`(() => { const td = [...document.querySelectorAll("table td")].find(td => td.textContent.includes("user@example.com")); if (!td) return "missing"; td.click(); return "clicked"; })()`);
  await page.waitForTimeout(1000);
  results.recordModal = (await dom(`!!document.querySelector(".record-upsert-modal")`)) === true;
  await fetch(SINK, { method: "DELETE" });
  const verification = waitApi("POST", /request-verification$/);
  results.sendVerificationClick = await clickAny(".record-upsert-modal .dropdown button, .record-upsert-modal button", "/^Send verification email$/");
  await page.waitForTimeout(600);
  results.sendVerificationConfirm = await clickAny(".modal .modal-footer button", "/^(Yes|Send|Confirm)/");
  results.sendVerification = await verification;
  await page.waitForTimeout(1500);
  results.verificationMailInSink = ((await fetch(SINK).then((r) => r.json())) as { to: string[] }[]).some((m) => m.to.includes("user@example.com"));
  results.impersonateClick = await clickAny(".record-upsert-modal .dropdown button, .record-upsert-modal button", "/^Impersonate$/");
  await page.waitForTimeout(700);
  const imp = waitApi("POST", /impersonate\//);
  results.impersonateGenerate = await clickAny(".modal button", "/^Generate token$/");
  results.impersonate = await imp;
  await page.waitForTimeout(800);
  results.impersonateTokenShown = (await dom(`[...document.querySelectorAll(".modal textarea, .modal input, .modal code, .modal pre")].some(e => /ey[A-Za-z0-9_-]+\\./.test(e.value || e.textContent))`)) === true;
  await page.screenshot({ path: "/tmp/panel-admin.png" });
} finally { await browser.close(); await restore(); }
console.log(JSON.stringify(results, null, 1));
console.log("failed api:", failed.length ? failed : "none");
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");
const r = results as Record<string, unknown>;
const ok = (r.logs as { rows: number }).rows > 0 && r.appSave === 200 && r.appName === "Panel Renamed" && r.testEmail === 204 && r.testEmailInSink === true && r.backupCreate === 204 && r.backupListed === true && r.backupDelete === 204 && r.cronRun === 204 && r.sql === 200 && r.sqlShowsEmail === true && r.sendVerification === 204 && r.verificationMailInSink === true && r.impersonate === 200 && failed.length === 0;
console.log(ok ? "PANEL ADMIN OK" : "PANEL ADMIN FAILED");
process.exit(ok ? 0 : 1);
