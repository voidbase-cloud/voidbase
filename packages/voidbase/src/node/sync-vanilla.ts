// `voidbase sync up` of an instance that is not a project (voidbase-stories voidbase/cli-instances.feature, journeys A
// and C: "Deploying it to the cloud"): a local instance `voidbase local` keeps, or the pb_data beside the executable.
// Such an instance declares itself, so on Cloudflare it becomes an instance that does the same: created from this CLI's
// release, with its rebuild Workflow and token, and then given the instance's shape through its own API: its collections
// (with its records when --data says so), its pb_public files (kept in its bucket, src/server/public-r2.ts) and its
// plugins (declared and rebuilt in). Later, `voidbase update --cloudflare` rebuilds it and its rollback leaves an update.
//
// pb_hooks are the one thing that stays here: an instance on Cloudflare that rebuilds itself runs no hooks, because they
// need the compiler a project deploy brings. The ones this instance has are named, and extending it is how they deploy.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CfApi, workerExists } from "../cloud/rest";
import { readLock } from "./installed";
import { readRegistry } from "./local";
import { call, migrate, signIn } from "./migrate";
import { readCredentials, withLocalInstance, type Superuser } from "./sync-data";

/** whether `root` is an instance rather than a project: one `voidbase local` keeps, or pb_data with no project entry beside it */
export function isVanillaLocal(root: string, registry = readRegistry()): boolean {
  const dir = resolve(root);
  if (registry.some((i) => resolve(i.dir) === dir)) return true;
  const project = ["package.json", "main.ts", "index.ts", "vite.config.ts"].some((f) => existsSync(join(dir, f)));
  return !project && existsSync(join(dir, "pb_data"));
}

/** the scaffold's example hook (src/node/local.ts), which is not something the instance's owner wrote */
const SCAFFOLD_HOOK = `/// <reference path="../pb_data/types.d.ts" />\nrouterAdd("GET", "/api/hello", (e) => e.json(200, { hello: "voidbase" }));\n`;

const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort().flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; }) : []);
const randomPassword = (): string => { const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => a[b % a.length]).join(""); };

export interface VanillaSyncOptions { root: string; api: CfApi; account: string; name: string; data: boolean; log?: (line: string) => void; email?: string }

