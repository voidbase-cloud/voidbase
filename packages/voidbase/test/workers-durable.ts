// `voidbase serve --workers --database durable`: the instance on Cloudflare's local runtime (workerd, through Void's
// dev server) with its data in the database Durable Object (src/server/durable-db.ts) instead of D1, from a pb-layout
// project on this machine, nothing reaching Cloudflare.
//   bun test/workers-durable.ts
//
// What it proves, on workerd: the object applies the system schema and the instance bootstraps on it; collections,
// records, list, filter, expand, password auth, realtime through the hub, a backup taken from the queue and restored
// (the queue consumer and the request path both reach the object through the same seam); a batch whose second
// statement fails leaves the first rolled back (the object's transactionSync, which D1's batch only approximates), set
// against the same two statements outside a batch, where the first survives; and the ceilings measured rather than
// assumed: a table of 100 columns and a statement of 100 bound parameters pass, 101 of either fail, on this storage as
// on D1. The first workerd start is the slow part; the whole run stays under a few minutes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../bin/voidbase.ts"); const PKG = resolve(import.meta.dir, "..");
const NAME = "wd-test"; const PROJECT = `${PKG}/.cloud/${NAME}`;
const EMAIL = "admin@example.com", PASSWORD = "workers-durable-pass1";
const started = Date.now();
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };

