// Logs and crons APIs against PocketBase: request log rows (shape, data keys, levels, filters, stats, view,
// truncate) and the cron registry (list, run, unknown).
//   bun test/conformance/logs-crons.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
class Server {
  h: Record<string, string> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: Record<string, unknown> | null = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json };
  }
  async setup() { const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) }; }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(44)} pb=${JSON.stringify(a).slice(0, 360)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 700)}`}`);
};
const marker = `logtest-${Date.now()}`;
try {
  await step("truncate logs (0.40 API; the 0.39 reference has no truncate)", async (s) => { const r = await s.api("DELETE", "/api/logs", undefined, s.h); return { accepted: r.status === 204 || r.status === 404 }; });
  await step("generate traffic", async (s) => { await s.api("GET", `/api/collections/posts/records?perPage=1&${marker}=1`, undefined, { "user-agent": "logtest-agent", referer: "http://logtest.example/" }); await s.api("GET", `/api/collections/nope-${marker}/records`); await s.api("GET", "/api/health", undefined, s.h); await Bun.sleep(6000) /* PocketBase flushes its log writer in batches */; return { ok: true }; });
  await step("request log rows (shape and data keys)", async (s) => {
    const r = await s.api("GET", `/api/logs?filter=${encodeURIComponent(`data.url ~ "${marker}"`)}&sort=created`, undefined, s.h);
    const items = (r.json?.items as Record<string, unknown>[]) ?? [];
    return { status: r.status, total: r.json?.totalItems, keys: Object.keys(r.json ?? {}).sort(), items: items.map((it) => { const d = it.data as Record<string, unknown>; return { itemKeys: Object.keys(it), dataKeys: Object.keys(d).sort(), level: it.level, message: String(it.message).replace(marker, "M"), type: d.type, method: d.method, status: d.status, auth: d.auth, error: d.error, hasDetails: "details" in d, userAgent: d.userAgent, referer: d.referer, execTimeIsNumber: typeof d.execTime === "number", hasUserIP: typeof d.userIP === "string" }; }) };
  });
  await step("filter by status and level", async (s) => { const r = await s.api("GET", `/api/logs?filter=${encodeURIComponent(`data.status = 404 && level = 8 && data.url ~ "${marker}"`)}`, undefined, s.h); return { status: r.status, total: r.json?.totalItems }; });
  await step("authenticated request logs the collection", async (s) => { const r = await s.api("GET", `/api/logs?filter=${encodeURIComponent('data.url = "/api/health" && data.auth = "_superusers"')}&sort=-created&perPage=1`, undefined, s.h); const it = ((r.json?.items as Record<string, unknown>[]) ?? [])[0]; return { status: r.status, found: !!it, auth: (it?.data as { auth?: string })?.auth, authIdLogged: "authId" in ((it?.data as object) ?? {}) }; });
  await step("view a log", async (s) => { const l = await s.api("GET", `/api/logs?filter=${encodeURIComponent(`data.url ~ "${marker}"`)}&perPage=1`, undefined, s.h); const id = String(((l.json?.items as { id: string }[]) ?? [])[0]?.id); const r = await s.api("GET", `/api/logs/${id}`, undefined, s.h); return { status: r.status, keys: Object.keys(r.json ?? {}), sameId: r.json?.id === id }; });
  await step("view unknown log", async (s) => { const r = await s.api("GET", "/api/logs/nopenopenopenop", undefined, s.h); return { status: r.status, body: r.json }; });
  await step("stats", async (s) => { const r = await s.api("GET", `/api/logs/stats?filter=${encodeURIComponent(`data.url ~ "${marker}"`)}`, undefined, s.h); const items = (r.json as unknown as { date: string; total: number }[]) ?? []; return { status: r.status, buckets: items.length, keys: Object.keys(items[0] ?? {}).sort(), total: items.reduce((n, i) => n + i.total, 0), dateShape: /^\d{4}-\d{2}-\d{2} \d{2}:00:00\.000Z$/.test(items[0]?.date ?? "") }; });
  await step("bad filter", async (s) => { const r = await s.api("GET", "/api/logs?filter=data.status%20~~%20x", undefined, s.h); return { status: r.status }; });
  await step("logs require superuser", async (s) => { const r = await s.api("GET", "/api/logs"); return { status: r.status, body: r.json }; });
  await step("crons list (PocketBase ids)", async (s) => { const r = await s.api("GET", "/api/crons", undefined, s.h); const jobs = (r.json as unknown as { id: string; expr: string }[]) ?? []; return { status: r.status, jobs: jobs.filter((j) => !j.id.startsWith("__vb")) }; });
  await step("run a cron", async (s) => { const r = await s.api("POST", "/api/crons/__pbLogsCleanup__", undefined, s.h); return { status: r.status }; });
  await step("run unknown cron", async (s) => { const r = await s.api("POST", "/api/crons/nope", undefined, s.h); return { status: r.status, body: r.json }; });
  await step("crons require superuser", async (s) => { const r = await s.api("GET", "/api/crons"); return { status: r.status, body: r.json }; });
} finally { /* nothing to restore */ }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
