// OAuth2 through the unmodified starter UI against voidbase: the SDK's realtime flow (popup -> mock provider ->
// /api/oauth2-redirect -> @oauth2 realtime message -> auth-with-oauth2) with test/mock-oidc.ts on 5190.
//   bun test/mock-oidc.ts &   then   bun test/starter-oauth2.ts [base=http://127.0.0.1:5180]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5180";
const MOCK = "http://127.0.0.1:5190";
const PROVIDER = { name: "oidc", clientId: "voidbase-test", clientSecret: "s3cret", authURL: `${MOCK}/authorize`, tokenURL: `${MOCK}/token`, userInfoURL: `${MOCK}/userinfo`, displayName: "Mock OIDC", pkce: true };
const su = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: "changeme123" }) }).then((r) => r.json()) as { token: string };
const H = { authorization: su.token, "content-type": "application/json" };
const users = await fetch(`${base}/api/collections/users`, { headers: H }).then((r) => r.json()) as { oauth2: Record<string, unknown> };
const cleanup = async () => {
  const list = await fetch(`${base}/api/collections/users/records?filter=${encodeURIComponent('email = "mock.user@example.com"')}`, { headers: H }).then((r) => r.json()) as { items: { id: string }[] };
  for (const it of list.items ?? []) await fetch(`${base}/api/collections/users/records/${it.id}`, { method: "DELETE", headers: H });
  await fetch(`${base}/api/collections/users`, { method: "PATCH", headers: H, body: JSON.stringify({ oauth2: { ...users.oauth2, enabled: false, providers: [] } }) });
};
await cleanup();
await fetch(`${base}/api/collections/users`, { method: "PATCH", headers: H, body: JSON.stringify({ oauth2: { enabled: true, providers: [PROVIDER], mappedFields: { id: "", name: "name", username: "username", avatarURL: "" } } }) });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const api: string[] = []; const consoleErrors: string[] = [];
page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) api.push(`${r.status()} ${r.request().method()} ${u.pathname}`); });
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
const results: Record<string, unknown> = {};
try {
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /sign in/i }).first().click();
  await page.waitForSelector('form input[placeholder="Enter email or username"]');
  const providerButton = page.getByRole("button", { name: /sign-in with oidc/i });
  results.providerButtonShown = await providerButton.isVisible({ timeout: 5000 }).catch(() => false);
  const popupPromise = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
  const authResp = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/collections/users/auth-with-oauth2", { timeout: 20000 }).catch(() => null);
  await providerButton.click();
  const popup = await popupPromise;
  results.popupOpened = !!popup;
  if (popup) { await popup.waitForLoadState("load").catch(() => {}); results.popupFinalUrl = popup.url().replace(/state=[^&]+/, "state=…").replace(/code=[^&]+/, "code=…"); }
  const resp = await authResp;
  results.authStatus = resp ? resp.status() : "timeout";
  const json = resp ? await resp.json().catch(() => null) as { record?: { email?: string; name?: string; verified?: boolean }; meta?: { isNew?: boolean } } | null : null;
  results.record = json?.record ? { email: json.record.email, name: json.record.name, verified: json.record.verified } : null;
  results.isNew = json?.meta?.isNew;
  await page.waitForTimeout(1500);
  results.signedInAs = (await page.locator("body").innerText()).includes("Mock User");
  results.popupClosed = popup ? popup.isClosed() : null;
  await page.screenshot({ path: "/tmp/starter-oauth2.png" });
} finally {
  await browser.close();
  await cleanup();
}
console.log(JSON.stringify(results, null, 1));
console.log("api:", api.filter((l) => /oauth2|realtime|auth-methods/.test(l)));
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");
const ok = results.providerButtonShown === true && results.popupOpened === true && results.authStatus === 200 && results.signedInAs === true && results.isNew === true;
console.log(ok ? "OAUTH2 UI OK" : "OAUTH2 UI FAILED");
process.exit(ok ? 0 : 1);
