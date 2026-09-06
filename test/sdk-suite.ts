// SDK coverage matrix: every service method of the unmodified `pocketbase` JS SDK (0.28) executed live against the
// reference PocketBase and voidbase, results normalized and compared. Needs test/smtp-sink.ts running.
//   bun test/smtp-sink.ts &   then   bun test/sdk-suite.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
import PocketBase, { ClientResponseError, type RecordModel } from "pocketbase";
const PB = process.argv[2] ?? "http://127.0.0.1:8090"; const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const SINK = "http://127.0.0.1:2526/messages";

// Bun has no EventSource: a small fetch-based one with the surface the SDK's RealtimeService uses.
class FetchEventSource {
  private listeners = new Map<string, Set<(e: { data: string; lastEventId: string }) => void>>();
  private ac = new AbortController();
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null;
  readyState = 0;
  constructor(public url: string) { void this.run(); }
  addEventListener(name: string, cb: (e: { data: string; lastEventId: string }) => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(cb); }
  removeEventListener(name: string, cb: (e: { data: string; lastEventId: string }) => void) { this.listeners.get(name)?.delete(cb); }
  close() { this.readyState = 2; this.ac.abort(); }
  private async run() {
    try {
      const res = await fetch(this.url, { headers: { Accept: "text/event-stream" }, signal: this.ac.signal });
      this.readyState = 1;
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = { name: "message", data: "", lastEventId: "" };
          for (const line of chunk.split("\n")) { if (line.startsWith("event:")) ev.name = line.slice(6).trim(); else if (line.startsWith("data:")) ev.data += line.slice(5).trim(); else if (line.startsWith("id:")) ev.lastEventId = line.slice(3).trim(); }
          const e = { data: ev.data, lastEventId: ev.lastEventId };
          for (const cb of this.listeners.get(ev.name) ?? []) cb(e);
          if (ev.name === "message") this.onmessage?.(e);
        }
      }
    } catch (e) { if (!this.ac.signal.aborted) this.onerror?.(e); }
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FetchEventSource;

// --- normalization: ids, tokens, dates, random file suffixes and this run's emails become placeholders
const stamp = Date.now();
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      if (["token", "tokenKey", "created", "updated", "exp", "secret", "key", "modified", "size", "id", "otpId", "mfaId", "recordId", "clientId", "execTime"].includes(k)) { out[k] = typeof (v as Record<string, unknown>)[k]; continue; }
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof v === "string") {
    return v.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>").replace(/\b[a-z0-9]{15}\b/g, "<id>").replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<date>")
      .replace(/_[a-zA-Z0-9]{10}\.(\w+)/g, "_<rand>.$1").replace(String(stamp), "<stamp>").replace(/https?:\/\/[^/"' ]+/g, "<origin>").replace(/pbc_\d+/g, "<pbc>").replace(/users\d{6}/g, "users<n>");
  }
  return v;
}
const fail = (e: unknown) => e instanceof ClientResponseError ? { error: e.status, message: e.response?.message ?? e.message, data: norm(e.response?.data ?? {}) } : { error: -1, message: e instanceof Error ? e.message : String(e) };
const sinkClear = () => fetch(SINK, { method: "DELETE" });
async function sinkWait(pred: (m: { subject: string; html: string; to: string[] }) => boolean, ms = 8000) { const until = Date.now() + ms; for (;;) { const list = (await fetch(SINK).then((r) => r.json())) as { subject: string; html: string; to: string[] }[]; const m = list.find(pred); if (m || Date.now() > until) return m; await Bun.sleep(200); } }
const tokenOf = (m?: { html: string }) => /\/(eyJ[A-Za-z0-9_.-]+)/.exec(m?.html ?? "")?.[1] ?? "";

