// Drives the unmodified panel's collection editor against voidbase: create a collection with two fields
// through the UI, open the editor of an imported collection, then clean up through the API.
// The 0.40 panel re-renders its DOM on every state tick, so actions run as in-page DOM calls.
//   bun test/panel-collections.ts [base=http://127.0.0.1:5180] [out=/tmp/panel-collections.png]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5180";
const out = process.argv[3] ?? "/tmp/panel-collections.png";
const NAME = "ui_smoke";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failed: string[] = [];
const writes: string[] = [];
const consoleErrors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith("/api/") && r.request().method() !== "GET") writes.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
  if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
});
const dom = (fn: string) => page.evaluate(fn);
const click = (sel: string, nth = 0) => dom(`(() => { const els = document.querySelectorAll(${JSON.stringify(sel)}); const el = els[${nth}]; if (!el) return "missing"; el.click(); return "clicked"; })()`);
const type = (sel: string, value: string) => dom(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return "missing"; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return "typed"; })()`);

const login = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: "changeme123" }) });
const token = ((await login.json()) as { token: string }).token;
await fetch(`${base}/api/collections/${NAME}`, { method: "DELETE", headers: { Authorization: token } });

await page.goto(`${base}/_/`, { waitUntil: "networkidle" });
await page.waitForSelector("form.auth-with-password-form input[name=identity]", { timeout: 20000 });
await page.fill("form.auth-with-password-form input[name=identity]", "admin@example.com");
await page.fill("form.auth-with-password-form input[name=password]", "changeme123");
await page.click("form.auth-with-password-form button.next");
await page.waitForURL(/#\/collections/, { timeout: 15000 });
await page.waitForTimeout(800);

// 1) create a collection through the UI
console.log("open modal:", await dom(`(() => { const b = [...document.querySelectorAll("button")].find(b => /new collection/i.test(b.textContent)); if (!b) return "missing"; b.click(); return "clicked"; })()`));
await page.waitForTimeout(600);
console.log("name:", await type('input[name="name"][placeholder="e.g. posts"]', NAME));
const labels: string[] = [];
for (let i = 0; i < 2; i++) {
  await click(".new-collection-field-btn-wrapper button");
  await page.waitForTimeout(300);
  const picked = await dom(`(() => { const items = document.querySelectorAll(".field-types-dropdown .dropdown-item"); const el = items[${i}]; if (!el) return "missing"; const label = el.textContent.trim(); el.click(); return label; })()`);
  labels.push(String(picked));
  await page.waitForTimeout(300);
}
console.log("fields added via UI:", labels.join(" | "));
const createResp = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/collections", { timeout: 15000 });
console.log("create:", await dom(`(() => { const b = [...document.querySelectorAll(".btns button")].find(b => /^\\s*Create\\s*$/.test(b.textContent)); if (!b) return "missing"; b.click(); return "clicked"; })()`));
const cr = await createResp;
const body = (await cr.json()) as { fields?: { name: string; type: string }[]; message?: string; data?: unknown };
console.log(`POST /api/collections -> ${cr.status()}:`, body.fields ? body.fields.map((f) => `${f.name}:${f.type}`).join(", ") : JSON.stringify(body));
await page.waitForTimeout(1200);
const sidebarHas = await dom(`document.body.innerText.includes(${JSON.stringify(NAME)})`);
console.log("collection visible in panel:", sidebarHas);

// 2) open the editor of an imported collection
await page.goto(`${base}/_/#/collections?collection=posts`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
console.log("open editor:", await click(".btn-collection-settings"));
await page.waitForTimeout(800);
const editorState = await dom(`(() => { const i = document.querySelector('input[name="name"][placeholder="e.g. posts"]'); const fields = [...document.querySelectorAll(".field-types-dropdown")].length; const text = document.body.innerText; return { name: i && i.value, fieldEditor: fields > 0, showsFields: ["title","body","slug","files","user"].every(f => text.includes(f)) }; })()`);
console.log("editor:", JSON.stringify(editorState));
await page.screenshot({ path: out });

const del = await fetch(`${base}/api/collections/${NAME}`, { method: "DELETE", headers: { Authorization: token } });
console.log("cleanup delete:", del.status);
console.log("write api calls:", writes);
console.log("failed requests:", failed.length ? failed : "none");
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");
await browser.close();
const es = editorState as { name: string; showsFields: boolean };
const ok = cr.status() === 200 && !!body.fields && body.fields.length >= 5 && es.name === "posts" && es.showsFields && failed.length === 0;
process.exit(ok ? 0 : 1);
