// `voidbase migrate <from> <to>`: an instance's data moved between two running instances, in either direction,
// whichever way each one runs (the executable, the npm package, Cloudflare).
//
// A migration is a backup taken on the source and restored on the target, and both halves go through the backups
// API over HTTP (src/server/backups.ts), so nothing here depends on where either side runs: sign in on both sides,
// POST /api/backups on the source, download the archive with a file token, POST /api/backups/upload on the target,
// POST /api/backups/<key>/restore, then wait until the target is out of its restore lock and its collections are
// the source's. A restore replaces everything the target had, its superusers included, which is what a move means
// and what the dry run says out loud.
export interface Side { url: string; email?: string; password?: string; token?: string }
export interface MigrateOptions {
  from: Side;
  to: Side;
  /** leave the migration archive on both sides (default: deleted once the target is verified) */
  keep?: boolean;
  /** sign in on both sides, say what would happen, change nothing */
  dryRun?: boolean;
  /** how long to wait for the target's restore, in milliseconds (default 120s) */
  timeoutMs?: number;
  log?: (line: string) => void;
}
export interface MigrateResult { name: string; collections: string[]; kept: boolean; dryRun: boolean }

interface Collection { id: string; name: string; type: string; system?: boolean }
interface Health { code?: number; data?: { canBackup?: boolean } }

/** the url as the instance is addressed: no trailing slash, lowercase host, http or https only */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error(`"${raw}" is not a URL (expected http://host:port or https://host)`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`"${raw}": only http and https instances can be migrated`);
  u.hash = ""; u.search = "";
  return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, "");
}
/** the same instance addressed twice: 127.0.0.1 and localhost on the same port count as one */
export function sameInstance(a: string, b: string): boolean {
  const canon = (s: string) => { const u = new URL(s); const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname; const port = u.port || (u.protocol === "https:" ? "443" : "80"); return `${u.protocol}//${host}:${port}${u.pathname}`; };
  return canon(normalizeUrl(a)) === canon(normalizeUrl(b));
}

async function call(base: string, method: string, path: string, opts: { token?: string; json?: unknown; body?: BodyInit } = {}): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = opts.token;
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = {}; }
  return { status: r.status, json, text };
}
const short = (r: { status: number; json: Record<string, unknown>; text: string }) => `${r.status} ${typeof r.json.message === "string" ? r.json.message : r.text.slice(0, 160)}`.trim();

/** a superuser token for one side: the one given, or a sign-in with the email and password; verified against /api/health */
export async function signIn(side: Side, label: string): Promise<string> {
  const base = normalizeUrl(side.url);
  let token = side.token ?? "";
  if (!token) {
    if (!side.email || !side.password) throw new Error(`${label}: superuser credentials needed (--${label}-email and --${label}-password, or --${label}-token)`);
    const r = await call(base, "POST", "/api/collections/_superusers/auth-with-password", { json: { identity: side.email, password: side.password } });
    if (r.status !== 200 || typeof r.json.token !== "string") throw new Error(`${label}: sign in as ${side.email} at ${base} failed: ${short(r)}`);
    token = r.json.token;
  }
  // /api/health answers everyone; canBackup is in the data only for a superuser, which is the cheapest way to know
  // the token is one (a given token is not signed in, it is only checked)
  const h = await call(base, "GET", "/api/health", { token });
  if (h.status !== 200) throw new Error(`${label}: ${base}/api/health answered ${short(h)}: is this a running voidbase instance?`);
  if (typeof (h.json as Health).data?.canBackup !== "boolean") throw new Error(`${label}: the token for ${base} is not a superuser's`);
  return token;
}

/** voidbase.cloud's own backend answers /api/vbcloud/me (with anything but 404); a plain instance has no such route */
export async function isControlPlane(url: string, token: string): Promise<boolean> {
  try { const r = await call(normalizeUrl(url), "GET", "/api/vbcloud/me", { token }); return r.status !== 404; } catch { return false; }
}