interface S { pb: PocketBase; base: string; su: PocketBase; email: string; userId: string; user: PocketBase; post?: RecordModel; backup?: string; saved: { smtp: unknown; batch: unknown } }
type Step = { name: string; run: (s: S) => Promise<unknown> };
const steps: Step[] = [
  { name: "health.check", run: async (s) => norm(await s.pb.health.check()) },
  { name: "client.buildURL / filter", run: async (s) => ({ url: s.pb.buildURL("/api/health").replace(s.base, "<origin>"), filter: s.pb.filter("title = {:t} && n > {:n}", { t: "a'b", n: 1 }) }) },
  { name: "client.send raw", run: async (s) => norm(await s.pb.send("/api/health", { method: "GET" })) },
  { name: "authStore export/load cookie", run: async (s) => { const c = s.su.authStore.exportToCookie({ httpOnly: false }); const other = new PocketBase(s.base); other.authStore.loadFromCookie(c); return { valid: other.authStore.isValid, superuser: other.authStore.isSuperuser, record: !!other.authStore.record }; } },
  // collections
  { name: "collections.getScaffolds", run: async (s) => Object.keys(await s.su.collections.getScaffolds()).sort() },
  { name: "collections.getAllOAuth2Providers", run: async (s) => { const p = await s.su.collections.getAllOAuth2Providers(); return { count: p.length >= 30, google: p.some((x) => x.name === "google") }; } },
  { name: "collections.create (auth) + getOne + getList + update", run: async (s) => {
    try { await s.su.collections.delete("ks_sdk"); } catch { /* absent */ }
    const created = await s.su.collections.create({ name: "ks_sdk", type: "base", fields: [{ name: "title", type: "text", required: true }, { name: "n", type: "number" }, { name: "pic", type: "file", maxSelect: 1, thumbs: ["100x100"] }], listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "" });
    const one = await s.su.collections.getOne("ks_sdk");
    const list = await s.su.collections.getList(1, 100, { filter: "name = 'ks_sdk'" });
    const updated = await s.su.collections.update("ks_sdk", { listRule: "@request.auth.id != '' || n > 0" });
    return norm({ created: Object.keys(created).sort(), same: one.id === created.id, listed: list.totalItems, listRule: updated.listRule, fields: (updated.fields as { name: string }[]).map((f) => f.name) });
  } },
  { name: "collections.create invalid", run: async (s) => { try { return await s.su.collections.create({ name: "1bad_sdk", type: "nope" }); } catch (e) { return fail(e); } } },
  { name: "collections.dryRunViewQuery (0.40)", run: async (s) => { try { const r = await (s.su.collections as unknown as { dryRunViewQuery: (q: string) => Promise<unknown> }).dryRunViewQuery("select id, title from ks_sdk"); return norm(r); } catch (e) { const f = fail(e); return f.error === 404 ? "unsupported (404)" : f; } } },
  { name: "collections.import (upsert ks_sdk2)", run: async (s) => { await s.su.collections.import([{ name: "ks_sdk2", type: "base", fields: [{ name: "x", type: "text" }] }], false); const c = await s.su.collections.getOne("ks_sdk2"); await s.su.collections.delete("ks_sdk2"); return { type: c.type, fields: (c.fields as { name: string }[]).map((f) => f.name).sort() }; } },
  // records
  { name: "records.create + getOne + getList + getFirstListItem + getFullList + update", run: async (s) => {
    const col = s.su.collection("ks_sdk");
    const a = await col.create({ title: "a", n: 1 }); const b = await col.create({ title: "b", n: 2 });
    const one = await col.getOne(a.id, { fields: "id,title" });
    const list = await col.getList(1, 1, { filter: "n > 0", sort: "-n", skipTotal: false });
    const first = await col.getFirstListItem("n = 2");
    const full = await col.getFullList({ batch: 1, sort: "n" });
    const up = await col.update(a.id, { "n+": 5 });
    return norm({ one, listed: [list.totalItems, list.items[0]?.title], first: first.title, full: full.map((r) => r.title), n: up.n, b: b.title });
  } },
  { name: "records.create validation error", run: async (s) => { try { return await s.su.collection("ks_sdk").create({ n: "x" }); } catch (e) { return fail(e); } } },
  { name: "records.getOne missing", run: async (s) => { try { return await s.su.collection("ks_sdk").getOne("nope"); } catch (e) { return fail(e); } } },
  { name: "records.getFirstListItem no match", run: async (s) => { try { return await s.su.collection("ks_sdk").getFirstListItem("n = 999"); } catch (e) { return fail(e); } } },
  { name: "records.create with file + files.getURL + thumb + files.getToken", run: async (s) => {
    const fd = new FormData(); fd.append("title", "pic"); fd.append("n", "3");
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    fd.append("pic", new Blob([png], { type: "image/png" }), "dot.png");
    const rec = await s.su.collection("ks_sdk").create(fd); s.post = rec;
    const url = s.su.files.getURL(rec, rec.pic as string); const thumb = s.su.files.getURL(rec, rec.pic as string, { thumb: "100x100" });
    const [r1, r2] = await Promise.all([fetch(url), fetch(thumb)]);
    const token = await s.user.files.getToken();
    return norm({ file: String(rec.pic), status: [r1.status, r2.status], types: [r1.headers.get("content-type"), r2.headers.get("content-type")], token: token.split(".").length });
  } },
  { name: "records.delete + missing delete", run: async (s) => { await s.su.collection("ks_sdk").delete(s.post!.id); try { await s.su.collection("ks_sdk").delete(s.post!.id); return "deleted twice"; } catch (e) { return fail(e); } } },
  // auth
  { name: "records.listAuthMethods", run: async (s) => norm(await s.pb.collection("users").listAuthMethods()) },
  { name: "records.authWithPassword wrong", run: async (s) => { try { return await new PocketBase(s.base).collection("users").authWithPassword(s.email, "wrong"); } catch (e) { return fail(e); } } },
  { name: "records.authRefresh", run: async (s) => norm(await s.user.collection("users").authRefresh()) },
  { name: "records.requestVerification + confirmVerification", run: async (s) => {
    await sinkClear(); await s.user.collection("users").requestVerification(s.email);
    const m = await sinkWait((x) => x.to.includes(s.email) && /verif/i.test(x.subject)); const token = tokenOf(m);
    await s.pb.collection("users").confirmVerification(token);
    const rec = await s.su.collection("users").getOne(s.userId);
    return { subject: m?.subject, verified: rec.verified };
  } },
  { name: "records.requestPasswordReset + confirmPasswordReset", run: async (s) => {
    await sinkClear(); await s.pb.collection("users").requestPasswordReset(s.email);
    const m = await sinkWait((x) => x.to.includes(s.email) && /password/i.test(x.subject)); const token = tokenOf(m);
    await s.pb.collection("users").confirmPasswordReset(token, "changeme456x", "changeme456x");
    const again = await new PocketBase(s.base).collection("users").authWithPassword(s.email, "changeme456x");
    await s.su.collection("users").update(s.userId, { password: "changeme123", passwordConfirm: "changeme123" });
    await s.user.collection("users").authWithPassword(s.email, "changeme123");
    return { subject: m?.subject, relogin: !!again.token };
  } },
  { name: "records.requestEmailChange + confirmEmailChange", run: async (s) => {
    await sinkClear(); const next = `sdk-${stamp}-next@example.com`;
    await s.user.collection("users").requestEmailChange(next);
    const m = await sinkWait((x) => x.to.includes(next)); const token = tokenOf(m);
    await s.pb.collection("users").confirmEmailChange(token, "changeme123");
    const rec = await s.su.collection("users").getOne(s.userId);
    await s.su.collection("users").update(s.userId, { email: s.email });
    await s.user.collection("users").authWithPassword(s.email, "changeme123");
    return { subject: m?.subject, changed: rec.email === next };
  } },
  { name: "records.requestOTP + authWithOTP", run: async (s) => {
    await s.su.collections.update("users", { otp: { enabled: true, duration: 180, length: 8 } });
    await sinkClear(); const req = await s.pb.collection("users").requestOTP(s.email);
    const m = await sinkWait((x) => x.to.includes(s.email) && /otp|one-time|code/i.test(x.subject + x.html));
    const code = /<strong[^>]*>\s*(\d{8})\s*<\/strong>|\b(\d{8})\b/.exec((m?.html ?? "").replace(/<[^>]+>/g, " "))?.[2] ?? /\b(\d{8})\b/.exec(m?.html ?? "")?.[1] ?? "";
    const auth = await new PocketBase(s.base).collection("users").authWithOTP(req.otpId, code);
    await s.su.collections.update("users", { otp: { enabled: false } });
    const after = (await s.su.collections.getOne("users")).otp as Record<string, unknown>;
    return norm({ otpId: typeof req.otpId, subject: m?.subject, authed: !!auth.token, record: auth.record.email, otpAfter: after });
  } },
  { name: "records.authWithOTP wrong", run: async (s) => { try { return await s.pb.collection("users").authWithOTP("nope", "00000000"); } catch (e) { return fail(e); } } },
  { name: "records.impersonate", run: async (s) => { const c = await s.su.collection("users").impersonate(s.userId, 600); const me = await c.collection("users").getOne(s.userId); return norm({ valid: c.authStore.isValid, email: me.email }); } },
  { name: "records.listExternalAuths + unlinkExternalAuth", run: async (s) => { const list = await s.user.collection("users").listExternalAuths(s.userId); try { await s.user.collection("users").unlinkExternalAuth(s.userId, "google"); return { list: list.length, unlink: "ok" }; } catch (e) { return { list: list.length, unlink: fail(e) }; } } },
  { name: "records.authWithOAuth2Code bad code", run: async (s) => { try { return await s.pb.collection("users").authWithOAuth2Code("google", "bad", "verifier", "http://127.0.0.1/redirect"); } catch (e) { return fail(e); } } },
  // realtime through the SDK
  { name: "realtime.subscribe + event + unsubscribe", run: async (s) => {
    const got: string[] = [];
    await s.su.collection("ks_sdk").subscribe("*", (e) => got.push(`${e.action}:${e.record.title}`));
    const rec = await s.su.collection("ks_sdk").create({ title: "rt", n: 9 });
    const until = Date.now() + 8000; while (Date.now() < until && got.length < 1) await Bun.sleep(100);
    await s.su.collection("ks_sdk").unsubscribe("*");
    await s.su.realtime.unsubscribeByPrefix("ks_sdk"); await s.su.realtime.unsubscribe();
    await s.su.collection("ks_sdk").delete(rec.id);
    return got;
  } },
  // batch
  { name: "batch.send create/update/upsert/delete", run: async (s) => {
    await s.su.settings.update({ batch: { enabled: true, maxRequests: 50, timeout: 3, maxBodySize: 0 } });
    const b = s.su.createBatch();
    b.collection("ks_sdk").create({ title: "b1", n: 1 }); b.collection("ks_sdk").create({ id: "sdkbatch0000001", title: "b2", n: 2 });
    b.collection("ks_sdk").upsert({ id: "sdkbatch0000001", title: "b2u", n: 3 }); b.collection("ks_sdk").update("sdkbatch0000001", { "n+": 1 }); b.collection("ks_sdk").delete("sdkbatch0000001");
    const res = await b.send();
    return norm(res.map((r) => ({ status: r.status, title: (r.body as { title?: string })?.title })));
  } },
  { name: "batch.send failing request rolls back", run: async (s) => { const b = s.su.createBatch(); b.collection("ks_sdk").create({ title: "keep", n: 1 }); b.collection("ks_sdk").create({ n: "x" }); try { return await b.send(); } catch (e) { const kept = await s.su.collection("ks_sdk").getList(1, 50, { filter: "title = 'keep'" }); return { ...fail(e), kept: kept.totalItems }; } } },
  // settings
  { name: "settings.getAll keys", run: async (s) => Object.keys(await s.su.settings.getAll()).sort() },
  { name: "settings.update meta.appName", run: async (s) => { const r = await s.su.settings.update({ meta: { appName: "SDK Suite" } }); const back = await s.su.settings.update({ meta: { appName: "Acme" } }); return [r.meta.appName, back.meta.appName]; } },
  { name: "settings.update invalid", run: async (s) => { try { return await s.su.settings.update({ meta: { appURL: "not a url" } }); } catch (e) { return fail(e); } } },
  { name: "settings.testEmail", run: async (s) => { await sinkClear(); await s.su.settings.testEmail("users", s.email, "verification"); const m = await sinkWait((x) => x.to.includes(s.email)); return { subject: m?.subject }; } },
  { name: "settings.testS3 (not configured)", run: async (s) => { try { await s.su.settings.testS3("storage"); return "ok"; } catch (e) { return fail(e); } } },
  { name: "settings.generateAppleClientSecret bad key", run: async (s) => { try { return await s.su.settings.generateAppleClientSecret("cid", "team", "key", "not-a-pem", 1000); } catch (e) { return fail(e); } } },
  // logs (the reference flushes its log writer in batches)
  { name: "logs.getList + getOne + getStats", run: async (s) => { await Bun.sleep(6500); const list = await s.su.logs.getList(1, 2, { filter: "level >= 0", sort: "-@rowid" }); const one = list.items[0] ? await s.su.logs.getOne(list.items[0].id) : null; const stats = await s.su.logs.getStats({ filter: "level >= 0" }); return { listed: list.items.length, page: list.page, one: one ? Object.keys(one).sort() : null, stats: stats.length > 0 && Object.keys(stats[0]!).sort() }; } },
  // crons
  { name: "crons.getFullList + run", run: async (s) => { const jobs = await s.su.crons.getFullList(); await s.su.crons.run("__pbLogsCleanup__"); return { builtins: jobs.map((j) => j.id).filter((id) => id.startsWith("__pb")).sort(), keys: Object.keys(jobs[0] ?? {}).sort() }; } },
  { name: "crons.run missing", run: async (s) => { try { await s.su.crons.run("nope"); return "ran"; } catch (e) { return fail(e); } } },
  // sql console
  { name: "sql.run", run: async (s) => { try { const r = await (s.su as unknown as { sql: { run: (q: string) => Promise<unknown> } }).sql.run("select count(*) as n from ks_sdk"); return norm(r); } catch (e) { const f = fail(e); return f.error === 404 ? "unsupported (404)" : f; } } },
  // backups
  { name: "backups.create + getFullList + download + upload + delete", run: async (s) => {
    const name = `sdk_${stamp}.zip`; await s.su.backups.create(name);
    let list = await s.su.backups.getFullList(); const mine = list.find((b) => b.key === name);
    const token = await s.su.files.getToken(); const dl = await fetch(s.su.backups.getDownloadURL(token, name));
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const fd = new FormData(); fd.append("file", new Blob([bytes], { type: "application/zip" }), `sdk_${stamp}_copy.zip`);
    let upload: unknown = "ok"; try { await s.su.backups.upload(fd); } catch (e) { upload = fail(e); }
    list = await s.su.backups.getFullList();
    for (const k of [name, `sdk_${stamp}_copy.zip`]) { try { await s.su.backups.delete(k); } catch { /* absent */ } }
    return norm({ created: !!mine, keys: mine ? Object.keys(mine).sort() : null, download: [dl.status, dl.headers.get("content-type")], nonEmpty: bytes.length > 100, upload, copyListed: list.some((b) => b.key === `sdk_${stamp}_copy.zip`) });
  } },
  { name: "backups.delete missing", run: async (s) => { try { await s.su.backups.delete("nope.zip"); return "deleted"; } catch (e) { const f = fail(e); return { ...f, message: String(f.message).split("\n")[0] }; } } },
  // teardown-ish
  { name: "collections.truncate + delete", run: async (s) => { await s.su.collections.truncate("ks_sdk"); const n = (await s.su.collection("ks_sdk").getList(1, 1)).totalItems; await s.su.collections.delete("ks_sdk"); try { await s.su.collections.getOne("ks_sdk"); return { n, gone: false }; } catch (e) { return { n, gone: fail(e).error }; } } },
  { name: "logs.truncate (0.40; the 0.39 reference lacks it)", run: async (s) => { try { await s.su.logs.truncate(); return "ok"; } catch (e) { const f = fail(e); return f.error === 404 ? "ok" : f; } } },
];

