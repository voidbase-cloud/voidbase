// Superuser password reset through the panel and the API preview modal, differential against the reference
// PocketBase panel (both unmodified UIs, both pointed at the shared SMTP sink).
//   bun test/smtp-sink.ts &   then   bun test/panel-login.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
import { chromium } from "playwright";
const PB = process.argv[2] ?? "http://127.0.0.1:8090"; const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const SINK = "http://127.0.0.1:2526/messages";
const NEW_PASSWORD = "changeme456x";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
interface Outcome { request: string; mailSubject: string; linkPath: string; confirmText: string; afterConfirmUrl: string; afterConfirmText: string; loginNew: number; restored: number; sections: string[]; sectionsWithBase: string[]; sdkTabs: string[] }

async function run(base: string): Promise<Outcome> {
  const login = async (pw: string) => fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: pw }) });
  const su = (await (await login("changeme123")).json()) as { token: string; record: { id: string } };
  const H = { authorization: su.token, "content-type": "application/json" };
  const settings = (await fetch(`${base}/api/settings`, { headers: H }).then((r) => r.json())) as { smtp: Record<string, unknown> };
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: H, body: JSON.stringify({ smtp: { enabled: true, host: "127.0.0.1", port: 2525, username: "", password: "", authMethod: "", tls: false, localName: "" } }) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const text = async () => ((await page.evaluate("document.body.innerText")) as string).replace(/\s+/g, " ").trim();
  const out = { sections: [], sectionsWithBase: [], sdkTabs: [] } as unknown as Outcome;
  try {
    // 1) "Forgotten password" page
    await fetch(SINK, { method: "DELETE" });
    await page.goto(`${base}/_/#/login`, { waitUntil: "networkidle" }); await page.waitForTimeout(500);
    await page.click("a:has-text('Forgotten password')"); await page.waitForTimeout(500);
    await page.fill("form input[type=email]", "admin@example.com"); await page.click("form button"); await page.waitForTimeout(2500);
    out.request = (await text()).replace(/^.*?(Check|Forgotten)/, "$1").slice(0, 80);
    // the resend limit may still hold from a previous run: retry through the API until the sink sees the mail
    let mail: { subject: string; html: string } | undefined;
    for (let i = 0; i < 30 && !mail; i++) {
      const mails = (await fetch(SINK).then((r) => r.json())) as { subject: string; html: string }[];
      mail = mails.find((m) => /confirm-password-reset/.test(m.html));
      if (!mail) { await Bun.sleep(12000); await fetch(`${base}/api/collections/_superusers/request-password-reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com" }) }); await Bun.sleep(2500); }
    }
    if (!mail) throw new Error("no password reset mail reached the sink");
    out.mailSubject = mail.subject;
    const href = new URL(/href="([^"]+confirm-password-reset[^"]+)"/.exec(mail.html)![1]!);
    out.linkPath = href.pathname + href.hash.replace(/\/eyJ[^/]+$/, "/<token>");
    // 2) confirm page from the email link, rewritten to this server's origin
    await page.goto(`${base}${href.pathname}${href.hash}`, { waitUntil: "networkidle" }); await page.waitForTimeout(800);
    out.confirmText = (await text()).slice(0, 120);
    await page.fill("form input[name=password]", NEW_PASSWORD); await page.fill("form input[name=passwordConfirm]", NEW_PASSWORD);
    await page.click("form button:has-text('Set new password')"); await page.waitForTimeout(2500);
    out.afterConfirmUrl = page.url().replace(base, "").replace(/\/eyJ[^/]+$/, "/<token>");
    out.afterConfirmText = (await text()).slice(0, 120);
    // 3) the new password works; restore the old one through the API
    const fresh = await login(NEW_PASSWORD); out.loginNew = fresh.status;
    const tok = fresh.status === 200 ? ((await fresh.json()) as { token: string }).token : su.token;
    const restore = await fetch(`${base}/api/collections/_superusers/records/${su.record.id}`, { method: "PATCH", headers: { authorization: tok, "content-type": "application/json" }, body: JSON.stringify({ password: "changeme123", passwordConfirm: "changeme123" }) });
    out.restored = restore.status;
    // 4) API preview modal: sections, SDK tabs, every section's snippets mention this server's URL
    await page.goto(`${base}/_/#/login`, { waitUntil: "networkidle" });
    await page.waitForSelector("form.auth-with-password-form input[name=identity]", { timeout: 20000 });
    await page.fill("form.auth-with-password-form input[name=identity]", "admin@example.com"); await page.fill("form.auth-with-password-form input[name=password]", "changeme123");
    await page.click("form.auth-with-password-form button.next"); await page.waitForURL(/#\/collections/, { timeout: 15000 }); await page.waitForTimeout(800);
    await page.goto(`${base}/_/#/collections?collection=posts`, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /API preview/i }).first().click(); await page.waitForSelector(".api-preview-modal .nav-item", { timeout: 10000 }); await page.waitForTimeout(500);
    const items = await page.$$(".api-preview-modal .nav-item");
    for (const it of items) {
      const label = ((await it.textContent()) ?? "").trim();
      await it.click(); await page.waitForTimeout(400);
      const content = ((await page.evaluate("document.querySelector('.api-preview-modal .api-preview-content').innerText")) as string).replace(/\s+/g, " ");
      out.sections.push(label);
      if (content.includes(base)) out.sectionsWithBase.push(label);
    }
    out.sdkTabs = (await page.evaluate("[...document.querySelectorAll('.api-preview-modal .sdk-examples .tabs-header .tab-item')].map(t => t.textContent.trim())")) as string[];
  } finally {
    await fetch(`${base}/api/settings`, { method: "PATCH", headers: { authorization: ((await (await login("changeme123")).json()) as { token: string }).token ?? su.token, "content-type": "application/json" }, body: JSON.stringify({ smtp: { ...settings.smtp, password: "" } }) });
    await page.close();
  }
  return out;
}

let pass = 0, fail = 0;
const pb = await run(PB); const vb = await run(VB);
for (const k of Object.keys(pb) as (keyof Outcome)[]) {
  const ok = JSON.stringify(pb[k]) === JSON.stringify(vb[k]);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${k}: ${JSON.stringify(vb[k]).slice(0, 110)}`);
  if (!ok) console.log(`   pb ${JSON.stringify(pb[k]).slice(0, 200)}`);
}
await browser.close();
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
