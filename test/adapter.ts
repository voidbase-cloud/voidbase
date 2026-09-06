// The Void adapter end to end: convert test/fixtures/void-app into a voidbase app, boot it with the generated
// main.ts and check that Void's own conventions still hold — route paths and params, middleware order, the
// runtime env behind void/storage and void/queues, a queue consumer, a cron job, Drizzle migrations, and the
// static build under pb_public. PocketBase's own API must keep winning over an app route of the same shape.
//   bun test/adapter.ts
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { adapt, scanVoidApp } from "../src/adapter/index";


const PKG = resolve(import.meta.dir, "..");
const FIXTURE = resolve(PKG, "test/fixtures/void-app");
// inside the repo so the app resolves `void` and `@voidbase-cloud/voidbase` the way a consumer would
const WORK = resolve(PKG, "test/.tmp/adapter-app");
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + detail}`); };

// a consumer resolves the package by name; in this repo that is a self-link
const selfLink = resolve(PKG, "node_modules/@voidbase-cloud/voidbase");
if (!existsSync(selfLink)) { mkdirSync(resolve(PKG, "node_modules/@voidbase-cloud"), { recursive: true }); symlinkSync(PKG, selfLink); }

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(FIXTURE, WORK, { recursive: true });

const procs: ReturnType<typeof Bun.spawn>[] = [];
try {
  // ---- the scan: Void's file conventions ------------------------------------------------------------------------
  const dev = scanVoidApp({ root: WORK, dev: true });
  const m = scanVoidApp({ root: WORK, dev: false });
  const urls = m.routes.map((r) => r.url);
  check("routes discovered from the file tree, index and (groups) collapsed", urls.includes("/api/hello") && urls.includes("/api/echo"), urls.join(" "));
  check("[id] becomes :id and [...path] becomes a catch-all with its name kept", urls.includes("/api/users/:id") && m.routes.some((r) => r.url === "/api/assets/*" && r.splat === "path"), urls.join(" "));
  check("a route on a path voidbase already serves is reported as shadowed", m.collisions.includes("/api/files/*") && !m.collisions.includes("/api/assets/*"), JSON.stringify(m.collisions));
  check("_-prefixed files are not routes", !urls.some((u) => u.includes("helpers")), urls.join(" "));
  check(".dev.ts is a route in development and absent from a build", dev.routes.some((r) => r.url === "/api/debug") && !urls.includes("/api/debug"), urls.join(" "));
  check("a literal segment is registered ahead of its sibling param, and catch-alls come last", urls.indexOf("/api/users/me") < urls.indexOf("/api/users/:id") && urls.indexOf("/api/users/:id") < urls.indexOf("/api/assets/*"), urls.join(" "));
  check("middleware keeps its numeric order, crons and queues are named after their files", m.middleware.map((x) => x.name).join() === "01.first,02.second" && m.crons[0]?.name === "tick" && m.queues[0]?.name === "mail", JSON.stringify([m.middleware.map((x) => x.name), m.crons.map((c) => c.name), m.queues.map((q) => q.name)]));
  check("the queue producer binding follows Void's naming", m.queues[0]?.binding === "QUEUE_MAIL", m.queues[0]?.binding ?? "");
  check("an app with server code is not a static build", m.mode === "server" && m.migrations.length === 1, `${m.mode} ${m.migrations.length}`);

  // ---- the conversion, through the Vite plugin the app actually uses ---------------------------------------------
  // --bun: Vite's config loader hands the config to the runtime, and voidbase ships TypeScript sources
  const build = Bun.spawnSync(["bunx", "--bun", "vite", "build"], { cwd: WORK, env: process.env, stdout: "pipe", stderr: "pipe" });
  const buildOut = build.stdout.toString() + build.stderr.toString();
  check("vite build succeeds with voidbaseAdapter() in the plugin list", build.exitCode === 0, buildOut.slice(-600));
  const generated = readFileSync(`${WORK}/.voidbase/void-app.ts`, "utf8");
  check("generated glue imports the app's own modules and mounts them", generated.includes('from "../routes/api/hello"') && generated.includes("mountVoidApp(app, {"), generated.slice(0, 200));
  check("main.ts is written for the app to run and for voidbase deploy to compose", existsSync(`${WORK}/main.ts`) && /export function register/.test(readFileSync(`${WORK}/main.ts`, "utf8")), "");
  const migration = readFileSync(`${WORK}/pb_migrations/0001_outbox.void.js`, "utf8");
  check("a Drizzle migration becomes a PocketBase migration, split on its statement markers", /CREATE TABLE/.test(migration) && /CREATE INDEX/.test(migration) && (migration.match(/execSQL/g) ?? []).length === 2, migration.slice(0, 160));
  check("the static build lands in pb_public, with a 404 shell for the asset layer", existsSync(`${WORK}/pb_public/index.html`) && existsSync(`${WORK}/pb_public/robots.txt`) && existsSync(`${WORK}/pb_public/404.html`), readdirSync(`${WORK}/pb_public`).join(" "));
  check("void/db and void/queues get runtime shims, because Void maps them to declaration files", existsSync(`${WORK}/.voidbase/shim-db.ts`) && existsSync(`${WORK}/.voidbase/shim-queues.ts`) && /shim-queues/.test(readFileSync(`${WORK}/.voidbase/tsconfig.json`, "utf8")), "");

  // a second pass must not duplicate or drift
  const again = adapt(WORK, { quiet: true, clientDir: "dist/client" });
  check("converting again is idempotent", readFileSync(`${WORK}/.voidbase/void-app.ts`, "utf8") === generated && again.manifest.routes.length === m.routes.length, "");

  // ---- a static app: nothing to run, so nothing is generated to run it ------------------------------------------
  const staticApp = resolve(PKG, "test/.tmp/static-app");
  mkdirSync(`${staticApp}/public`, { recursive: true });
  writeFileSync(`${staticApp}/public/index.html`, "<h1>ssg</h1>");
  const s1 = adapt(staticApp, { quiet: true });
  check("an app with no server code is static: pb_public only, no main.ts and no glue", s1.manifest.mode === "static" && existsSync(`${staticApp}/pb_public/index.html`) && !existsSync(`${staticApp}/main.ts`) && !existsSync(`${staticApp}/.voidbase/void-app.ts`), JSON.stringify({ mode: s1.manifest.mode, copied: s1.copied }));

  // ---- the app, running ------------------------------------------------------------------------------------------
  const port = (() => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port; s.stop(true); return p; })();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, VOIDBASE_SUPERUSER_EMAIL: "root@example.com", VOIDBASE_SUPERUSER_PASSWORD: "root-password-1", VOIDBASE_USER_EMAIL: "", VOIDBASE_USER_PASSWORD: "", VOIDBASE_LOG_MIN_LEVEL: "8", VOIDBASE_HOOKS_DIR: `${WORK}/pb_hooks`, VOIDBASE_MIGRATIONS_DIR: `${WORK}/pb_migrations` };
  procs.push(Bun.spawn(["bun", "main.ts", "--http", `127.0.0.1:${port}`, "--dir", `${WORK}/pb_data`], { cwd: WORK, env: env as Record<string, string>, stdout: "inherit", stderr: "inherit" }));
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* booting */ } await Bun.sleep(200); }

  const get = async (path: string, init?: RequestInit) => { const r = await fetch(base + path, init); return { status: r.status, type: r.headers.get("content-type") ?? "", json: (await r.clone().json().catch(() => ({}))) as Record<string, unknown>, text: await r.text() }; };

  const hello = await get("/api/hello");
  check("a Void route answers, with its return value converted like Void converts it", hello.status === 200 && hello.json.message === "hello" && hello.type.includes("application/json"), JSON.stringify(hello));
  const me = await get("/api/users/me");
  check("the literal route wins over the param route at request time", me.json.literal === true, JSON.stringify(me.json));
  const user = await get("/api/users/u42");
  check("c.req.param() sees the [id] segment", user.json.id === "u42", JSON.stringify(user.json));
  const file = await get("/api/assets/a/b/c.txt");
  check("a catch-all hands the whole tail to its param", file.json.path === "a/b/c.txt", JSON.stringify(file.json));
  const shadowed = await get("/api/files/a/b/c.txt");
  check("voidbase's own /api/files answers instead of the app's route on that path", shadowed.status === 404 && /collection/i.test(String(shadowed.json.message)), JSON.stringify(shadowed.json));
  const echo = await get("/api/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  check("a POST body reaches the handler", (echo.json.echoed as { a: number })?.a === 1, JSON.stringify(echo.json));
  const drizzle = await get("/api/drizzle");
  check("void/db reaches voidbase's D1 through the shim, with @schema tables", drizzle.status === 200 && typeof drizzle.json.rows === "number", JSON.stringify(drizzle.json));
  const bindings = await get("/api/bindings");
  check("void/storage and c.env.DB resolve against voidbase's own bindings", bindings.status === 200 && bindings.json.storage === true && Number(bindings.json.collections) > 0, JSON.stringify(bindings.json));
  const order = await get("/api/order");
  check("global middleware runs in file order before the handler", JSON.stringify(order.json.middleware) === JSON.stringify(["01", "02"]), JSON.stringify(order.json));
  const missing = await get("/api/nope");
  check("an unknown /api path is still a 404", missing.status === 404, String(missing.status));

  const enqueued = await get("/api/enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "queue@example.com" }) });
  const outbox1 = await get("/api/outbox");
  check("void/queues sends to the app queue and the consumer runs it (inline without a queue binding)", enqueued.json.queued === "queue@example.com" && (outbox1.json.outbox as string[])?.includes("queue@example.com"), JSON.stringify([enqueued.json, outbox1.json]));

  const su = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "root@example.com", password: "root-password-1" }) }).then((r) => r.json() as Promise<{ token: string }>);
  const crons = await fetch(`${base}/api/crons`, { headers: { authorization: su.token } }).then((r) => r.json() as Promise<{ id: string; expression: string }[]>);
  check("the cron is registered with the schedule its module exports", crons.some((j) => j.id === "tick" && j.expression === "*/5 * * * *"), JSON.stringify(crons.slice(0, 3)));
  await fetch(`${base}/api/crons/tick`, { method: "POST", headers: { authorization: su.token } });
  const outbox2 = await get("/api/outbox");
  check("running the cron reaches the app's scheduled handler with the bindings", (outbox2.json.outbox as string[])?.includes("cron@example.com"), JSON.stringify(outbox2.json));

  const root = await get("/");
  check("pb_public is served at / by the same process", root.status === 200 && root.text.includes("<h1>static</h1>"), `${root.status} ${root.text.slice(0, 60)}`);
  const robots = await get("/robots.txt");
  check("files from public/ ride along", robots.status === 200 && robots.text.includes("User-agent"), String(robots.status));
  const collections = await get("/api/collections?perPage=1");
  check("PocketBase's own API is untouched by the app's routes", collections.status === 401 || collections.status === 200, String(collections.status));
} finally {
  for (const p of procs) p.kill();
  rmSync(resolve(PKG, "test/.tmp"), { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
