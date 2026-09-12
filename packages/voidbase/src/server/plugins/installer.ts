// The installer, the shipped plugin through which an instance changes its own plugins.
//
// Three places an instance's plugins can live, and the installer knows which it is in:
//   filesystem   Bun (voidbase serve, the executable): pb_plugins and voidbase.lock on disk, changed in place the
//                way `voidbase plugins add|remove|update` changes them; the instance loads them when it restarts.
//   repository   a project deployed from a repository (voidbase.cloud's project instances, the demo, any pipeline
//                that is a push): VOIDBASE_PROJECT_REPO and VOIDBASE_GH_TOKEN name it, and a change is one commit
//                there (../project-sync.ts) that the repository's own build deploys.
//   fixed        a Worker built without either: its plugins were fixed when it was built, and the answer says what
//                to connect.
// The routes are a superuser's, like /api/plugins itself. Nothing here runs a plugin: what is written is what the
// instance verifies for itself when it loads (the lockfile's integrity against the bundle's bytes).
//
// A request names only a marketplace the project already trusts: one voidbase.lock lists under `marketplaces`, or the
// one an installed plugin of the same name came from. The integrity is the named marketplace's own promise about its own bundle, so it
// proves the bytes and not the source, and an installed plugin runs with the Worker's env, which holds every secret (a
// deploy.js runs in the build, with the deploy token). A superuser session is not the project's owner, and the demo
// publishes its login, so trusting a new marketplace is the owner's act where the project lives: a commit to
// voidbase.lock, or `voidbase plugins add --marketplace` on their own checkout (src/node/installed.ts), which is why
// that one keeps accepting a marketplace it has not seen.
import type { Context, Hono } from "hono";
import { filesystem as platformFilesystem } from "#platform/plugins";
import { requireSuperuser } from "../auth-slot";
import { badRequest } from "../errors";
// where this instance's plugins live is the core's own fact and lives in the core (../installer-info.ts): the
// answer to GET /api/plugins carries it whatever is loaded, so plugins/report.ts has to reach it without importing
// this module, and lifting this plugin into a package of its own leaves that file where it is.
import { installerInfo, repoOf, type FilesystemInstaller } from "../installer-info";
import type { Kernel } from "../kernel";
import { refusal, removalCost, type PluginFacts } from "./resolve";
import { download, fetchIndex, pick, type PluginVersion } from "../../node/registry";
import { commitPlugins, LOCKFILE, lockOf, type Lock, type PluginChange, type Repo } from "../project-sync";
import type { AppEnv } from "../types";
import type { Plugin } from "./manifest";

const OFFICIAL = "https://marketplace.voidbase.cloud";
const NAME = /^[a-z][a-z0-9-]*$/;
const MARKETPLACE = /^https?:\/\/[^\s/]+(\/[^\s]*)?$/;

interface Body { name?: unknown; version?: unknown; marketplace?: unknown; force?: unknown }
const readBody = async (c: Context<AppEnv>): Promise<Body> => { try { return (await c.req.json()) as Body; } catch { return {}; } };
const nameOf = (b: Body): string => { const n = String(b.name ?? "").trim(); if (!NAME.test(n)) throw badRequest(`${JSON.stringify(n)} is not a plugin name.`); return n; };
/** a marketplace URL trimmed and without its trailing slashes: how a request's is read, and how a lockfile's is compared with it */
const normalMarketplace = (m: unknown): string => String(m ?? "").trim().replace(/\/+$/, "");
const marketplaceOf = (b: Body): string | undefined => { const m = b.marketplace ? normalMarketplace(b.marketplace) || undefined : undefined; if (m && !MARKETPLACE.test(m)) throw badRequest(`${JSON.stringify(m)} is not a marketplace URL.`); return m; };

/**
 * What a project trusts for one plugin: the marketplaces it lists, and the one that plugin came from if it is installed,
 * read the way a request is. The second is per name, so a marketplace recorded on echo's entry is no way to commit a
 * plugin of another name from it, and it stops counting once echo is removed.
 */
const trustedOf = (listed: readonly string[], installedFrom: readonly string[]): string[] => [...new Set([...listed, ...installedFrom].map(normalMarketplace).filter(Boolean))];
const trustedInLock = (lock: Lock, name: string): string[] => trustedOf(lock.marketplaces, lock.plugins[name] ? [lock.plugins[name]!.marketplace] : []);
const trustedOnDisk = (fs: FilesystemInstaller, name: string): string[] => { const l = fs.list(); return trustedOf(l.marketplaces, l.installed.filter((p) => p.name === name).map((p) => p.marketplace)); };
/**
 * A 400 unless `m` is one of `trusted`, raised before `m` is asked for anything. The URLs are compared whole and never
 * by a prefix: https://listed.example/x, https://listed.example.evil.example and https://listed.example@evil.example
 * all start with https://listed.example, and the last one is a request to evil.example. The answer names the lockfile
 * and the owner's two ways to trust another marketplace, since no command edits the list: an edit to `marketplaces`
 * in voidbase.lock, or the CLI's own add, which records the marketplace on the plugin's entry.
 */
