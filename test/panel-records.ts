// Drives the unmodified panel's record screens against voidbase: list, create, edit through the form; cleanup via API.
//   bun test/panel-records.ts [base=http://127.0.0.1:5180] [out=/tmp/panel-records.png]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5180";
const out = process.argv[3] ?? "/tmp/panel-records.png";
const COLL = "ui_rec";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failed: string[] = [];
const writes: string[] = [];
const consoleErrors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith("/api/") && r.request().method() !== "GET") writes.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
  if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${u.pathname}${u.search}`);
});
const dom = (fn: string) => page.evaluate(fn);
const clickText = (sel: string, re: string) => dom(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(b => ${re}.test(b.textContent)); if (!b) return "missing"; b.click(); return "clicked"; })()`);
const type = (sel: string, value: string) => dom(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return "missing"; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return "typed"; })()`);

const login = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: "changeme123" }) });
const token = ((await login.json()) as { token: string }).token;
const H = { Authorization: token, "content-type": "application/json" };
await fetch(`${base}/api/collections/${COLL}`, { method: "DELETE", headers: H });
const cc = await fetch(`${base}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: COLL, type: "base", fields: [{ name: "title", type: "text", required: true }, { name: "price", type: "number" }, { name: "active", type: "bool" }] }) });
console.log("setup collection:", cc.status);

await page.goto(`${base}/_/`, { waitUntil: "networkidle" });
await page.waitForSelector("form.auth-with-password-form input[name=identity]", { timeout: 20000 });
await page.fill("form.auth-with-password-form input[name=identity]", "admin@example.com");
await page.fill("form.auth-with-password-form input[name=password]", "changeme123");
await page.click("form.auth-with-password-form button.next");
await page.waitForURL(/#\/collections/, { timeout: 15000 });
await page.goto(`${base}/_/#/collections?collection=${COLL}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// create through the form
console.log("open new record:", await clickText("button", "/new record/i"));
await page.waitForTimeout(700);
console.log("title:", await type('textarea[name="title"], input[name="title"]', "Made in the panel"));
console.log("price:", await type('input[name="price"]', "42"));
const createResp = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/collections/${COLL}/records`, { timeout: 15000 });
console.log("create:", await clickText(".btns button", "/^\\s*Create\\s*$/"));
const cr = await createResp;
const created = (await cr.json()) as { id?: string; title?: string; price?: number; message?: string };
console.log(`POST records -> ${cr.status()}:`, created.id ? `${created.title} price=${created.price}` : JSON.stringify(created));
await page.waitForTimeout(1200);

// edit through the form: click the row, change the title, save
await page.goto(`${base}/_/#/collections?collection=${COLL}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const rowVisible = await dom(`document.body.innerText.includes("Made in the panel")`);
console.log("row listed:", rowVisible);
console.log("open row:", await dom(`(() => { const td = [...document.querySelectorAll("table td")].find(td => td.textContent.includes("Made in the panel")); if (!td) return "missing"; td.click(); return "clicked"; })()`));
await page.waitForTimeout(800);
console.log("edit title:", await type('textarea[name="title"], input[name="title"]', "Edited in the panel"));
const updResp = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname.startsWith(`/api/collections/${COLL}/records/`), { timeout: 15000 });
console.log("save:", await clickText(".btns button", "/save changes/i"));
const ur = await updResp;
const updated = (await ur.json()) as { title?: string; message?: string };
console.log(`PATCH record -> ${ur.status()}:`, updated.title ?? JSON.stringify(updated));
await page.waitForTimeout(800);
await page.screenshot({ path: out });

const del = await fetch(`${base}/api/collections/${COLL}`, { method: "DELETE", headers: H });
console.log("cleanup:", del.status);
console.log("write api calls:", writes);
console.log("failed requests:", failed.length ? failed : "none");
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");
await browser.close();
process.exit(cr.status() === 200 && ur.status() === 200 && updated.title === "Edited in the panel" && failed.length === 0 ? 0 : 1);
