// `voidbase migrate <from> <to>` end to end: two instances on this machine, a collection and a record on the first,
// the migration through the CLI, the second has both afterwards.
//   bun test/migrate.ts
//
// Both instances run from bin/voidbase.ts serve on temporary data directories and free ports, with different
// superusers so the test also shows the target's superusers becoming the source's, which is what a restore does.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../bin/voidbase.ts");
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const freePort = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };

interface Instance { name: string; url: string; dir: string; email: string; password: string; proc: ReturnType<typeof Bun.spawn>; log: string[] }
function start(name: string, email: string, password: string): Instance {
  const dir = mkdtempSync(join(tmpdir(), `vb-migrate-${name}-`));
  for (const d of ["pb_hooks", "pb_migrations"]) mkdirSync(join(dir, d), { recursive: true });
  const port = freePort();
  const proc = Bun.spawn(["bun", BIN, "serve", "--http", `127.0.0.1:${port}`, "--dir", join(dir, "pb_data"), "--hooksDir", join(dir, "pb_hooks"), "--migrationsDir", join(dir, "pb_migrations")], {
    cwd: dir, env: { ...process.env, VOIDBASE_SUPERUSER_EMAIL: email, VOIDBASE_SUPERUSER_PASSWORD: password, VOIDBASE_LOG_MIN_LEVEL: "8", CI: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const log: string[] = [];
  (async () => { for await (const c of proc.stdout) log.push(new TextDecoder().decode(c)); })();
  (async () => { for await (const c of proc.stderr) log.push(new TextDecoder().decode(c)); })();
  return { name, url: `http://127.0.0.1:${port}`, dir, email, password, proc, log };
}
async function ready(i: Instance): Promise<boolean> {
  for (let n = 0; n < 80; n++) { if ((await fetch(`${i.url}/api/health`).then((r) => r.status).catch(() => 0)) === 200) return true; await Bun.sleep(250); }
  return false;
}
async function api(i: Instance, method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(i.url + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: Record<string, unknown> = {}; try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: r.status, json };
}
const login = async (i: Instance, email = i.email, password = i.password) => { const r = await api(i, "POST", "/api/collections/_superusers/auth-with-password", { identity: email, password }); return { status: r.status, token: String(r.json.token ?? "") }; };
const cli = async (args: string[]) => { const p = Bun.spawn(["bun", BIN, ...args], { env: { ...process.env, CI: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { code, out: out + err }; };

const a = start("a", "alpha@example.com", "alphapass123");
const b = start("b", "beta@example.com", "betapass1234");
try {
  const [ra, rb] = await Promise.all([ready(a), ready(b)]);
  check("two instances start on their own ports and directories", ra && rb, `${a.log.join("").slice(-300)} ${b.log.join("").slice(-300)}`);
  if (!ra || !rb) throw new Error("instances did not start");

  // the data to move: a collection and a record on the source
  const ta = (await login(a)).token;
  const made = await api(a, "POST", "/api/collections", { name: "notes", type: "base", fields: [{ name: "title", type: "text", required: true }], listRule: "", viewRule: "" }, ta);
  const rec = await api(a, "POST", "/api/collections/notes/records", { title: "moved by voidbase migrate" }, ta);
  check("a collection and a record exist on the source", made.status === 200 && rec.status === 200, `${made.status} ${JSON.stringify(made.json).slice(0, 200)} ${rec.status}`);
  const recId = String(rec.json.id ?? "");
  const tb = (await login(b)).token;
  check("the target does not have the collection yet", (await api(b, "GET", "/api/collections/notes", undefined, tb)).status === 404);

  const creds = ["--from-email", a.email, "--from-password", a.password, "--to-email", b.email, "--to-password", b.password];

  const same = await cli(["migrate", a.url, a.url, ...creds]);
  check("the same url on both sides is refused", same.code === 1 && /same instance/.test(same.out), same.out.slice(0, 300));

  const nobody = await cli(["migrate", a.url, b.url, "--from-email", a.email, "--from-password", a.password]);
  check("missing target credentials are refused before anything is written", nobody.code === 1 && /to-email/.test(nobody.out), nobody.out.slice(0, 300));

  const dry = await cli(["migrate", a.url, b.url, "--dry-run", ...creds]);
  check("a dry run signs in on both sides and says what would happen", dry.code === 0 && /signed in on the source/.test(dry.out) && /signed in on the target/.test(dry.out) && /would back up/.test(dry.out) && /notes/.test(dry.out), dry.out.slice(0, 500));
  check("and changes nothing on the target", (await api(b, "GET", "/api/collections/notes", undefined, tb)).status === 404 && ((await api(b, "GET", "/api/backups", undefined, tb)).json as unknown as unknown[]).length === 0);
  check("nor leaves a backup on the source", ((await api(a, "GET", "/api/backups", undefined, ta)).json as unknown as unknown[]).length === 0);

  const run = await cli(["migrate", a.url, b.url, ...creds]);
  check("the migration runs through the CLI", run.code === 0 && /backed up the source as migrate-\d+\.zip/.test(run.out) && /restore started/.test(run.out) && /migrated /.test(run.out), run.out.slice(0, 800));

  // the target now holds the source's data, and its superusers are the source's
  const asAlpha = await login(b, a.email, a.password);
  check("the source's superuser signs in on the target after the restore", asAlpha.status === 200, `${asAlpha.status}`);
  const coll = await api(b, "GET", "/api/collections/notes", undefined, asAlpha.token);
  check("the target has the collection", coll.status === 200 && coll.json.name === "notes", `${coll.status} ${JSON.stringify(coll.json).slice(0, 200)}`);
  const got = await api(b, "GET", `/api/collections/notes/records/${recId}`, undefined, asAlpha.token);
  check("and the record, with the same id and content", got.status === 200 && got.json.title === "moved by voidbase migrate", `${got.status} ${JSON.stringify(got.json).slice(0, 200)}`);
  check("the migration archive is gone from both sides", ((await api(a, "GET", "/api/backups", undefined, ta)).json as unknown as unknown[]).length === 0 && ((await api(b, "GET", "/api/backups", undefined, asAlpha.token)).json as unknown as unknown[]).length === 0);
  check("the source is untouched", (await api(a, "GET", `/api/collections/notes/records/${recId}`, undefined, ta)).status === 200);

  // the other direction, with tokens instead of passwords, keeping the archive
  const back = await cli(["migrate", b.url, a.url, "--keep", "--from-token", asAlpha.token, "--to-token", ta]);
  check("the reverse migration works with tokens and --keep", back.code === 0 && /kept migrate-\d+\.zip on both sides/.test(back.out), back.out.slice(0, 800));
  check("and leaves the archive on both sides", ((await api(a, "GET", "/api/backups", undefined, ta)).json as unknown as unknown[]).length === 1 && ((await api(b, "GET", "/api/backups", undefined, asAlpha.token)).json as unknown as unknown[]).length === 1);
} catch (err) {
  check("test ran to the end", false, err instanceof Error ? err.message : String(err));
} finally {
  a.proc.kill(); b.proc.kill();
  await Promise.all([a.proc.exited, b.proc.exited]).catch(() => undefined);
  rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