// the project: what `voidbase init` leaves behind, plus a main.ts whose routes reach the database through c.env.DB,
// the way any composed project does, for the two proofs no public endpoint expresses (a raw batch, the ceilings)
const root = mkdtempSync(join(tmpdir(), "vb-durable-"));
mkdirSync(`${root}/pb_hooks`); mkdirSync(`${root}/pb_migrations`);
// the hook half: a route that does its writes inside $app.runInTransaction, which on the object is a real one
writeFileSync(`${root}/pb_hooks/main.pb.js`, [
  'routerAdd("GET", "/api/hello", (e) => e.json(200, { hello: "durable" }));',
  'routerAdd("POST", "/api/tx-hook", (e) => {',
  '  const mode = e.queryParam("mode");',
  '  const out = { real: $app.transactionsAreReal(), error: "", readback: "", nested: "" };',
  '  $app.truncateCollection("tx_a"); $app.truncateCollection("tx_b");',
  '  try {',
  '    $app.runInTransaction((txApp) => {',
  '      const a = new Record(txApp.findCollectionByNameOrId("tx_a"), { title: "one" });',
  '      txApp.save(a);',
  '      if (mode === "readback") {',
  '        try { txApp.findRecordById("tx_a", a.id); out.readback = "answered"; } catch (err) { out.readback = String(err.message || err); }',
  '      }',
  '      if (mode === "nested") {',
  '        try { txApp.runInTransaction(() => 1); out.nested = "allowed"; } catch (err) { out.nested = String(err.message || err); }',
  '      }',
  '      if (mode === "fail") throw new Error("the second write is refused");',
  '      txApp.save(new Record(txApp.findCollectionByNameOrId("tx_b"), { title: "two" }));',
  '    });',
  '  } catch (err) { out.error = String(err.message || err); }',
  '  out.a = $app.countRecords("tx_a");',
  '  out.b = $app.countRecords("tx_b");',
  '  return e.json(200, out);',
  '});',
  '',
].join("\n"));
writeFileSync(`${root}/package.json`, JSON.stringify({ name: NAME, private: true }) + "\n");
writeFileSync(`${root}/main.ts`, [
  `import type { VoidbaseApp } from ${JSON.stringify(`${PKG}/src/server/api`)};`,
  "const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));",
  "export function register(app: VoidbaseApp) {",
  "  // the transaction proof: two inserts in one batch, the second violating a unique index; the first must not survive.",
  "  // Then the same two statements one by one, where the first does: the contrast the batch is measured against.",
  '  app.router.post("/api/tx-proof", async (c) => {',
  "    const db = c.env.DB;",
  '    await db.exec("CREATE TABLE IF NOT EXISTS tx_proof (id INTEGER PRIMARY KEY, v TEXT UNIQUE); DELETE FROM tx_proof");',
  '    let error = "";',
  '    try { await db.batch([db.prepare("INSERT INTO tx_proof (v) VALUES (?)").bind("first"), db.prepare("INSERT INTO tx_proof (v) VALUES (?)").bind("first")]); } catch (e) { error = msg(e); }',
  '    const rows = (await db.prepare("SELECT v FROM tx_proof").all()).results;',
  '    let single = "";',
  '    try { await db.prepare("INSERT INTO tx_proof (v) VALUES (?)").bind("second").run(); await db.prepare("INSERT INTO tx_proof (v) VALUES (?)").bind("second").run(); } catch (e) { single = msg(e); }',
  '    const after = (await db.prepare("SELECT v FROM tx_proof").all()).results;',
  "    return c.json({ error, rows, single, after, durable: !!c.env.DB_OBJECT });",
  "  });",
  "  // the ceilings, measured at ?n=: a table of n columns, a statement binding n parameters",
  '  app.router.get("/api/limits", async (c) => {',
  '    const n = Number(c.req.query("n") ?? 0); const db = c.env.DB; const out: Record<string, string> = {};',
  '    const cols = Array.from({ length: n }, (_, i) => "c" + i + " TEXT").join(", ");',
  '    try { await db.exec("DROP TABLE IF EXISTS lim_" + n + "; CREATE TABLE lim_" + n + " (" + cols + ")"); out.columns = "ok"; } catch (e) { out.columns = msg(e); }',
  '    const marks = Array.from({ length: n }, (_, i) => "? AS p" + i).join(", ");',
  '    try { await db.prepare("SELECT " + marks).bind(...Array.from({ length: n }, (_, i) => i)).first(); out.params = "ok"; } catch (e) { out.params = msg(e); }',
  "    return c.json(out);",
  "  });",
  "}",
  "",
].join("\n"));
rmSync(PROJECT, { recursive: true, force: true }); // a fresh object every run
const logPath = `${root}/serve.log`;
const freePort = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") }); const p = s.port; s.stop(true); return p; };
const port = freePort(); const base = `http://127.0.0.1:${port}`;
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  VOIDBASE_SUPERUSER_EMAIL: EMAIL, VOIDBASE_SUPERUSER_PASSWORD: PASSWORD,
  // nothing may reach Cloudflare: a token that must not be used, and an API base nothing listens on
  VOIDBASE_DEPLOY_CF_API_KEY: "must-never-be-used", CLOUDFLARE_API_BASE: "http://127.0.0.1:9",
  VOIDBASE_DEPLOY_NAME: "", VOIDBASE_DEPLOY_DOMAIN: "", VOIDBASE_DOMAINS: "", VOIDBASE_HOOKS_DIR: "", VOIDBASE_MIGRATIONS_DIR: "", VOIDBASE_PLUGINS_DIR: "", VOIDBASE_SECRETS_DIR: "", VOIDBASE_DATA_DIR: "", VOIDBASE_PERSIST_TO: "", VOIDBASE_DATABASE: "",
};
// setsid: the CLI spawns vp, which spawns vite and workerd; the process group takes them all down at the end
const server = Bun.spawn(["setsid", "bun", BIN, "serve", "--workers", "--database", "durable", "--http", `127.0.0.1:${port}`], { cwd: root, env, stdin: "ignore", stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const J = { "content-type": "application/json" };
try {
  let health = 0; let exited: number | null = null; void server.exited.then((c) => { exited = c; });
  for (let i = 0; i < 150 && health !== 200 && exited === null; i++) { await Bun.sleep(1000); health = await fetch(`${base}/api/health`).then((r) => r.status).catch(() => 0); }
  check(`/api/health answers 200 on the local runtime with the object as the database (${Math.round((Date.now() - started) / 1000)} s after start)`, health === 200, `status ${health}, exit ${exited}, log tail: ${log().split("\n").slice(-15).join(" | ")}`);
  const cfg = existsSync(`${PROJECT}/wrangler.jsonc`) ? readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8") : "";
  const voidJson = existsSync(`${PROJECT}/void.json`) ? (JSON.parse(readFileSync(`${PROJECT}/void.json`, "utf8")) as { inference: { bindings: { db: boolean } } }) : null;
  check("the project binds DB_OBJECT to VoidbaseDatabase under its own migration tag, has no d1_databases and no D1 schema, and tells Void not to infer one", cfg !== "" && !cfg.includes("d1_databases") && /"name": "DB_OBJECT",\s*"class_name": "VoidbaseDatabase"/.test(cfg) && cfg.includes('"tag": "voidbase-database-v1"') && !existsSync(`${PROJECT}/db`) && voidJson?.inference.bindings.db === false, PROJECT);
  const su = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: J, body: JSON.stringify({ identity: EMAIL, password: PASSWORD }) });
  const token = su.status === 200 ? String((await json(su)).token) : "";
  check("the object applied the system schema and the superuser from the environment signs in", su.status === 200 && token.length > 20, `${su.status} ${log().split("\n").slice(-6).join(" | ")}`);
  const H = { ...J, authorization: token };

  // the transaction proof
  const tx = await fetch(`${base}/api/tx-proof`, { method: "POST", headers: H });
  const txBody = tx.status === 200 ? (await json(tx)) as { error: string; rows: unknown[]; single: string; after: { v: string }[]; durable: boolean } : null;
  check("the request reaches the database through DB_OBJECT (the seam rebound DB)", !!txBody?.durable, `${tx.status} ${JSON.stringify(txBody).slice(0, 200)}`);
  check("a batch whose second statement fails leaves the first rolled back, with SQLite's own message (unprefixed: the object's, not D1's)", !!txBody && /^UNIQUE constraint failed: tx_proof\.v/.test(txBody.error) && txBody.rows.length === 0, JSON.stringify(txBody).slice(0, 300));
  check("the same two statements outside a batch: the first survives (the contrast), the second fails the same way", !!txBody && /UNIQUE constraint failed: tx_proof\.v/.test(txBody.single) && txBody.after.length === 1 && txBody.after[0]?.v === "second", JSON.stringify(txBody).slice(0, 300));

  // the hook's own transaction: $app.runInTransaction, whose writes are held and sent as one batch at the end
  const txColl = async (name: string) => (await fetch(`${base}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name, type: "base", fields: [{ name: "title", type: "text" }] }) })).status;
  const txColls = [await txColl("tx_a"), await txColl("tx_b")];
  const hookTx = async (mode: string) => (await json(await fetch(`${base}/api/tx-hook?mode=${mode}`, { method: "POST", headers: H }))) as { real: boolean; error: string; readback: string; nested: string; a: number; b: number };
  const txFail = await hookTx("fail");
  check("a hook's transaction whose second write throws leaves neither record, and the throw reaches the hook", txColls.every((s) => s === 200) && txFail.real === true && /the second write is refused/.test(txFail.error) && txFail.a === 0 && txFail.b === 0, JSON.stringify(txFail));
  const txOk = await hookTx("commit");
  check("the same transaction without the throw leaves both records, sent as one batch when the callback returned", txOk.error === "" && txOk.a === 1 && txOk.b === 1, JSON.stringify(txOk));
  const txRead = await hookTx("readback");
  check(`reading back what the transaction just wrote throws instead of answering without it (measured: "${txRead.readback.slice(0, 80)}")`, /has written to .tx_a. and has not committed/.test(txRead.readback) && txRead.error === "" && txRead.a === 1 && txRead.b === 1, JSON.stringify(txRead));
  const txNest = await hookTx("nested");
  check("a transaction inside a transaction is refused with a message that says so, not silently flattened", /a transaction is already open\. Transactions do not nest/.test(txNest.nested) && txNest.error === "" && txNest.a === 1 && txNest.b === 1, JSON.stringify(txNest));
  // the ceilings, measured
  const at = async (n: number) => (await json(await fetch(`${base}/api/limits?n=${n}`, { headers: H }))) as { columns: string; params: string };
  const at100 = await at(100), at101 = await at(101);
  check("100 columns per table and 100 bound parameters per statement pass on the object", at100.columns === "ok" && at100.params === "ok", JSON.stringify(at100));
  check(`101 of either fails on the object as on D1 (measured: columns "${at101.columns}", parameters "${at101.params}")`, /too many columns/.test(at101.columns) && /too many SQL variables/.test(at101.params), JSON.stringify(at101));

  // a wide collection under the ceiling, a record binding every field, read back
  const wideFields = Array.from({ length: 90 }, (_, i) => ({ name: `f${i}`, type: "text" }));
  const wide = await fetch(`${base}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: "dd_wide", type: "base", fields: wideFields }) });
  const wideRecord = Object.fromEntries(wideFields.map((f, i) => [f.name, `v${i}`]));
  const wideMade = wide.status === 200 ? await fetch(`${base}/api/collections/dd_wide/records`, { method: "POST", headers: H, body: JSON.stringify(wideRecord) }) : null;
  const wideRow = wideMade?.status === 200 ? await json(wideMade) : {};
  const wideBack = wideRow.id ? await json(await fetch(`${base}/api/collections/dd_wide/records/${wideRow.id}`, { headers: H })) : {};
  check("a collection of 90 fields (93 columns) is created, a record binding all of them written and read back", wide.status === 200 && wideMade?.status === 200 && wideBack.f89 === "v89" && wideBack.f0 === "v0", `${wide.status} ${wideMade?.status} ${JSON.stringify(wideBack).slice(0, 120)}`);

  // relations, list, filter, expand
  const authors = await fetch(`${base}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: "dd_authors", type: "base", fields: [{ name: "name", type: "text", required: true }] }) });
  const authorsId = authors.status === 200 ? String((await json(authors)).id) : "";
  const posts = await fetch(`${base}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: "dd_posts", type: "base", listRule: "", viewRule: "", fields: [{ name: "title", type: "text", required: true }, { name: "author", type: "relation", collectionId: authorsId, maxSelect: 1 }] }) });
  const author = await json(await fetch(`${base}/api/collections/dd_authors/records`, { method: "POST", headers: H, body: JSON.stringify({ name: "Ada" }) }));
  const post = await json(await fetch(`${base}/api/collections/dd_posts/records`, { method: "POST", headers: H, body: JSON.stringify({ title: "hello", author: author.id }) }));
  await fetch(`${base}/api/collections/dd_posts/records`, { method: "POST", headers: H, body: JSON.stringify({ title: "other", author: author.id }) });
  const listed = await json(await fetch(`${base}/api/collections/dd_posts/records?filter=${encodeURIComponent("title='hello'")}&expand=author`, { headers: H })) as { totalItems?: number; items?: { id: string; expand?: { author?: { name: string } } }[] };
  check("list with a filter and an expand: one of two posts, its author expanded", authors.status === 200 && posts.status === 200 && listed.totalItems === 1 && listed.items?.[0]?.id === post.id && listed.items?.[0]?.expand?.author?.name === "Ada", `${authors.status} ${posts.status} ${JSON.stringify(listed).slice(0, 200)}`);

  // password auth: an auth collection created through the API (a fresh instance has none), a user in it, a sign-in
  const usersColl = await fetch(`${base}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: "dd_users", type: "auth", fields: [{ name: "name", type: "text" }] }) });
  const user = await fetch(`${base}/api/collections/dd_users/records`, { method: "POST", headers: H, body: JSON.stringify({ email: "user@example.com", password: "changeme123", passwordConfirm: "changeme123", name: "U" }) });
  const userAuth = await fetch(`${base}/api/collections/dd_users/auth-with-password`, { method: "POST", headers: J, body: JSON.stringify({ identity: "user@example.com", password: "changeme123" }) });
  const userToken = userAuth.status === 200 ? String((await json(userAuth)).token) : "";
  const asUser = await fetch(`${base}/api/collections/dd_posts/records`, { headers: { authorization: userToken } });
  check("an auth collection is created, a user in it signs in with a password, and the list rule lets them read the posts", usersColl.status === 200 && user.status === 200 && userAuth.status === 200 && userToken.length > 20 && asUser.status === 200 && (await json(asUser)).totalItems === 2, `${usersColl.status} ${user.status} ${userAuth.status} ${asUser.status}`);

  // realtime through the hub (its own Durable Object), the write landing in the database object first
  {
    const ac = new AbortController();
    const sse = await fetch(`${base}/api/realtime`, { headers: { accept: "text/event-stream" }, signal: ac.signal });
    const reader = sse.body!.getReader(); const dec = new TextDecoder(); let buf = ""; const events: { event: string; data: string }[] = [];
    const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (.*)/.exec(chunk)?.[1] ?? ""; const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n"); if (ev) events.push({ event: ev, data }); } } })().catch(() => {});
    const until = async (n: number, ms: number) => { const t = Date.now() + ms; while (events.length < n && Date.now() < t) await Bun.sleep(20); };
    await until(1, 5000);
    const clientId = events[0] ? (JSON.parse(events[0].data) as { clientId: string }).clientId : "";
    const subscribed = await fetch(`${base}/api/realtime`, { method: "POST", headers: H, body: JSON.stringify({ clientId, subscriptions: ["dd_posts/*"] }) });
    const t0 = Date.now();
    const made = await json(await fetch(`${base}/api/collections/dd_posts/records`, { method: "POST", headers: H, body: JSON.stringify({ title: "live", author: author.id }) }));
    await until(2, 3000);
    const ev = events[1]; const evRecord = ev ? (JSON.parse(ev.data) as { action: string; record: { id: string } }) : null;
    check("realtime: a subscription sees the create through the hub within 3 s", subscribed.status === 204 && !!made.id && ev?.event === "dd_posts/*" && evRecord?.action === "create" && evRecord.record.id === made.id, `${subscribed.status} ${made.id} ${ev?.event} ${Date.now() - t0} ms`);
    ac.abort(); await pump;
  }

  // a backup taken (from the jobs queue, which reaches the object through the same seam) and restored
  const before = await json(await fetch(`${base}/api/collections/dd_posts/records`, { method: "POST", headers: H, body: JSON.stringify({ title: "before-backup", author: author.id }) }));
  const backup = await fetch(`${base}/api/backups`, { method: "POST", headers: H, body: JSON.stringify({ name: "dd_backup.zip" }) });
  let listedBackup = false;
  for (let i = 0; i < 60 && !listedBackup; i++) { await Bun.sleep(500); const l = (await json(await fetch(`${base}/api/backups`, { headers: H })).valueOf()) as unknown; listedBackup = Array.isArray(l) && (l as { key: string }[]).some((b) => b.key === "dd_backup.zip"); }
  const afterId = String((await json(await fetch(`${base}/api/collections/dd_posts/records`, { method: "POST", headers: H, body: JSON.stringify({ title: "after-backup", author: author.id }) }))).id ?? "");
  const restore = listedBackup ? await fetch(`${base}/api/backups/dd_backup.zip/restore`, { method: "POST", headers: H }) : null;
  let gone = false;
  for (let i = 0; i < 60 && !gone && restore?.status === 204; i++) { await Bun.sleep(500); gone = (await fetch(`${base}/api/collections/dd_posts/records/${afterId}`, { headers: H })).status === 404; }
  const kept = await fetch(`${base}/api/collections/dd_posts/records/${before.id}`, { headers: H });
  const suAgain = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: J, body: JSON.stringify({ identity: EMAIL, password: PASSWORD }) });
  check("a backup is taken and restored: the record written after it is gone, the one before it is back, the superuser still signs in", backup.status === 204 && listedBackup && restore?.status === 204 && gone && kept.status === 200 && suAgain.status === 200, `backup=${backup.status} listed=${listedBackup} restore=${restore?.status} gone=${gone} kept=${kept.status} su=${suAgain.status} log: ${log().split("\n").filter((l) => /backup|error/i.test(l)).slice(-4).join(" | ")}`);

  // the public batch endpoint (off by default, enabled through the settings): its emulated rollback holds on the object too
  const batchOn = await fetch(`${base}/api/settings`, { method: "PATCH", headers: H, body: JSON.stringify({ batch: { enabled: true, maxRequests: 50, timeout: 3, maxBodySize: 0 } }) });
  const batch = await fetch(`${base}/api/batch`, { method: "POST", headers: H, body: JSON.stringify({ requests: [{ method: "POST", url: "/api/collections/dd_posts/records", body: { title: "batch-one", author: author.id } }, { method: "POST", url: "/api/collections/dd_posts/records", body: { author: author.id } }] }) });
  const batchOne = await json(await fetch(`${base}/api/collections/dd_posts/records?filter=${encodeURIComponent("title='batch-one'")}`, { headers: H }));
  check("POST /api/batch with a failing second request answers 400 and leaves nothing of the first", batchOn.status === 200 && batch.status === 400 && batchOne.totalItems === 0, `settings=${batchOn.status} ${batch.status} ${JSON.stringify(batchOne).slice(0, 120)}`);

  const hello = await fetch(`${base}/api/hello`);
  check("the project's pb_hooks route is bundled into the Worker", hello.status === 200 && (await json(hello)).hello === "durable", String(hello.status));
  const out = log();
  check("the banner names the object as the database and the state directory", /database: Durable Object \(SQLite\)/.test(out) && out.includes(`${PROJECT}/.void`) && /Server started at http:\/\/127\.0\.0\.1:\d+/.test(out), out.split("\n").slice(-12).join(" | "));
  const doDir = `${PROJECT}/.void/v3/do`, d1Dir = `${PROJECT}/.void/v3/d1`;
  const doEntries = existsSync(doDir) ? readdirSync(doDir) : [];
  const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])) : []);
  // Miniflare keeps a metadata.sqlite for its D1 plugin whether or not a database exists; a database is a hash-named file beside it
  const d1Files = files(d1Dir).filter((f) => /\.sqlite/.test(f) && !/\/metadata\.sqlite/.test(f));
  check("the data lives in the object's storage, and no D1 database file was made (Miniflare's own metadata aside)", d1Files.length === 0 && doEntries.some((d) => d.includes("VoidbaseDatabase")) && files(join(doDir, doEntries.find((d) => d.includes("VoidbaseDatabase")) ?? "")).some((f) => /\.sqlite/.test(f)), `${doDir}: ${doEntries.join(", ")}; d1: ${d1Files.join(", ") || files(d1Dir).join(", ") || "absent"}`);
} catch (err) {
  console.error("workers-durable: aborted:", err instanceof Error ? err.stack ?? err.message : err);
  console.error("--- serve log tail ---\n" + log().split("\n").slice(-30).join("\n"));
  fail++;
} finally {
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  const t = setTimeout(() => { try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ } }, 15_000);
  await server.exited; clearTimeout(t);
  rmSync(root, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
}
console.log(`\n${pass} pass, ${fail} fail  (${Math.round((Date.now() - started) / 1000)} s)`);
process.exit(fail ? 1 : 0);
