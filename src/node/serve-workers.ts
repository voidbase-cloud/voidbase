// `voidbase serve --workers`: the instance on Cloudflare's local runtime, so the Workers code runs on this machine
// the way it runs deployed. The project is the one `voidbase deploy` would generate (deployToCloudflare with
// `local: true`: same files, local ids, nothing reaches Cloudflare), and Void's dev server runs it in workerd
// through Miniflare: D1, R2, the jobs queue and the realtime hub Durable Object are all local, persisted under the
// project's .void/. Void applies db/migrations to that D1 when the server starts (the same runner its deploy uses),
// the superuser comes from the project's .env on the first request, the way the Worker's secrets seed it deployed.
//
// Why Void's dev server and not `wrangler dev`: the generated project is a Void app (vite.config.ts with voidPlugin
// and pbHooksPlugin, routes/, crons/, queues/), so there is no built Worker for wrangler to run until `vp build`
// has produced one, and that build is the slow, memory-hungry step. `vp dev` bundles on the fly, reads the
// generated wrangler.jsonc for the bindings Void cannot infer (the hub), needs no login and no account, and
// delivers queue batches natively. `vp preview` (the built Worker in workerd) stays the production rehearsal.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deployToCloudflare, type DeployOptions } from "./deploy-cf";

export interface ServeWorkersOptions {
  http?: string; dir?: string; hooksDir?: string; migrationsDir?: string; pluginsDir?: string; secretsDir?: string; publicDir?: string;
  name?: string; queue?: boolean; hub?: boolean; log?: (line: string) => void;
  /** how long to wait for the first /api/health 200 before giving up (ms); the first workerd start can take a while */
  timeout?: number;
}

export interface WorkersServer {
  project: string; url: string; state: string; child: ReturnType<typeof Bun.spawn>;
  /** resolves with the dev server's exit code once it is gone */
  exited: Promise<number>;
  stop: () => Promise<void>;
}

const PKG = resolve(import.meta.dir, "../..");

export async function serveWorkers(opts: ServeWorkersOptions = {}): Promise<WorkersServer> {
  const log = opts.log ?? ((l: string) => console.log(l));
  // the `pocketbase serve` flags become the environment the project generation reads
  const setDir = (key: string, v: string | undefined) => { if (v) process.env[key] = resolve(v); };
  setDir("VOIDBASE_DATA_DIR", opts.dir); setDir("VOIDBASE_HOOKS_DIR", opts.hooksDir); setDir("VOIDBASE_MIGRATIONS_DIR", opts.migrationsDir);
  setDir("VOIDBASE_PLUGINS_DIR", opts.pluginsDir); setDir("VOIDBASE_SECRETS_DIR", opts.secretsDir);
  const [hostname = "127.0.0.1", portStr] = (opts.http ?? "127.0.0.1:8090").split(":");
  const port = Number(portStr ?? 8090);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`voidbase: --http ${opts.http}: not a host:port`);

  const gen: DeployOptions = { local: true, name: opts.name, publicDir: opts.publicDir, queue: opts.queue, hub: opts.hub, log };
  const r = await deployToCloudflare(gen);
  const cloud = r.project;
  const state = resolve(cloud, ".void");

  // the toolchain comes with the voidbase package: vp (vite-plus) runs Vite with the Void plugin, which runs workerd
  const vp = resolve(Bun.resolveSync("vite-plus/package.json", PKG), "..", "..", ".bin", "vp");
  const workerd = resolve(Bun.resolveSync("workerd/package.json", PKG), "..");
  if (!existsSync(vp)) throw new Error(`voidbase: ${vp} not found: the Cloudflare toolchain comes with the npm package (bun install)`);
  const binDirs = [resolve(PKG, "node_modules/.bin"), resolve(vp, "..")].filter((d, i, a) => a.indexOf(d) === i);
  // a checkout's tsconfig.json extends the .void/tsconfig.json that `void prepare` writes; Vite loads it for every
  // file of this package the project imports, so a fresh clone gets that step here rather than a tsconfig error
  if (existsSync(resolve(PKG, "tsconfig.json")) && !existsSync(resolve(PKG, ".void/tsconfig.json"))) {
    const p = Bun.spawn([resolve(vp, "..", "void"), "prepare"], { cwd: PKG, stdout: "ignore", stderr: "inherit" });
    if ((await p.exited) !== 0) throw new Error(`voidbase: void prepare failed in ${PKG}`);
  }
  // Void runs project code with Node (its env probe): an installed voidbase is TypeScript under node_modules, which
  // Node will not strip on its own, so Node gets this package's loader, as the deploy does
  const loader = `--import ${pathToFileURL(resolve(PKG, "src/node/ts-loader.mjs")).href}`;
  const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, loader].filter(Boolean).join(" "), PATH: `${binDirs.join(":")}:${process.env.PATH ?? ""}`, FORCE_COLOR: process.env.FORCE_COLOR ?? "0" };
  // Void strips a .env key the shell also exports with the same value, so the project's vars stay out of the child's shell
  for (const k of r.vars ?? []) delete env[k];
  delete env.VOIDBASE_PERSIST_TO; // the state lives with the project; the migration runner only knows that place
  // the .env files one level up are the project's, not this Worker's: the generated project has its own
  const child = Bun.spawn([vp, "dev", "--host", hostname, "--port", String(port), "--strictPort", "--clearScreen", "false"], { cwd: cloud, env: env as Record<string, string>, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const exited = child.exited;
  const url = `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`;
  log(`starting Cloudflare's local runtime (workerd ${readVersion(workerd)}) in ${cloud}`);

  // the first request bootstraps the instance: system collections, the superuser from .env, pb_migrations
  const deadline = Date.now() + (opts.timeout ?? 180_000);
  let health = 0; let gone: number | null = null;
  void exited.then((code) => { gone = code; });
  while (health !== 200 && Date.now() < deadline && gone === null) {
    await Bun.sleep(500);
    health = await fetch(`${url}/api/health`).then((x) => x.status).catch(() => 0);
  }
  if (gone !== null) throw new Error(`voidbase: the dev server exited with ${gone} before answering (project: ${cloud})`);
  if (health !== 200) log(`voidbase: ${url}/api/health has not answered 200 yet (last status ${health}); the server keeps starting`);

  const su = r.superuser;
  const where = su?.source === "generated" || su?.source === "file" ? `password in ${su.file}` : "password from VOIDBASE_SUPERUSER_PASSWORD";
  log(`\nvoidbase on Cloudflare's local runtime (workerd via Void dev; data: ${state}, hooks: ${process.env.VOIDBASE_HOOKS_DIR || resolve("pb_hooks")})`);
  log(`  D1 ${r.name}-db, R2 ${r.name}-storage${opts.queue === false ? "" : `, queue ${r.name}-jobs`}${opts.hub === false ? "" : ", realtime hub"}: Miniflare's, in ${state}`);
  log(`  project: ${cloud} (what voidbase deploy would upload; regenerated on every start)`);
  log(`  cron triggers do not tick here: maintenance runs lazily in requests (Void prints how to fire a trigger by hand)`);
  log(`Server started at ${url}\n├─ REST API:  ${url}/api/\n└─ Dashboard: ${url}/_/   sign in as ${su?.email ?? "the superuser"} (${where})`);

  const stop = async () => {
    if (gone !== null) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 10_000);
    await exited; clearTimeout(t);
  };
  return { project: cloud, url, state, child, exited, stop };
}

function readVersion(dir: string): string {
  try { return String((JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { version?: string }).version ?? ""); } catch { return ""; }
}