function requireTrusted(m: string, trusted: string[], where: { repo: Repo } | { root: string }, name = "<name>"): void {
  if (trusted.includes(normalMarketplace(m))) return;
  // on Bun, VOIDBASE_PLUGIN_MARKETPLACES replaces the lockfile's list when it is set (src/node/installed.ts), so that is where the URL goes
  const envList = "root" in where ? String((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VOIDBASE_PLUGIN_MARKETPLACES ?? "").trim() : "";
  const how = "repo" in where
    ? `add it to "marketplaces" in ${LOCKFILE} on ${where.repo.fullName} (${where.repo.branch}) and commit that, or run voidbase plugins add ${name} --marketplace ${m} in a checkout of ${where.repo.fullName}, commit pb_plugins/${name} and ${LOCKFILE}, and push`
    : envList
      ? `add it to VOIDBASE_PLUGIN_MARKETPLACES, which this instance reads in place of the lockfile's list, or run voidbase plugins add ${name} --marketplace ${m} --dir ${where.root}`
      : `add it to "marketplaces" in ${where.root}/${LOCKFILE}, or run voidbase plugins add ${name} --marketplace ${m} --dir ${where.root}`;
  const listed = envList ? "the marketplaces VOIDBASE_PLUGIN_MARKETPLACES names" : `the marketplaces its ${LOCKFILE} lists under "marketplaces"`;
  throw badRequest(`The marketplace ${m} is not one this project trusts for ${name}, and nothing was asked of it. A project trusts ${listed}, and for a plugin already installed the one it came from: ${trusted.join(", ") || "none"}. To trust ${m}, ${how}.`);
}

/** a change on a project: resolved against the marketplaces, downloaded and verified here, committed there */
async function onRepository(repo: Repo, o: { add?: { name: string; version?: string; marketplace?: string }; remove?: string; update?: string }, voidbaseVersion: string) {
  const lock = await lockOf(repo);
  const change: PluginChange = { add: [], remove: [] };
  const resolveAdd = async (name: string, version: string | undefined, marketplace: string | undefined) => {
    // held to the lock as it stood before this change; update names the plugin's own marketplace, which the lock trusts by recording it
    if (marketplace) requireTrusted(marketplace, trustedInLock(lock, name), { repo }, name);
    const marketplaces = marketplace ? [marketplace] : lock.plugins[name]?.marketplace ? [lock.plugins[name]!.marketplace] : lock.marketplaces;
    let found: { marketplace: string; url: string; v: PluginVersion } | null = null;
    for (const m of marketplaces) { try { const got = await fetchIndex(m); const v = pick(got.index, name, version); if (v) { if (found) throw badRequest(`${name} is served by ${found.marketplace} and ${m}; say which with marketplace.`); found = { marketplace: m, url: got.url, v }; } } catch (err) { if (err instanceof Error && /say which/.test(err.message)) throw err; } }
    if (!found) throw badRequest(`${name}${version ? `@${version}` : ""} is not served by ${marketplaces.join(", ")}.`);
    if (found.v.manifest.name !== name) throw badRequest(`${found.marketplace} serves ${name} with a manifest called ${JSON.stringify(found.v.manifest.name)}; nothing was changed.`);
    const { satisfies } = await import("./resolve");
    if (!satisfies(voidbaseVersion, found.v.manifest.voidbase)) throw badRequest(`${name} ${found.v.version} works against voidbase ${found.v.manifest.voidbase}, and this instance runs ${voidbaseVersion}; nothing was changed.`);
    const got = await download(found.url, found.v);
    if (!got.verified) throw badRequest(`${got.url} is not the bytes ${found.marketplace} promised (${found.v.integrity}); nothing was changed.`);
    return { name, version: found.v, marketplace: found.marketplace, bytes: got.bytes };
  };
  if (o.add) {
    const have = lock.plugins[o.add.name];
    const a = await resolveAdd(o.add.name, o.add.version, o.add.marketplace);
    if (have && have.version === a.version.version && have.integrity === a.version.integrity) return { unchanged: true, name: a.name, version: a.version.version, marketplace: a.marketplace };
    change.add.push(a);
  }
  if (o.remove) { if (!lock.plugins[o.remove]) throw badRequest(`${o.remove} is not installed on this project.`); change.remove.push(o.remove); }
  if (o.update !== undefined) {
    const names = o.update ? [o.update] : Object.keys(lock.plugins);
    for (const n of names) { const have = lock.plugins[n]; if (!have) throw badRequest(`${n} is not installed on this project.`); const a = await resolveAdd(n, undefined, have.marketplace); if (a.version.version !== have.version || a.version.integrity !== have.integrity) change.add.push(a); }
    if (!change.add.length) return { unchanged: true, current: names };
  }
  const committed = await commitPlugins(repo, change);
  return { committed: { sha: committed.sha, url: committed.url, branch: committed.branch, repository: repo.fullName }, added: change.add.map((a) => ({ name: a.name, version: a.version.version, marketplace: a.marketplace })), removed: change.remove };
}

function mountRoutes(app: Hono<AppEnv>, voidbaseVersion: string, filesystem: FilesystemInstaller | null, graph: () => PluginFacts[]) {
  const restart = "An instance loads plugins when it starts: restart it to load the change.";
  const modeOf = (c: Context<AppEnv>) => { requireSuperuser(c); const info = installerInfo(c.env, filesystem); if (info.mode === "fixed") throw badRequest(info.hint!); return info; };
  app.get("/api/plugins/available", async (c) => {
    requireSuperuser(c);
    // Reading what another marketplace serves stays open to a superuser: it installs nothing, and an install from it is
    // still held to what the project trusts (requireTrusted). The /cloud panel reads one before its owner trusts it.
    const extra = normalMarketplace(c.req.query("marketplace"));
    const marketplaces = [OFFICIAL, ...(extra && extra !== OFFICIAL && MARKETPLACE.test(extra) ? [extra] : [])];
    const available = await Promise.all(marketplaces.map(async (marketplace) => { try { const { index } = await fetchIndex(marketplace); return { marketplace, plugins: index.plugins.map((p) => ({ name: p.name, title: p.title, summary: p.summary, latest: p.latest, repository: p.repository })) }; } catch (err) { return { marketplace, plugins: [], error: err instanceof Error ? err.message : String(err) }; } }));
    return c.json({ installer: installerInfo(c.env, filesystem), available });
  });
  app.post("/api/plugins/install", async (c) => {
    const info = modeOf(c); const b = await readBody(c); const name = nameOf(b); const version = b.version ? String(b.version) : undefined; const marketplace = marketplaceOf(b);
    if (info.mode === "filesystem") { try { if (marketplace) requireTrusted(marketplace, trustedOnDisk(filesystem!, name), { root: filesystem!.root }, name); const a = await filesystem!.add(version ? `${name}@${version}` : name, { marketplace, voidbaseVersion }); return c.json({ applied: "filesystem", ...a, message: a.unchanged ? `${a.name} ${a.version} is already installed.` : `Installed ${a.name} ${a.version} from ${a.marketplace}. ${restart}` }); } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)); } }
    const r = await onRepository(repoOf(c.env)!, { add: { name, version, marketplace } }, voidbaseVersion);
    return c.json({ applied: "repository", ...r, message: r.unchanged ? `${name} is already installed at that version.` : `Committed to ${info.repository}; its build deploys it.` });
  });
  app.post("/api/plugins/remove", async (c) => {
    const info = modeOf(c); const b = await readBody(c); const name = nameOf(b); const force = b.force === true;
    // A core plugin, or the only provider of something else's requirement, goes on purpose or not at all. The
    // instance answers what stops working rather than doing it, and `force: true` is the saying-so.
    const cost = force ? null : removalCost(graph(), name);
    if (cost) return c.json({ message: refusal(cost, 'To go ahead, send this again with "force": true.'), core: cost.core, provides: cost.provides, dependents: cost.dependents }, 409);
    if (info.mode === "filesystem") { const r = filesystem!.remove(name, { force: true }); return c.json({ applied: "filesystem", result: r, message: r === "removed" ? `Removed ${name}. ${restart}` : r === "disabled" ? `${name} ships with voidbase; it is now turned off for this project. ${restart}` : `${name} was already turned off.` }); }
    const r = await onRepository(repoOf(c.env)!, { remove: name }, voidbaseVersion);
    return c.json({ applied: "repository", ...r, message: `Committed to ${info.repository}; its build deploys it.` });
  });
  app.post("/api/plugins/update", async (c) => {
    const info = modeOf(c); const b = await readBody(c); const name = b.name ? nameOf(b) : undefined;
    if (info.mode === "filesystem") { try { const u = await filesystem!.update(name, { voidbaseVersion }); return c.json({ applied: "filesystem", ...u, message: u.updated.length ? `Updated ${u.updated.map((x) => `${x.name} ${x.from} -> ${x.to}`).join(", ")}. ${restart}` : "Everything is up to date." }); } catch (err) { throw badRequest(err instanceof Error ? err.message : String(err)); } }
    const r = await onRepository(repoOf(c.env)!, { update: name ?? "" }, voidbaseVersion);
    return c.json({ applied: "repository", ...r, message: r.unchanged ? "Everything is up to date." : `Committed to ${info.repository}; its build deploys it.` });
  });
}

/**
 * `graph` is what this instance loaded, asked at request time rather than held: the removal check needs the tiers
 * and the requires of the whole set, and the kernel knows them only once it has loaded them (app.ts passes
 * `() => whatLoaded(kernel).plugins`). Without one nothing is guarded, which is what a bare test app wants.
 */
export const installer = (voidbaseVersion: string, filesystem: FilesystemInstaller | null = platformFilesystem, graph: () => PluginFacts[] = () => []): Plugin => ({
  manifest: { name: "installer", version: "0.1.0", tier: "official", voidbase: "*" },
  info: (env) => installerInfo(env, filesystem),
  apply(ctx: Kernel) { mountRoutes(ctx.app, voidbaseVersion, filesystem, graph); },
});