const canBackup = async (base: string, token: string): Promise<boolean | null> => {
  try { const h = await call(base, "GET", "/api/health", { token }); const v = (h.json as Health).data?.canBackup; return typeof v === "boolean" ? v : null; } catch { return null; }
};
const listCollections = async (base: string, token: string): Promise<Collection[] | null> => {
  const r = await call(base, "GET", "/api/collections?perPage=500&skipTotal=1", { token });
  if (r.status !== 200) return null;
  return ((r.json.items as Collection[]) ?? []).sort((a, b) => a.name.localeCompare(b.name));
};
const listBackups = async (base: string, token: string): Promise<string[]> => {
  const r = await call(base, "GET", "/api/backups", { token });
  if (r.status !== 200) throw new Error(`GET ${base}/api/backups: ${short(r)}`);
  return ((r.json as unknown as { key: string }[]) ?? []).map((b) => b.key);
};
const names = (cs: Collection[]) => cs.map((c) => c.name);

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? (() => undefined);
  const from = normalizeUrl(opts.from.url), to = normalizeUrl(opts.to.url);
  if (sameInstance(from, to)) throw new Error(`the source and the target are the same instance (${from}): nothing to migrate`);
  const timeout = opts.timeoutMs ?? 120_000;

  // 1. both sides, before anything is written anywhere
  const fromToken = await signIn(opts.from, "from");
  log(`signed in on the source ${from}`);
  const toToken = await signIn(opts.to, "to");
  log(`signed in on the target ${to}`);
  if (await isControlPlane(to, toToken)) throw new Error(`${to} is a voidbase.cloud control plane, not an instance: restoring over it would replace the cloud's own data. Refusing.`);

  const sourceCollections = await listCollections(from, fromToken);
  if (!sourceCollections) throw new Error(`could not list the source's collections at ${from}`);
  const user = sourceCollections.filter((c) => !c.system);
  const targetCollections = (await listCollections(to, toToken)) ?? [];
  const targetUser = targetCollections.filter((c) => !c.system);
  const name = `migrate-${new Date().toISOString().replace(/[-:.tz]/gi, "").slice(0, 14)}.zip`;

  if (opts.dryRun) {
    log(`dry run: nothing changes.`);
    log(`  would back up ${from} as ${name} (${user.length} collection(s): ${names(user).join(", ") || "none"})`);
    log(`  would upload it to ${to} and restore it there, replacing its ${targetUser.length} collection(s)${targetUser.length ? ` (${names(targetUser).join(", ")})` : ""}, its records, its files, its settings and its superusers with the source's`);
    log(`  would wait until ${to} is back and lists the source's collections, then ${opts.keep ? "keep" : "delete"} ${name} on both sides`);
    return { name, collections: names(sourceCollections), kept: !!opts.keep, dryRun: true };
  }

  // 2. the backup on the source. The handler creates it before it answers on every runtime, but the list is what
  // says it exists, so that is what is waited for.
  const create = await call(from, "POST", "/api/backups", { token: fromToken, json: { name } });
  if (create.status !== 204) throw new Error(`POST ${from}/api/backups: ${short(create)}`);
  let listed = false;
  for (const started = Date.now(); !listed && Date.now() - started < timeout; ) {
    listed = (await listBackups(from, fromToken)).includes(name);
    if (!listed) await Bun.sleep(500);
  }
  if (!listed) throw new Error(`the source did not list ${name} within ${timeout / 1000}s`);
  log(`backed up the source as ${name}`);

  // 3. download it: the backups route reads a file token, the one POST /api/files/token hands a signed-in superuser
  const ft = await call(from, "POST", "/api/files/token", { token: fromToken });
  if (ft.status !== 200 || typeof ft.json.token !== "string") throw new Error(`POST ${from}/api/files/token: ${short(ft)}`);
  const dl = await fetch(`${from}/api/backups/${encodeURIComponent(name)}?token=${encodeURIComponent(ft.json.token)}`);
  if (!dl.ok) throw new Error(`GET ${from}/api/backups/${name}: ${dl.status} ${(await dl.text()).slice(0, 160)}`);
  const bytes = new Uint8Array(await dl.arrayBuffer());
  log(`downloaded ${name} (${bytes.length} bytes)`);

  // 4. upload it to the target under the same name
  const fd = new FormData();
  fd.set("file", new File([bytes], name, { type: "application/zip" }), name);
  const up = await call(to, "POST", "/api/backups/upload", { token: toToken, body: fd });
  if (up.status !== 204) throw new Error(`POST ${to}/api/backups/upload: ${short(up)}`);
  log(`uploaded ${name} to the target`);

  // 5. restore. The handler answers 204 and does the work in the background; the lock it holds is visible as
  // canBackup=false on /api/health, and the target's superusers become the source's part way through, so the
  // wait accepts whichever of the two tokens the target still recognises.
  const rs = await call(to, "POST", `/api/backups/${encodeURIComponent(name)}/restore`, { token: toToken });
  if (rs.status !== 204) throw new Error(`POST ${to}/api/backups/${name}/restore: ${short(rs)}`);
  log(`restore started on the target`);
  const want = JSON.stringify(names(sourceCollections));
  let verified = "";
  for (const started = Date.now(); !verified && Date.now() - started < timeout; ) {
    await Bun.sleep(500);
    for (const token of [toToken, fromToken]) {
      if ((await canBackup(to, token)) !== true) continue;
      const have = await listCollections(to, token);
      if (have && JSON.stringify(names(have)) === want) { verified = token; break; }
    }
  }
  if (!verified) throw new Error(`the target did not come back with the source's collections within ${timeout / 1000}s: check ${to}/_/ and its logs; ${name} is still on both sides`);
  log(`the target answers again and lists the source's ${user.length} collection(s)${opts.from.email ? `; its superusers are now the source's (sign in there as ${opts.from.email})` : "; its superusers are now the source's"}`);

  // 6. the archive is a means, not a backup anybody asked for
  if (!opts.keep) {
    const d1 = await call(from, "DELETE", `/api/backups/${encodeURIComponent(name)}`, { token: fromToken });
    const d2 = await call(to, "DELETE", `/api/backups/${encodeURIComponent(name)}`, { token: verified });
    const left = [d1.status !== 204 ? `source (${short(d1)})` : "", d2.status !== 204 ? `target (${short(d2)})` : ""].filter(Boolean);
    log(left.length ? `deleted ${name} where it could; still on the ${left.join(" and ")}` : `deleted ${name} on both sides`);
  } else log(`kept ${name} on both sides (--keep)`);
  return { name, collections: names(sourceCollections), kept: !!opts.keep, dryRun: false };
}
