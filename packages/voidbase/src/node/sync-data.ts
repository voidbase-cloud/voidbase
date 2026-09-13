// Moving an instance's data as part of sync: up, from this machine to the instance just deployed, or down, from a
// running instance to this machine. The data choice is the caller's; the move is src/node/migrate.ts, a backup on the
// source restored on the target through the backups API, which needs both sides running.
//
// This machine's side is not running while sync runs, so it is started here for the length of the move: the project's
// pb_data served in this process on a free local port, and stopped again afterwards. Signing in on both sides with one
// superuser is what makes that work with nothing to type: the deploy generates the Worker's superuser and keeps it in
// pb_data/.superuser-credentials, and the local server upserts the same one from the environment when it bootstraps
// (src/server/bootstrap.ts). Taking data up must not change this machine's own superuser as a side effect, so the row
// that upsert touched is put back when the server stops.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate } from "./migrate";

export interface Superuser { email: string; password: string }

/** the superuser a deploy generated for this data directory, or null when it has not deployed */
export function readCredentials(dataDir: string): Superuser | null {
  const file = join(dataDir, ".superuser-credentials");
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Partial<Superuser>;
    return typeof c.email === "string" && typeof c.password === "string" ? { email: c.email, password: c.password } : null;
  } catch { return null; }
}

const freePort = (): number => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port!; s.stop(true); return p; };

type Row = { id: string; password: string; tokenKey: string; updated: string };
function superuserRow(dataDir: string, email: string): Row | null | undefined {
  const file = join(dataDir, "data.db");
  if (!existsSync(file)) return undefined;   // no database yet: the server creates it, and there is nothing to keep
  const db = new Database(file);
  try { return (db.query("SELECT id, password, tokenKey, updated FROM `_superusers` WHERE email = ?").get(email) as Row | null) ?? null; }
  catch { return undefined; }                // no _superusers table yet
  finally { db.close(); }
}
function putBack(dataDir: string, email: string, before: Row | null | undefined): void {
  if (before === undefined) return;
  const db = new Database(join(dataDir, "data.db"));
  try {
    if (before) db.query("UPDATE `_superusers` SET password = ?, tokenKey = ?, updated = ? WHERE id = ?").run(before.password, before.tokenKey, before.updated, before.id);
    else db.query("DELETE FROM `_superusers` WHERE email = ?").run(email);
  } finally { db.close(); }
}

/**
 * `fn` with this machine's instance running on `dataDir`, signed in as `superuser`. With `keepOwnSuperuser`, the
 * local superuser row is restored afterwards: taking data up reads this instance and must not change it.
 */
export async function withLocalInstance<T>(dataDir: string, superuser: Superuser, fn: (url: string) => Promise<T>, o: { keepOwnSuperuser?: boolean } = {}): Promise<T> {
  const dir = resolve(dataDir);
  const before = o.keepOwnSuperuser ? superuserRow(dir, superuser.email) : undefined;
  const saved = { email: process.env.VOIDBASE_SUPERUSER_EMAIL, password: process.env.VOIDBASE_SUPERUSER_PASSWORD };
  process.env.VOIDBASE_SUPERUSER_EMAIL = superuser.email; process.env.VOIDBASE_SUPERUSER_PASSWORD = superuser.password;
  const port = freePort();
  const { voidbase } = await import("./serve");
  const app = await voidbase({ dir, http: `127.0.0.1:${port}`, quiet: true });
  const server = await app.start();
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally {
    server.stop();
    const restore = (k: "VOIDBASE_SUPERUSER_EMAIL" | "VOIDBASE_SUPERUSER_PASSWORD", v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore("VOIDBASE_SUPERUSER_EMAIL", saved.email); restore("VOIDBASE_SUPERUSER_PASSWORD", saved.password);
    if (o.keepOwnSuperuser) putBack(dir, superuser.email, before);
  }
}

export interface MoveOptions { log?: (line: string) => void; dryRun?: boolean; keep?: boolean; timeoutMs?: number }

/** `voidbase sync up --data`: this machine's records into the instance at `url`, signed in with the deploy's superuser */
export async function syncDataUp(o: MoveOptions & { dataDir: string; url: string }): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const superuser = readCredentials(o.dataDir);
  if (!superuser) throw new Error(`no superuser to take the data up with: ${join(o.dataDir, ".superuser-credentials")} is written by the deploy, so deploy first`);
  log(`\ndata: taking this machine's records up to ${o.url}`);
  await withLocalInstance(o.dataDir, superuser, (local) => migrate({ from: { url: local, ...superuser }, to: { url: o.url, ...superuser }, dryRun: o.dryRun, keep: o.keep, timeoutMs: o.timeoutMs, log: (l) => log(`  ${l}`) }), { keepOwnSuperuser: true });
}

/** `voidbase sync down <url>`: the instance at `url`, brought to `dataDir` on this machine */
export async function syncDown(o: MoveOptions & { url: string; dataDir: string } & Superuser): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const superuser = { email: o.email, password: o.password };
  log(`bringing ${o.url} down to ${resolve(o.dataDir)}`);
  await withLocalInstance(o.dataDir, superuser, (local) => migrate({ from: { url: o.url, ...superuser }, to: { url: local, ...superuser }, dryRun: o.dryRun, keep: o.keep, timeoutMs: o.timeoutMs, log: (l) => log(`  ${l}`) }));
}
