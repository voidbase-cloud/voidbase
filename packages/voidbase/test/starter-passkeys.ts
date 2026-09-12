// Passkeys through the unmodified starter UI against voidbase's /api/webauthn routes, using Chrome's virtual
// authenticator (CDP WebAuthn domain). WebAuthn needs a registrable RP ID, so the app is reached via localhost.
//   bun test/starter-passkeys.ts [base=http://localhost:5180]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5180";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const api: string[] = [];
const consoleErrors: string[] = [];
page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/webauthn")) api.push(`${r.status()} ${r.request().method()} ${u.pathname}`); });
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message.slice(0, 200)));
const results: Record<string, unknown> = {};
const text = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");

await page.goto(`${base}/`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /sign in/i }).first().click();
await page.waitForSelector('form input[placeholder="Enter email or username"]');
await page.fill('form input[placeholder="Enter email or username"]', "user@example.com");
await page.fill('form input[placeholder="Enter password"]', "changeme123");
await page.locator('form button[type="submit"]').first().click();
await page.waitForTimeout(1200);
results.passwordSignIn = /user@example.com|Signed in/.test(await text());

// register a passkey from the signed-in badge dialog
await page.locator("button.badge").first().click();
const reg = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/webauthn/register", { timeout: 15000 }).catch(() => null);
await page.getByRole("button", { name: /register passkey/i }).click();
const regResp = await reg;
results.registerStatus = regResp ? regResp.status() : "timeout";
results.registerBody = regResp ? await regResp.text().catch(() => "") : "";
await page.waitForTimeout(800);
// informational only: the toast renders inside the badge dialog, which may already be closed
results.registerAlert = (await page.locator('[role="alert"]').allInnerTexts().catch(() => [] as string[])).some((t) => t.includes("Passkey registered successfully."));

console.log("after registration:", JSON.stringify(results));
// sign out (the badge dialog may have closed with the alert), then sign in with the passkey
if (!(await page.getByRole("button", { name: /sign out/i }).isVisible().catch(() => false))) {
  await page.keyboard.press("Escape");
  await page.locator("button.badge").first().click();
}
try {
  await page.getByRole("button", { name: /sign out/i }).click({ timeout: 10000 });
} catch (e) {
  console.log("visible buttons:", await page.locator("button:visible").allInnerTexts());
  console.log("body:", (await text()).slice(0, 300));
  throw e;
}
await page.waitForTimeout(800);
await page.keyboard.press("Escape");
await page.getByRole("button", { name: /sign in/i }).first().click();
await page.waitForSelector('form input[placeholder="Enter email or username"]');
await page.fill('form input[placeholder="Enter email or username"]', "user@example.com");
await page.getByLabel(/sign-in with passkey/i).check();
const login = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/webauthn/login", { timeout: 15000 }).catch(() => null);
await page.locator('form button[type="submit"]').first().click();
const loginResp = await login;
results.loginStatus = loginResp ? loginResp.status() : "timeout";
const loginJson = loginResp ? await loginResp.json().catch(() => null) as { token?: string; record?: { email?: string } } | null : null;
results.loginToken = !!loginJson?.token;
results.loginRecordEmail = loginJson?.record?.email;
await page.waitForTimeout(1000);
results.passkeySignedIn = /user@example.com|Signed in/.test(await text());
await page.screenshot({ path: "/tmp/starter-passkeys.png" });
await browser.close();

// the passkey record is visible to its owner and can be removed by them (the collection's rules)
const auth = await fetch(`${base}/api/collections/users/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "user@example.com", password: "changeme123" }) }).then((r) => r.json()) as { token: string; record: { id: string } };
const list = await fetch(`${base}/api/collections/passkeys/records?filter=${encodeURIComponent(`user = "${auth.record.id}"`)}`, { headers: { authorization: auth.token } }).then((r) => r.json()) as { items: { id: string; credential_id: string }[] };
results.passkeyRecords = list.items?.length ?? 0;
for (const p of list.items ?? []) await fetch(`${base}/api/collections/passkeys/records/${p.id}`, { method: "DELETE", headers: { authorization: auth.token } });

console.log(JSON.stringify(results, null, 1));
console.log("webauthn calls:", api);
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");
const ok = results.passwordSignIn === true && results.registerStatus === 200 && results.loginStatus === 200 && results.loginToken === true && results.passkeySignedIn === true && Number(results.passkeyRecords) >= 1;
console.log(ok ? "PASSKEYS OK" : "PASSKEYS FAILED");
process.exit(ok ? 0 : 1);