async function setup(base: string): Promise<S> {
  const pb = new PocketBase(base); pb.autoCancellation(false);
  const su = new PocketBase(base); su.autoCancellation(false); await su.collection("_superusers").authWithPassword("admin@example.com", "changeme123");
  const settings = await su.settings.getAll();
  await su.collections.update("users", { otp: { enabled: false } }); // earlier suites may leave OTP on
  await su.settings.update({ smtp: { enabled: true, host: "127.0.0.1", port: 2525, username: "", password: "", authMethod: "", tls: false, localName: "" } });
  const email = `sdk-${stamp}@example.com`;
  const rec = await su.collection("users").create({ email, password: "changeme123", passwordConfirm: "changeme123", emailVisibility: true });
  const user = new PocketBase(base); user.autoCancellation(false); await user.collection("users").authWithPassword(email, "changeme123");
  return { pb, base, su, email, userId: rec.id, user, saved: { smtp: settings.smtp, batch: settings.batch } };
}
async function teardown(s: S) {
  try { await s.su.collection("users").delete(s.userId); } catch { /* already gone */ }
  try { await s.su.collections.delete("ks_sdk"); } catch { /* gone */ }
  await s.su.settings.update({ smtp: { ...(s.saved.smtp as object), password: "" }, batch: s.saved.batch as object, meta: { appName: "Acme" } });
}
async function runAll(base: string) {
  const s = await setup(base); const out: Record<string, unknown> = {};
  try { for (const st of steps) { try { out[st.name] = await st.run(s); } catch (e) { out[st.name] = { threw: fail(e) }; } } } finally { await teardown(s); }
  return out;
}
const pb = await runAll(PB); const vb = await runAll(VB);
let pass = 0, fail_ = 0;
for (const st of steps) {
  const a = JSON.stringify(pb[st.name]), b = JSON.stringify(vb[st.name]);
  const ok = a === b; ok ? pass++ : fail_++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${st.name}  ${b.slice(0, 120)}`);
  if (!ok) console.log(`   pb ${a.slice(0, 400)}\n   vb ${b.slice(0, 400)}`);
}
console.log(`\n${pass} pass, ${fail_} fail  (${steps.length} SDK service steps)`); process.exit(fail_ ? 1 : 0);
