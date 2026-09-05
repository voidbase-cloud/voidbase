// Drives the unmodified pocketbase-sveltekit-starter (its Vite dev server proxying /api to voidbase).
//   bun test/starter-smoke.ts [starter=http://127.0.0.1:5174] [out=/tmp/starter.png]
//
// The starter's own "New Post" edit form crashes in Svelte 5 (FileInput renders an undefined
// `children` snippet) against PocketBase and voidbase alike, so the post is created through the
// API and the starter is checked for what it does with it: realtime list update, view page,
// audit log (hook-written), hello (hook route), generate (hook route with outbound http + files)
// and the delete flow.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5174";
const out = process.argv[3] ?? "/tmp/starter.png";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failed: string[] = [];
const consoleErrors: string[] = [];
const api: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message.slice(0, 200)));
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith("/api/")) api.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
  if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${u.pathname}${u.search}`);
});
const results: Record<string, unknown> = {};
const text = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
const waitForText = async (needle: string, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if ((await text()).includes(needle)) return true; await page.waitForTimeout(250); }
  return false;
};

// home: config comes from the starter's own /api/config hook
await page.goto(`${base}/`, { waitUntil: "networkidle" });
results.title = await page.title();
results.footer = (await page.locator("footer").innerText()).replace(/\s+/g, " ").trim();

// login through the LoginBadge dialog
await page.getByRole("button", { name: /sign in/i }).first().click();
await page.waitForSelector('form input[placeholder="Enter email or username"]', { timeout: 10000 });
await page.fill('form input[placeholder="Enter email or username"]', "user@example.com");
await page.fill('form input[placeholder="Enter password"]', "changeme123");
await page.locator('form button[type="submit"]').first().click();
await page.waitForTimeout(1500);
results.signedIn = /Signed in as|user@example.com/.test(await text());

// posts list: thumbnails and realtime subscription
await page.goto(`${base}/posts/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
results.postsListed = await page.locator("a.post").count();
const fileReqs = api.filter((l) => l.includes("GET /api/files/"));
results.thumbStatus = fileReqs.length ? (fileReqs.every((l) => l.startsWith("200")) ? "200" : fileReqs.join(" | ")) : "none";
results.realtimeSubscribed = api.some((l) => l.includes("GET /api/realtime")) && api.some((l) => l === "204 POST /api/realtime");

// create a post through the API as the same user; the open page must pick it up over realtime
const auth = await fetch(`${base}/api/collections/users/auth-with-password`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ identity: "user@example.com", password: "changeme123" }),
}).then((r) => r.json()) as { token: string; record: { id: string } };
const stamp = Date.now();
const title = `Starter smoke ${stamp}`;
const slug = `starter-smoke-${stamp}`;
const cr = await fetch(`${base}/api/collections/posts/records`, {
  method: "POST", headers: { "content-type": "application/json", authorization: auth.token },
  body: JSON.stringify({ title, slug, body: "Created through the API while the starter was watching.", user: auth.record.id }),
});
results.createStatus = cr.status;
const created = (await cr.json()) as { id: string; slug: string };
results.realtimeCreateSeen = await waitForText(title, 6000);

// generate: the starter's hook route ($http.send + $filesystem.fileFromURL + RecordUpsertForm)
const before = await page.locator("a.post").count();
const genResp = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/generate", { timeout: 30000 }).catch(() => null);
await page.getByRole("button", { name: /generate/i }).first().click();
const gen = await genResp;
results.generateStatus = gen ? gen.status() : "timeout";
if (gen && gen.status() === 200) {
  const until = Date.now() + 6000;
  while (Date.now() < until && (await page.locator("a.post").count()) <= before) await page.waitForTimeout(250);
  results.generateSeenViaRealtime = (await page.locator("a.post").count()) > before;
}

// view page for the created post (layout loader: id = {:slug} || slug = {:slug})
await page.goto(`${base}/posts/${slug}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
results.viewHeadline = (await page.locator("main h1").first().innerText()).trim();
results.viewBody = (await page.locator("pre.body").innerText().catch(() => "")).trim();

// audit log tab (auditlog.pb.js hook wrote the create event; page filters + expands user)
await page.goto(`${base}/posts/${slug}/?active=auditlog`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
results.auditRows = await page.locator("table tbody tr").count();
results.auditText = (await page.locator("table").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);

// hello page: the starter's hook route with $apis.requireAuth()
await page.goto(`${base}/hello/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
results.hello = (await page.locator("pre.card").innerText().catch(() => "")).replace(/\s+/g, " ");

// delete flow: Delete component -> SDK delete -> back to /posts/
await page.goto(`${base}/posts/${slug}/?active=delete`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const delResp = page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname.endsWith(`/records/${created.id}`), { timeout: 10000 }).catch(() => null);
await page.getByRole("button", { name: /yes - delete/i }).click();
const del = await delResp;
results.deleteStatus = del ? del.status() : "timeout";
await page.waitForTimeout(1200);
results.afterDeleteUrl = page.url();
results.deletedGone = !(await text()).includes(title);
await page.screenshot({ path: out });
await browser.close();

// clean up what Generate created during this run (the API-created post was deleted through the UI)
const since = new Date(stamp - 5000).toISOString().replace("T", " ");
const leftovers = await fetch(`${base}/api/collections/posts/records?perPage=50&filter=${encodeURIComponent(`created >= "${since}"`)}`, { headers: { authorization: auth.token } }).then((r) => r.json()) as { items: { id: string }[] };
for (const p of leftovers.items ?? []) await fetch(`${base}/api/collections/posts/records/${p.id}`, { method: "DELETE", headers: { authorization: auth.token } });
results.cleanedUp = (leftovers.items ?? []).length;

console.log(JSON.stringify(results, null, 1));
console.log("api calls:", api.length, "| failed:", failed.length ? failed : "none");
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 6) : "none");
const ok = String(results.title).includes("Acme") && results.signedIn === true && Number(results.postsListed) >= 1
  && results.thumbStatus === "200" && results.realtimeSubscribed === true
  && results.createStatus === 200 && results.realtimeCreateSeen === true
  && results.viewHeadline === title && String(results.viewBody).startsWith("Created through the API")
  && Number(results.auditRows) >= 1 && String(results.hello).includes("Hello")
  && results.deleteStatus === 204 && /\/(posts\/)?$/.test(String(results.afterDeleteUrl)) && results.deletedGone === true
  && failed.length === 0;
console.log(ok ? "STARTER SMOKE OK" : "STARTER SMOKE FAILED");
process.exit(ok ? 0 : 1);
