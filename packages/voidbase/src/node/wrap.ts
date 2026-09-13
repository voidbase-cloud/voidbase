// `voidbase wrap <url>`: an extended project around an instance, with what the instance ran carried into it
// (voidbase-stories e-cloud-first.feature, "Wrapping the instance in a project": "the plugins it ran are written into
// pb_plugins", "their configuration comes with them", "I reinstall nothing by hand").
//
// The instance says what it declares (GET /api/plugins/declaration: each plugin's version, marketplace and commit, and
// the shipped plugins it removed) and how each plugin is configured (GET /api/plugins/config). Each plugin is installed
// into this project at the version the instance runs, from the marketplace it came from, and refused if that marketplace
// no longer approves the same commit, so the project runs the code the instance ran and not a lookalike. What an admin set
// on the instance becomes the plugin's config.json, which is how an extended project declares configuration. The project
// gets a package.json pinned to the instance's voidbase and an index.ts that serves the pb_ folders, unless it has them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addPlugin, readLock, writeLock } from "./installed";

export interface WrapOptions { url: string; email: string; password: string; dir: string; log?: (line: string) => void; fetchImpl?: typeof fetch }
export interface Wrapped { plugins: { name: string; version: string; commit: string }[]; configured: string[]; removed: string[]; voidbase: string; scaffolded: string[] }

interface Declared { plugins: Record<string, { version: string; marketplace: string; source: { repository: string; commit: string; directory?: string } }>; disabled: string[]; marketplaces: string[] }
interface Plane { editable: boolean; fields: Record<string, { value: unknown; source: string }> }

export async function wrapInstance(o: WrapOptions): Promise<Wrapped> {
  const log = o.log ?? (() => {});
  const f = o.fetchImpl ?? fetch;
  const base = o.url.replace(/\/+$/, "");
  const signIn = await f(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: o.email, password: o.password }) });
  if (!signIn.ok) throw new Error(`${base} refused the superuser sign-in (${signIn.status})`);
  const token = ((await signIn.json()) as { token?: string }).token ?? "";
  const get = async <T>(path: string): Promise<T> => { const r = await f(`${base}${path}`, { headers: { authorization: token } }); if (!r.ok) throw new Error(`${base}${path} answered ${r.status}`); return (await r.json()) as T; };
  const health = await get<{ data?: { voidbase?: { version?: string } } }>("/api/health");
  const voidbase = health.data?.voidbase?.version ?? "";
  const declared = await get<Declared>("/api/plugins/declaration");
  const planes = await get<Record<string, Plane>>("/api/plugins/config");
  mkdirSync(o.dir, { recursive: true });

  // the plugins, at the version and commit the instance runs
  const plugins: Wrapped["plugins"] = [];
  for (const [name, entry] of Object.entries(declared.plugins)) {
    const added = await addPlugin(o.dir, `${name}@${entry.version}`, { marketplace: entry.marketplace, voidbaseVersion: voidbase || "0.0.0", force: true });
    const pinned = readLock(o.dir).plugins[name];
    if (pinned?.source.commit !== entry.source.commit) throw new Error(`${entry.marketplace} approves ${name} ${entry.version} at ${pinned?.source.commit ?? "no commit"}, and the instance runs ${entry.source.commit}; this project would not run what the instance ran`);
    plugins.push({ name, version: added.version, commit: entry.source.commit });
    log(`${name} ${added.version} (${entry.source.repository}@${entry.source.commit.slice(0, 12)}) into pb_plugins/${name}`);
  }
  // the shipped plugins the instance removed stay removed, and the marketplaces it trusts are the project's
  const lock = readLock(o.dir);
  lock.disabled = [...new Set([...lock.disabled, ...declared.disabled])];
  lock.marketplaces = [...new Set([...declared.marketplaces, ...lock.marketplaces])];
  writeLock(o.dir, lock);

  // configuration: what an admin set on the instance, as the project's config.json
  const configured: string[] = [];
  for (const [name, plane] of Object.entries(planes)) {
    const set = Object.fromEntries(Object.entries(plane.fields).filter(([, fld]) => fld.source === "instance" || fld.source === "project").map(([k, fld]) => [k, fld.value]));
    if (!Object.keys(set).length) continue;
    const dir = join(o.dir, "pb_plugins", name); mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");
    const before = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
    writeFileSync(file, `${JSON.stringify({ ...before, ...set }, null, 2)}\n`);
    configured.push(name);
    log(`pb_plugins/${name}/config.json: ${Object.keys(set).join(", ")}`);
  }

  // the project around it, when it has none yet
  const scaffolded: string[] = [];
  if (!existsSync(join(o.dir, "package.json"))) {
    writeFileSync(join(o.dir, "package.json"), `${JSON.stringify({ name: "wrapped-instance", private: true, type: "module", scripts: { start: "bun index.ts" }, dependencies: { "@voidbase-cloud/voidbase": voidbase || "latest" } }, null, 2)}\n`);
    scaffolded.push("package.json");
  }
  if (!existsSync(join(o.dir, "index.ts"))) {
    writeFileSync(join(o.dir, "index.ts"), `import { voidbase } from "@voidbase-cloud/voidbase";\n\nconst app = await voidbase({ dir: "pb_data", hooksDir: "pb_hooks", migrationsDir: "pb_migrations", pluginsDir: "pb_plugins", publicDir: "pb_public" });\nawait app.start();\n`);
    scaffolded.push("index.ts");
  }
  if (scaffolded.length) log(`wrote ${scaffolded.join(" and ")}`);
  log(`wrapped ${base}: ${plugins.length} plugin(s), ${configured.length} configured, ${declared.disabled.length} shipped plugin(s) kept removed`);
  return { plugins, configured, removed: declared.disabled, voidbase, scaffolded };
}