export async function syncVanillaUp(o: VanillaSyncOptions): Promise<{ url: string; created: boolean }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const root = resolve(o.root); const dataDir = join(root, "pb_data");
  const saved = readCredentials(dataDir);
  const superuser: Superuser = { email: saved?.email ?? o.email ?? process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com", password: saved?.password ?? randomPassword() };
  log(`vanilla instance: ${root}, which declares itself; on Cloudflare it is created from this voidbase's release and rebuilds itself`);

  // 1. the instance: created from the release, or the one already there when it rebuilds itself
  let url: string | null = null; let created = false;
  if (await workerExists(o.api, o.account, o.name)) {
    const { rebuildReadiness } = await import("./cloud-rebuild");
    const ready = await rebuildReadiness(o.api, o.account, o.name);
    if (!ready.ok) throw new Error(`a Worker called ${o.name} already exists and does not rebuild itself (${ready.reason}): destroy it, or sync to another name`);
    if (!saved) throw new Error(`${o.name} exists, and ${join(dataDir, ".superuser-credentials")} does not say how to sign in to it`);
    const { workersSubdomain } = await import("../cloud/rest");
    const sub = await workersSubdomain(o.api, o.account);
    url = sub ? `https://${o.name}.${sub}.workers.dev` : null;
    log(`${o.name} exists and rebuilds itself: its shape is carried again (voidbase update --cloudflare ${o.name} takes a new voidbase)`);
  } else {
    const { createOnCloudflare } = await import("./cloud-create");
    const c = await createOnCloudflare({ api: o.api, account: o.account, name: o.name, email: superuser.email, password: superuser.password, log: (l) => log(l) });
    url = c.url; created = true;
    writeFileSync(join(dataDir, ".superuser-credentials"), `${JSON.stringify(superuser)}\n`, { mode: 0o600 });
    log(`superuser ${superuser.email}, kept in ${join(dataDir, ".superuser-credentials")}`);
  }
  if (!url) throw new Error("the account has no workers.dev subdomain, so the instance has no address to carry its shape to");
  for (let i = 0; i < 24; i++) { const r = await fetch(`${url}/api/health`).catch(() => null); if (r?.status === 200) break; await Bun.sleep(5000); }
  log(`live: ${url}`);

  // 2. its shape, read from this machine's instance served for the length of the move
  await withLocalInstance(dataDir, superuser, async (local) => {
    const cloudToken = await signIn({ url, ...superuser }, "the instance on Cloudflare");
    if (o.data) {
      log(`\ndata: taking this machine's records up to ${url}`);
      await migrate({ from: { url: local, ...superuser }, to: { url, ...superuser }, log: (l) => log(`  ${l}`) });
    } else {
      const localToken = await signIn({ url: local, ...superuser }, "this machine's instance");
      const listed = await call(local, "GET", "/api/collections?page=1&perPage=500&skipTotal=1", { token: localToken });
      const collections = ((listed.json.items ?? []) as { name: string; system?: boolean }[]).filter((c) => !c.system && !c.name.startsWith("_"));
      if (collections.length) {
        const imported = await call(url, "PUT", "/api/collections/import", { token: cloudToken, json: { collections, deleteMissing: false } });
        if (imported.status >= 300) throw new Error(`importing the collections into ${url}: ${imported.status} ${JSON.stringify(imported.json).slice(0, 300)}`);
      }
      log(`\ndata: left on this machine (voidbase sync up --data takes it up); its ${collections.length} collection(s) went up without their records`);
    }

    // pb_public, into the instance's bucket: one upload per directory, as the panel sends them
    const publicDir = join(root, "pb_public"); const files = walk(publicDir);
    const byDir = new Map<string, string[]>();
    for (const f of files) { const rel = relative(publicDir, f); const d = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""; byDir.set(d, [...(byDir.get(d) ?? []), f]); }
    for (const [d, group] of byDir) {
      const form = new FormData(); if (d) form.append("path", d);
      for (const f of group) form.append("files", new File([readFileSync(f)], f.slice(f.lastIndexOf("/") + 1)));
      const up = await call(url, "POST", "/api/pb_public", { token: cloudToken, body: form });
      if (up.status >= 300) throw new Error(`uploading pb_public/${d} to ${url}: ${up.status} ${JSON.stringify(up.json).slice(0, 300)}`);
    }
    if (files.length) log(`pb_public: ${files.length} file(s) kept in the instance's bucket`);

    // plugins: declared on the instance, which rebuilds them in
    const lock = readLock(root);
    const plugins = Object.entries(lock.plugins);
    const runsBefore = (((await call(url, "GET", "/api/rebuilds", { token: cloudToken })).json.runs ?? []) as unknown[]).length;
    for (const [name, e] of plugins) {
      const r = await call(url, "POST", "/api/plugins/install", { token: cloudToken, json: { name, version: e.version, marketplace: e.marketplace } });
      log(r.status < 300 ? `plugin ${name} ${e.version} declared` : `plugin ${name} ${e.version} not taken: ${String(r.json.message ?? r.status)}`);
    }
    if (plugins.length) {
      for (let i = 0; i < 120; i++) {
        const state = (await call(url, "GET", "/api/rebuilds", { token: cloudToken })).json as { runs?: { status: string; steps: { name: string; status: string; detail?: string }[] }[] };
        const runs = state.runs ?? []; const last = runs.at(-1);
        if (runs.length > runsBefore && last?.status === "done") { log(`plugins rebuilt in (rebuild ${runs.length})`); break; }
        if (runs.length > runsBefore && last?.status === "failed") { const st = last.steps.find((s) => s.status === "failed"); throw new Error(`the rebuild that brings the plugins in failed at ${st?.name}: ${st?.detail}`); }
        await Bun.sleep(5000);
      }
    }

    const hooks = walk(join(root, "pb_hooks")).filter((f) => readFileSync(f, "utf8") !== SCAFFOLD_HOOK);
    if (hooks.length) log(`pb_hooks: ${hooks.map((f) => relative(root, f)).join(", ")} stay on this machine: an instance that rebuilds itself on Cloudflare runs no hooks; extending it deploys them`);
  }, { keepOwnSuperuser: true });
  return { url, created };
}
