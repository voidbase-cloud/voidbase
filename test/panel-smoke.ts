// Drives the unmodified PocketBase admin panel served by voidbase: login, land on the collections page.
//   bun test/panel-smoke.ts [base=http://127.0.0.1:5180] [out=/tmp/panel.png]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5180";
const out = process.argv[3] ?? "/tmp/panel.png";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors: string[] = [];
const failed: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
const failedOther: string[] = [];
page.on("response", (r) => {
  if (r.status() < 400) return;
  const line = `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`;
  (r.url().includes("/api/") ? failed : failedOther).push(line);
});

await page.goto(`${base}/_/`, { waitUntil: "networkidle" });
console.log("title:", await page.title(), "| url:", page.url());
// The 0.40 panel builds the form in JS: input[name=identity], input[name=password], button.next inside form.auth-with-password-form
await page.waitForSelector("form.auth-with-password-form input[name=identity]", { timeout: 20000 });
await page.fill("form.auth-with-password-form input[name=identity]", "admin@example.com");
await page.fill("form.auth-with-password-form input[name=password]", "changeme123");
await page.click("form.auth-with-password-form button.next");
await page.waitForURL(/#\/collections/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
console.log("after login url:", page.url());
const sidebar = await page.locator(".sidebar-list, .page-sidebar, aside").first().innerText().catch(() => "");
console.log("sidebar:", sidebar.replace(/\s+/g, " ").slice(0, 200));
const toasts = await page.locator(".toast, .alert").allInnerTexts().catch(() => []);
if (toasts.length) console.log("toasts:", toasts);
await page.screenshot({ path: out, fullPage: false });
console.log("screenshot:", out);
console.log("api failures:", failed.length ? failed : "none");
console.log("other failed requests:", failedOther.length ? failedOther : "none");
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");
await browser.close();
process.exit(failed.length || !/#\/collections/.test(page.url()) ? 1 : 0);
