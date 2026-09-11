// The Void adapter end to end: generate a voidbase app under .voidbase/ from test/fixtures/void-app, boot it with
// the generated main.ts and check that Void's own conventions still hold — route paths and params, middleware order, the
// runtime env behind void/storage and void/queues, a queue consumer, a cron job, Drizzle migrations, the
// static build under pb_public, and the `pwa` option (manifest, icons, service worker). PocketBase's own API must
// keep winning over an app route of the same shape.
//   bun test/adapter.ts
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { adapt, scanVoidApp } from "../src/adapter/index";
import { ensurePanelDir } from "../src/node/panel";
import { integrityOf } from "../src/node/registry";
import { cronTriggers } from "../hooks-plugin";


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
// the copy resolves the package from the checkout this test lives in: in a worktree the shared node_modules links
// @voidbase-cloud/voidbase to another checkout, and the build has to exercise this code, not a sibling's
mkdirSync(resolve(WORK, "node_modules/@voidbase-cloud"), { recursive: true });
symlinkSync(PKG, resolve(WORK, "node_modules/@voidbase-cloud/voidbase"));

const procs: ReturnType<typeof Bun.spawn>[] = [];
try {
  // ---- the scan: Void's file conventions ------------------------------------------------------------------------
  const dev = scanVoidApp({ root: WORK, dev: true });
  // a workflow: bundled as one ES module beside the app, its class named on the first line for the deploy to export
  mkdirSync(`${WORK}/workflows`, { recursive: true });
  writeFileSync(`${WORK}/workflows/nightly-report.ts`, 'import { WorkflowEntrypoint } from "cloudflare:workers";\nimport { withApp } from "@voidbase-cloud/voidbase/workflows";\nimport { pb } from "@voidbase-cloud/voidbase/adapter";\nexport default class NightlyReport extends WorkflowEntrypoint<{ DB: D1Database }> {\n  async run(_event: unknown, step: { do<T>(name: string, fn: () => Promise<T>): Promise<T> }) {\n    return step.do("count", () => withApp(this.env as never, async () => (await pb.$app.findRecordsByFilter("posts", "", "", 100, 0)).length));\n  }\n}\n');
  const m = scanVoidApp({ root: WORK, dev: false });
  const urls = m.routes.map((r) => r.url);
  check("routes discovered from the file tree, index and (groups) collapsed", urls.includes("/api/hello") && urls.includes("/api/echo"), urls.join(" "));
  check("[id] becomes :id and [...path] becomes a catch-all with its name kept", urls.includes("/api/users/:id") && m.routes.some((r) => r.url === "/api/assets/*" && r.splat === "path"), urls.join(" "));
  check("a route on a path voidbase already serves is reported as shadowed", m.collisions.includes("/api/files/*") && !m.collisions.includes("/api/assets/*"), JSON.stringify(m.collisions));
  check("_-prefixed files are not routes", !urls.some((u) => u.includes("helpers")), urls.join(" "));
  check(".dev.ts is a route in development and absent from a build", dev.routes.some((r) => r.url === "/api/debug") && !urls.includes("/api/debug"), urls.join(" "));
  check("a literal segment is registered ahead of its sibling param, and catch-alls come last", urls.indexOf("/api/users/me") < urls.indexOf("/api/users/:id") && urls.indexOf("/api/users/:id") < urls.indexOf("/api/assets/*"), urls.join(" "));
  check("middleware keeps its numeric order, every vb_hooks/ file names the hook it is, crons and queues are named after their files", m.middleware.map((x) => x.name).join() === "01.first,02.second" && m.hooks.map((x) => `${x.name}:${x.hook}`).join() === "00.boot:onBootstrap,10.audit:onRecordsListRequest" && m.crons[0]?.name === "tick" && m.queues[0]?.name === "mail", JSON.stringify([m.middleware.map((x) => x.name), m.hooks.map((x) => `${x.name}:${x.hook}`), m.crons.map((c) => c.name), m.queues.map((q) => q.name)]));
  check("the queue producer binding follows Void's naming", m.queues[0]?.binding === "QUEUE_MAIL", m.queues[0]?.binding ?? "");
  check("an app with server code is not a static build", m.mode === "server" && m.migrations.length === 1, `${m.mode} ${m.migrations.length}`);
  check("vb_migrations/, vb_hooks/ and vb_secrets/ are the only directories the adapter adds to a Void app", m.extras.migrationsDir === "vb_migrations" && m.extras.secretsDir === "vb_secrets" && Object.keys(m.extras).length === 2 && m.hooks.length === 2, JSON.stringify([m.extras, m.hooks.length]));

  // a vb_hooks/ file that names no hook cannot be registered anywhere, so the build says so instead of dropping it
  writeFileSync(`${WORK}/vb_hooks/99.orphan.ts`, 'export default async () => {};\n');
  let orphan = "";
  try { scanVoidApp({ root: WORK }); } catch (err) { orphan = err instanceof Error ? err.message : String(err); }
  check("a vb_hooks/ file attached to no hook fails the build, by name", /99\.orphan\.ts is not attached to a hook/.test(orphan) && /defineHook/.test(orphan), orphan.split("\n")[0] ?? "(no error)");
  writeFileSync(`${WORK}/vb_hooks/99.orphan.ts`, 'export const hook = "onRecordCreated";\nexport default () => {};\n');
  let badName = "";
  try { scanVoidApp({ root: WORK }); } catch (err) { badName = err instanceof Error ? err.message : String(err); }
  check("a hook name that is not PocketBase's fails the build, with the nearest real ones", /"onRecordCreated", which is not one of PocketBase's hooks/.test(badName) && /onRecordCreate\b/.test(badName), badName.split("\n")[0] ?? "(no error)");
  rmSync(`${WORK}/vb_hooks/99.orphan.ts`);
  // and a PocketBase hook left in Void's middleware/ would be called with the wrong arguments, so it is sent next door
  writeFileSync(`${WORK}/middleware/99.misplaced.ts`, 'import { defineHook } from "@voidbase-cloud/voidbase/adapter";\nexport default defineHook("onBootstrap", async (e) => { await e.next(); });\n');
  let misplaced = "";
  try { scanVoidApp({ root: WORK }); } catch (err) { misplaced = err instanceof Error ? err.message : String(err); }
  check("a PocketBase hook left in middleware/ is sent to vb_hooks/", /99\.misplaced\.ts is a PocketBase hook \("onBootstrap"\)/.test(misplaced) && /vb_hooks\//.test(misplaced), misplaced.split("\n")[0] ?? "(no error)");
  rmSync(`${WORK}/middleware/99.misplaced.ts`);
  // a value in vb_secrets/secrets.json that main.ts does not declare would never reach the Worker, so the build says so
  const secretsJson = readFileSync(`${WORK}/vb_secrets/secrets.json`, "utf8");
  writeFileSync(`${WORK}/vb_secrets/secrets.json`, JSON.stringify({ ...JSON.parse(secretsJson), STRAY_SECRET: "x" }));
  let stray = "";
  try { scanVoidApp({ root: WORK }); } catch (err) { stray = err instanceof Error ? err.message : String(err); }
  check("a secret value that vb_secrets/main.ts does not declare fails the build, by name", /STRAY_SECRET, which vb_secrets\/main\.ts does not declare/.test(stray), stray.split("\n")[0] ?? "(no error)");
  writeFileSync(`${WORK}/vb_secrets/secrets.json`, secretsJson);
  check("vb_secrets/main.ts names the configuration and its tiers without being run", m.secrets?.names.join() === "TEST_SECRET,OTHER_SECRET,MAX_ITEMS,PUBLIC_LABEL" && m.secrets.access.TEST_SECRET === "secret" && m.secrets.access.MAX_ITEMS === "server" && m.secrets.access.PUBLIC_LABEL === "public" && m.extras.secretsDir === "vb_secrets", JSON.stringify(m.secrets));

  // ---- an installed plugin at the project root: pb_plugins and voidbase.lock are carried into the generated app ----
  // written the way `voidbase plugins add` writes them, with the hash the lockfile has to carry
  const carried = 'import { onBootstrap } from "@voidbase-cloud/voidbase/kernel";\nimport { ensureCollections } from "@voidbase-cloud/voidbase/plugins/collections";\nconst manifest = { name: "carried", version: "1.0.0", tier: "community", voidbase: "*", collections: ["carried_notes"] };\nconst plugin = { manifest, apply(ctx) { ctx.app.get("/api/carried", (c) => c.text("carried")); onBootstrap(ctx, (env) => ensureCollections(plugin, env.DB, [{ name: "carried_notes", type: "base", fields: [{ name: "text", type: "text" }] }])); } };\nexport default plugin;\n';
  mkdirSync(`${WORK}/pb_plugins/carried`, { recursive: true });
  writeFileSync(`${WORK}/pb_plugins/carried/bundle.js`, carried);
  writeFileSync(`${WORK}/voidbase.lock`, JSON.stringify({ lockfileVersion: 1, marketplaces: [], plugins: { carried: { version: "1.0.0", integrity: await integrityOf(new TextEncoder().encode(carried)), marketplace: "http://marketplace.invalid", source: { repository: "example/carried", commit: "0123456" }, installedOn: "2026-09-09" } }, disabled: [] }, null, 2));

  // ---- the conversion, through the Vite plugin the app actually uses ---------------------------------------------
  // --bun: Vite's config loader hands the config to the runtime, and voidbase ships TypeScript sources
  const build = Bun.spawnSync(["bunx", "--bun", "vite", "build"], { cwd: WORK, env: process.env, stdout: "pipe", stderr: "pipe" });
  const buildOut = build.stdout.toString() + build.stderr.toString();
  check("vite build succeeds with voidbaseAdapter() in the plugin list", build.exitCode === 0, buildOut.slice(-600));
  const generated = readFileSync(`${WORK}/.voidbase/void-entry.ts`, "utf8");
  check("the bundle entry imports the app's own modules and mounts them", generated.includes('from "../routes/api/hello"') && generated.includes("mountVoidApp({") && /hook: "onBootstrap", handler: hook0/.test(generated), generated.slice(0, 200));
  const bundle = readFileSync(`${WORK}/.voidbase/pb_hooks/void-app.js`, "utf8");
  check("routes and middleware are compiled into a pb_hooks bundle, marked so the hook transform leaves it alone", bundle.startsWith("// voidbase:raw") && /module\.exports/.test(bundle) && !/require\("node:async_hooks"\)/.test(bundle) && /globalThis/.test(bundle), bundle.slice(0, 120));
  check("the hook publishes the hook globals before it requires the bundle, so pb works at module init",
    /globalThis\.__voidbaseHooks = __g;[\s\S]*require\(/.test(readFileSync(`${WORK}/.voidbase/pb_hooks/void-app.pb.js`, "utf8")), readFileSync(`${WORK}/.voidbase/pb_hooks/void-app.pb.js`, "utf8").slice(-200));
  check("the hook that registers it uses only hook globals", /require\(`\$\{__hooks\}\/void-app\.js`\)/.test(readFileSync(`${WORK}/.voidbase/pb_hooks/void-app.pb.js`, "utf8")), readFileSync(`${WORK}/.voidbase/pb_hooks/void-app.pb.js`, "utf8").slice(-200));
  check("each cron's schedule is written into that hook as a literal, so the deploy makes it a cron trigger of the Worker", /cronAdd\("tick", "\*\/5 \* \* \* \*"\)/.test(readFileSync(`${WORK}/.voidbase/pb_hooks/void-app.pb.js`, "utf8")) && cronTriggers(`${WORK}/.voidbase/pb_hooks`).includes("*/5 * * * *"), `${readFileSync(`${WORK}/.voidbase/pb_hooks/void-app.pb.js`, "utf8").slice(-300)} | triggers ${cronTriggers(`${WORK}/.voidbase/pb_hooks`).join(", ")}`);
  const mainTs = readFileSync(`${WORK}/.voidbase/main.ts`, "utf8");
  check("the generated app is PocketBase-shaped: main.ts, package.json, .gitignore, pb_hooks, pb_migrations, pb_public", ["main.ts", "package.json", ".gitignore", "pb_hooks", "pb_migrations", "pb_public"].every((f) => existsSync(`${WORK}/.voidbase/${f}`)), readdirSync(`${WORK}/.voidbase`).join(" "));
  check("its main.ts is only the runner: every line of the app's server code is in pb_hooks", !/registerVoidApp/.test(mainTs) && !/\bfrom "\.\.\//.test(mainTs), mainTs.slice(0, 400));
  check("nothing is generated into the project root: it stays a plain Void app", !existsSync(`${WORK}/main.ts`) && !existsSync(`${WORK}/pb_hooks`) && !existsSync(`${WORK}/pb_public`) && !existsSync(`${WORK}/pb_migrations`), readdirSync(WORK).join(" "));
  check("vb_secrets/ becomes pb_secrets/: the declaration re-exported where voidbase deploy looks, the values beside it, git-ignored", /export \{ default \} from "\.\.\/\.\.\/vb_secrets\/main";/.test(readFileSync(`${WORK}/.voidbase/pb_secrets/main.ts`, "utf8")) && existsSync(`${WORK}/.voidbase/pb_secrets/secrets.json`) && /^pb_secrets\/secrets\.json$/m.test(readFileSync(`${WORK}/.voidbase/.gitignore`, "utf8")), readdirSync(`${WORK}/.voidbase`).join(" "));
  check("vb_migrations/ is copied in as the generated app's pb_migrations", existsSync(`${WORK}/.voidbase/pb_migrations/1800000001_marker.js`), readdirSync(`${WORK}/.voidbase/pb_migrations`).join(" "));
  check("pb_plugins/ and voidbase.lock are carried into the generated app as they are", existsSync(`${WORK}/.voidbase/pb_plugins/carried/bundle.js`) && readFileSync(`${WORK}/.voidbase/voidbase.lock`, "utf8") === readFileSync(`${WORK}/voidbase.lock`, "utf8"), readdirSync(`${WORK}/.voidbase`).join(" "));
  const wf = existsSync(`${WORK}/.voidbase/workflows/nightly-report.js`) ? readFileSync(`${WORK}/.voidbase/workflows/nightly-report.js`, "utf8") : "";
  check("a workflow is bundled as one ES module naming its class, with voidbase's entry points and cloudflare:workers left as imports", wf.startsWith("// voidbase:workflow NightlyReport") && /from\s+"cloudflare:workers"/.test(wf) && /from\s+"@voidbase-cloud\/voidbase\/workflows"/.test(wf) && /export\s*\{[^}]*default/.test(wf) && m.workflows[0]?.className === "NightlyReport", wf.slice(0, 300));
  const migration = readFileSync(`${WORK}/.voidbase/pb_migrations/0001_outbox.void.js`, "utf8");
  check("a Drizzle migration becomes a PocketBase migration, split on its statement markers", /CREATE TABLE/.test(migration) && /CREATE INDEX/.test(migration) && (migration.match(/execSQL/g) ?? []).length === 2, migration.slice(0, 160));
  check("the static build lands in .voidbase/pb_public, with a 404 shell for the asset layer", existsSync(`${WORK}/.voidbase/pb_public/index.html`) && existsSync(`${WORK}/.voidbase/pb_public/robots.txt`) && existsSync(`${WORK}/.voidbase/pb_public/404.html`), readdirSync(`${WORK}/.voidbase/pb_public`).join(" "));
  const redirects = existsSync(`${WORK}/.voidbase/pb_public/_redirects`) ? readFileSync(`${WORK}/.voidbase/pb_public/_redirects`, "utf8") : "";
  check("the seo files the build does not carry are redirected to /api/seo in _redirects; the app's own robots.txt keeps the path", /^\/sitemap\.xml \/api\/seo\/sitemap\.xml 302$/m.test(redirects) && /^\/llms\.txt \/api\/seo\/llms\.txt 302$/m.test(redirects) && !/robots/.test(redirects), redirects);
  check("void/db and void/queues get runtime shims, because Void maps them to declaration files", existsSync(`${WORK}/.voidbase/shim-db.ts`) && existsSync(`${WORK}/.voidbase/shim-queues.ts`) && /shim-queues/.test(readFileSync(`${WORK}/.voidbase/tsconfig.json`, "utf8")), "");

  // ---- pwa: the manifest, the icon set and the service worker, from what the app already declares -----------------
  const pub = `${WORK}/.voidbase/pb_public`;
  const webmanifest = JSON.parse(readFileSync(`${pub}/manifest.webmanifest`, "utf8")) as Record<string, string> & { icons: { src: string; sizes: string; type: string }[] };
  check("manifest.webmanifest takes its name, description and colours from void.json's head, standalone at /", webmanifest.name === "Void on voidbase" && webmanifest.short_name === "Void on voidbase" && webmanifest.description === "A Void app running on voidbase" && webmanifest.theme_color === "#123456" && webmanifest.background_color === "#123456" && webmanifest.start_url === "/" && webmanifest.scope === "/" && webmanifest.display === "standalone", JSON.stringify(webmanifest));
  check("the SVG icon is written as it is with sizes any, and every icon the manifest lists exists", webmanifest.icons.some((i) => i.src === "/icons/icon.svg" && i.sizes === "any" && i.type === "image/svg+xml") && webmanifest.icons.every((i) => existsSync(`${pub}${i.src}`)) && readFileSync(`${pub}/icons/icon.svg`, "utf8") === readFileSync(`${WORK}/public/icon.svg`, "utf8"), JSON.stringify(webmanifest.icons));
  // rasterizing an SVG needs sharp, which is not a dependency; when it is installed (it is a transitive one here) the PNGs are written too
  const hasSharp = await import("sharp").then(() => true, () => false);
  const pngSizes = webmanifest.icons.filter((i) => i.type === "image/png").map((i) => i.sizes).sort();
  const isPng = (f: string) => existsSync(f) && readFileSync(f).subarray(1, 4).toString() === "PNG";
  check(`PNG icons at 192 and 512 are written ${hasSharp ? "from the SVG, since sharp is installed" : "only when sharp is installed, and it is not"}`, hasSharp ? pngSizes.join() === "192x192,512x512" && isPng(`${pub}/icons/icon-192.png`) && isPng(`${pub}/icons/icon-512.png`) : pngSizes.length === 0 && !existsSync(`${pub}/icons/icon-192.png`), pngSizes.join());
  const sw = readFileSync(`${pub}/sw.js`, "utf8");
  const hashed = readdirSync(`${pub}/assets`);
  const version = /const VERSION = "([0-9a-f]{12})"/.exec(sw)?.[1] ?? "";
  check("sw.js precaches the shell under a version hash: / and every hashed asset of the client build", version !== "" && sw.includes('"/",') && hashed.length > 0 && hashed.every((f) => sw.includes(`"/assets/${f}"`)) && !sw.includes('"/404.html"') && !sw.includes('"/robots.txt"'), `${version} ${hashed.join(" ")}`);
  const installHandler = sw.split('addEventListener("install"')[1]?.split("addEventListener(")[0] ?? "";
  check("sw.js speaks the handshake: SKIP_WAITING, UPDATED and UNREGISTER, does not skip waiting on install, and leaves /api/ and /_/ alone", sw.includes('"SKIP_WAITING"') && sw.includes('type: "UPDATED", version: VERSION') && sw.includes('"UNREGISTER"') && !/skipWaiting/.test(installHandler) && sw.includes('"/api/"') && sw.includes('"/_/"') && !/\bimport\b|\brequire\(/.test(sw), "");
  const indexHtml = readFileSync(`${pub}/index.html`, "utf8");
  check("index.html and the 404 shell link the manifest and carry the theme colour, with no registration script", indexHtml.includes('<link rel="manifest" href="/manifest.webmanifest">') && indexHtml.includes('<meta name="theme-color" content="#123456">') && !/sw\.js/.test(indexHtml) && readFileSync(`${pub}/404.html`, "utf8").includes('rel="manifest"'), indexHtml.slice(0, 240));

  // a second pass must not duplicate or drift
  const again = await adapt(WORK, { quiet: true, clientDir: "dist/client", pwa: { icon: "icon.svg" } });
  check("converting again is idempotent", readFileSync(`${WORK}/.voidbase/void-entry.ts`, "utf8") === generated && again.manifest.routes.length === m.routes.length && readFileSync(`${pub}/sw.js`, "utf8") === sw && again.pwa?.version === version && readFileSync(`${pub}/index.html`, "utf8") === indexHtml, `${again.pwa?.version} vs ${version}`);
  // a change to the shell is a new version of the worker: that is what makes browsers pick a new build up
  writeFileSync(`${WORK}/dist/client/index.html`, readFileSync(`${WORK}/dist/client/index.html`, "utf8") + "<!-- changed -->");
  const changed = await adapt(WORK, { quiet: true, clientDir: "dist/client", pwa: { icon: "icon.svg" } });
  check("a change to the shell changes the version in sw.js, and the pass reports what it wrote", changed.pwa?.version !== version && changed.written.some((w) => w.endsWith("pb_public/sw.js")) && changed.written.some((w) => w.endsWith("pb_public/manifest.webmanifest")) && changed.written.some((w) => w.endsWith("pb_public/icons/icon.svg")), `${changed.pwa?.version} ${changed.written.filter((w) => w.includes("pb_public")).join(" ")}`);
  // a precache entry the build does not have would stop the worker from installing, so the build says so
  let missingPrecache = "";
  try { await adapt(WORK, { quiet: true, clientDir: "dist/client", pwa: { icon: "icon.svg", precache: ["/fonts/nope.woff2"] } }); } catch (err) { missingPrecache = err instanceof Error ? err.message : String(err); }
  check("a precache path the build does not have fails the build, by name", /pwa\.precache names "\/fonts\/nope\.woff2"/.test(missingPrecache), missingPrecache.split("\n")[0] ?? "(no error)");
  // and without the option nothing of it appears
  const plain = await adapt(WORK, { quiet: true, clientDir: "dist/client" });
  check("without the pwa option nothing of it is written: no manifest, no icons, no worker, no tag in index.html", !plain.pwa && !existsSync(`${pub}/manifest.webmanifest`) && !existsSync(`${pub}/sw.js`) && !existsSync(`${pub}/icons`) && !readFileSync(`${pub}/index.html`, "utf8").includes("manifest") && !plain.written.some((w) => w.includes("pb_public")), readdirSync(pub).join(" "));
  // ---- locales: a locale in the route, and the hreflang links that say so ----------------------------------------
  check("without the locales option no page is tagged and no rule is written", !readFileSync(`${pub}/index.html`, "utf8").includes("hreflang") && !readFileSync(`${pub}/index.html`, "utf8").includes("<html") && !readFileSync(`${pub}/_redirects`, "utf8").includes("locale"), readFileSync(`${pub}/index.html`, "utf8").slice(0, 120));
  // a second page, to see the page URL a prerendered file is served at and a language the page already declares
  writeFileSync(`${WORK}/dist/client/guide.html`, '<!doctype html><html lang="en-GB"><head><title>guide</title></head><body>guide</body></html>');
  const prefixed = await adapt(WORK, { quiet: true, clientDir: "dist/client", locales: { codes: ["en", "ar", "fr"], path: "prefix", default: "en" } });
  const localeRedirects = readFileSync(`${pub}/_redirects`, "utf8");
  check("prefix writes a _redirects rule per locale, to the same page in that locale, beside the seo rules", /^\/ar \/\?locale=ar 302$/m.test(localeRedirects) && /^\/ar\/\* \/:splat\?locale=ar 302$/m.test(localeRedirects) && /^\/fr\/\* \/:splat\?locale=fr 302$/m.test(localeRedirects) && /^\/en\/\* \/:splat 302$/m.test(localeRedirects) && /^\/sitemap\.xml \/api\/seo\/sitemap\.xml 302$/m.test(localeRedirects) && prefixed.locales?.rules.length === 6, localeRedirects);
  const tagged = readFileSync(`${pub}/index.html`, "utf8");
  check("every prerendered page gets the hreflang links the seo plugin emits, x-default included, and the lang attribute", tagged.includes('<html lang="en">') && tagged.includes('<link rel="alternate" hreflang="en" href="/">') && tagged.includes('<link rel="alternate" hreflang="ar" href="/ar/">') && tagged.includes('<link rel="alternate" hreflang="fr" href="/fr/">') && tagged.includes('<link rel="alternate" hreflang="x-default" href="/">'), tagged.slice(0, 300));
  const guide = readFileSync(`${pub}/guide.html`, "utf8");
  check("a page is named by the URL it is served at, its own language is kept when it is the same one, and the 404 shell gets no alternates", guide.includes('<link rel="alternate" hreflang="ar" href="/ar/guide">') && guide.includes('<html lang="en-GB">') && guide.includes("</head>") && !readFileSync(`${pub}/404.html`, "utf8").includes("hreflang") && readFileSync(`${pub}/404.html`, "utf8").includes('<html lang="en">'), guide.slice(0, 300));
  const againLocales = await adapt(WORK, { quiet: true, clientDir: "dist/client", locales: { codes: ["en", "ar", "fr"], path: "prefix", default: "en" } });
  check("the locales pass is idempotent: the same rules and the same pages", readFileSync(`${pub}/_redirects`, "utf8") === localeRedirects && readFileSync(`${pub}/index.html`, "utf8") === tagged && againLocales.locales?.pages.length === prefixed.locales?.pages.length, `${againLocales.locales?.rules.length} rules`);
  const queried = await adapt(WORK, { quiet: true, clientDir: "dist/client", locales: { codes: ["en", "ar"], path: "query" } });
  check("query writes no rule at all, because ?locale= already works, and the alternates say so", queried.locales?.rules.length === 0 && !readFileSync(`${pub}/_redirects`, "utf8").includes("locale=ar 302") && readFileSync(`${pub}/index.html`, "utf8").includes('<link rel="alternate" hreflang="ar" href="/?locale=ar">'), readFileSync(`${pub}/_redirects`, "utf8"));
  process.env.VOIDBASE_SITE_URL = "https://example.com";
  const absolute = await adapt(WORK, { quiet: true, clientDir: "dist/client", locales: { codes: ["en", "ar"], path: "prefix" } });
  check("with VOIDBASE_SITE_URL the links are absolute, the way the sitemap's alternates are", readFileSync(`${pub}/index.html`, "utf8").includes('hreflang="ar" href="https://example.com/ar/"') && absolute.locales?.site === "https://example.com", readFileSync(`${pub}/index.html`, "utf8").slice(0, 300));
  delete process.env.VOIDBASE_SITE_URL;
  // the codes and VOIDBASE_LOCALES are one list in two places: hreflang links naming a locale the API cannot
  // answer in are worse than none, so a disagreement stops the build with both lists in front of you
  process.env.VOIDBASE_LOCALES = "en,ar";
  let localeMismatch = "";
  try { await adapt(WORK, { quiet: true, clientDir: "dist/client", locales: { codes: ["en", "ar", "fr"], path: "prefix" } }); } catch (err) { localeMismatch = err instanceof Error ? err.message : String(err); }
  check("codes that disagree with VOIDBASE_LOCALES fail the build, with both lists", /do not agree/.test(localeMismatch) && /locales\.codes\s+en, ar, fr/.test(localeMismatch) && /VOIDBASE_LOCALES\s+en, ar/.test(localeMismatch), localeMismatch.split("\n")[0] ?? "(no error)");
  let sourceMismatch = "";
  try { await adapt(WORK, { quiet: true, clientDir: "dist/client", locales: { codes: ["en", "ar"], default: "ar" } }); } catch (err) { sourceMismatch = err instanceof Error ? err.message : String(err); }
  check("a default that is not VOIDBASE_LOCALES' source locale fails the build too", /do not agree/.test(sourceMismatch) && /source en/.test(sourceMismatch), sourceMismatch.split("\n")[0] ?? "(no error)");
  delete process.env.VOIDBASE_LOCALES;
  rmSync(`${WORK}/dist/client/guide.html`);

  // ---- panel: the admin panel under the app's own path, behind the app's own check -------------------------------
  const bare = await adapt(WORK, { quiet: true, clientDir: "dist/client" });
  check("without the panel option nothing of it is written: no directory, no rule, and the generated main.ts says nothing about it",
    !bare.panel && !existsSync(`${pub}/admin`) && !/\/api\/panel/.test(readFileSync(`${pub}/_redirects`, "utf8")) && !/panel:/.test(readFileSync(`${WORK}/.voidbase/main.ts`, "utf8")), readdirSync(pub).join(" "));

  const moved = await adapt(WORK, { quiet: true, clientDir: "dist/client", panel: { path: "/admin" } });
  const panelIndex = readFileSync(`${pub}/admin/index.html`, "utf8");
  check("the panel's files are written under the path, with the 404 shell the asset layer serves for a deep link",
    moved.panel?.path === "/admin/" && existsSync(`${pub}/admin/index.html`) && existsSync(`${pub}/admin/assets`) && existsSync(`${pub}/admin/extensions.js`) && existsSync(`${pub}/admin/404.html`) && moved.written.some((w) => w.endsWith("pb_public/admin/")),
    `${moved.panel?.path} ${existsSync(`${pub}/admin`) ? readdirSync(`${pub}/admin`).join(" ") : "(none)"}`);
  check("the index needs no rewriting: PocketBase's build references its assets relatively, so it works wherever it sits",
    /src="\.\/assets\//.test(panelIndex) && !panelIndex.includes("/_/") && panelIndex === readFileSync(`${await ensurePanelDir()}/index.html`, "utf8"), panelIndex.slice(0, 160));
  const panelBundles = readdirSync(`${pub}/admin/assets`).filter((f) => f.endsWith(".js")).map((f) => readFileSync(`${pub}/admin/assets/${f}`, "utf8"));
  check("the two URLs the bundle does hardcode are rebased: the API base to /, and the extensions registry to the path",
    (moved.panel?.rebased.length ?? 0) > 0 && !panelBundles.some((b) => /\bnew\s+[A-Za-z_$][\w$]*\s*\(\s*(["'`])\.\.\/\1/.test(b)) && panelBundles.some((b) => b.includes("/admin/extensions.js")) && !panelBundles.some((b) => b.includes("/_/extensions.js")),
    (moved.panel?.rebased ?? []).join(" "));
  check("moving the panel alone writes no rule at all: /_/ is still there and the path is open", moved.panel?.rules.length === 0 && !/\/api\/panel/.test(readFileSync(`${pub}/_redirects`, "utf8")), readFileSync(`${pub}/_redirects`, "utf8"));
  check("the generated main.ts carries the option, so `voidbase serve` puts the panel where the build did", /panel: \{"path":"\/admin","guard":false,"hide":false\}/.test(readFileSync(`${WORK}/.voidbase/main.ts`, "utf8")), readFileSync(`${WORK}/.voidbase/main.ts`, "utf8").slice(-500));

  const guardedPanel = await adapt(WORK, { quiet: true, clientDir: "dist/client", panel: { path: "/admin", guard: "superuser" } });
  const guardedRedirects = readFileSync(`${pub}/_redirects`, "utf8");
  check("guard sends the bare path, the directory and its index to /api/panel, which is the only way the Worker sees them",
    /^\/admin \/api\/panel\?at=\/admin\/ 302$/m.test(guardedRedirects) && /^\/admin\/ \/api\/panel\?at=\/admin\/ 302$/m.test(guardedRedirects) && /^\/admin\/index\.html \/api\/panel\?at=\/admin\/ 302$/m.test(guardedRedirects) && guardedPanel.panel?.rules.length === 3, guardedRedirects);
  check("a guarded panel has no 404.html of its own: that copy would be the index, readable by anyone", !existsSync(`${pub}/admin/404.html`) && existsSync(`${pub}/admin/index.html`), readdirSync(`${pub}/admin`).join(" "));

  const hidden = await adapt(WORK, { quiet: true, clientDir: "dist/client", panel: { path: "/admin", hide: true } });
  const hiddenRedirects = readFileSync(`${pub}/_redirects`, "utf8");
  check("hide takes /_/ away: every URL under it is ruled to /api/panel with no `at`, which answers 404",
    /^\/_ \/api\/panel 302$/m.test(hiddenRedirects) && /^\/_\/ \/api\/panel 302$/m.test(hiddenRedirects) && /^\/_\/\* \/api\/panel 302$/m.test(hiddenRedirects) && hidden.panel?.hidden === true && /^\/sitemap\.xml \/api\/seo\/sitemap\.xml 302$/m.test(hiddenRedirects), hiddenRedirects);
  const againPanel = await adapt(WORK, { quiet: true, clientDir: "dist/client", panel: { path: "/admin", hide: true } });
  check("the panel pass is idempotent: the same rules, in one copy, and the same files", readFileSync(`${pub}/_redirects`, "utf8") === hiddenRedirects && againPanel.panel?.rules.length === 3 && (hiddenRedirects.match(/\/api\/panel/g) ?? []).length === 3 && readFileSync(`${pub}/admin/index.html`, "utf8") === panelIndex, `${againPanel.panel?.rules.length} rules`);

  let panelBadPath = "";
  try { await adapt(WORK, { quiet: true, clientDir: "dist/client", panel: { path: "/api/panel" } }); } catch (err) { panelBadPath = err instanceof Error ? err.message : String(err); }
  check("a path under /api fails the build: that prefix is the Worker's own", /under \/api/.test(panelBadPath), panelBadPath.split("\n")[0] ?? "(no error)");
  let panelBadHide = "";
  try { await adapt(WORK, { quiet: true, clientDir: "dist/client", panel: { hide: true } }); } catch (err) { panelBadHide = err instanceof Error ? err.message : String(err); }
  check("hide without a path of its own fails the build, because it would take the only panel away", /give the panel a path of its own/.test(panelBadHide), panelBadHide.split("\n")[0] ?? "(no error)");

  // the app below runs with it, so the worker, the manifest and the moved panel are served like any other file
  await adapt(WORK, { quiet: true, clientDir: "dist/client", pwa: { icon: "icon.svg", precache: ["/robots.txt"] }, panel: { path: "/admin" } });

  // ---- a static app: nothing to run, so nothing is generated to run it ------------------------------------------
  const staticApp = resolve(PKG, "test/.tmp/static-app");
  mkdirSync(`${staticApp}/public`, { recursive: true });
  writeFileSync(`${staticApp}/public/index.html`, "<h1>ssg</h1>");
  const s1 = await adapt(staticApp, { quiet: true });
  check("an app with no server code is static: a generated app with pb_public and no glue", s1.manifest.mode === "static" && existsSync(`${staticApp}/.voidbase/pb_public/index.html`) && existsSync(`${staticApp}/.voidbase/main.ts`) && !existsSync(`${staticApp}/.voidbase/void-app.ts`) && !existsSync(`${staticApp}/main.ts`), JSON.stringify({ mode: s1.manifest.mode, copied: s1.copied }));

  // ---- the app, running ------------------------------------------------------------------------------------------
  const port = (() => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port; s.stop(true); return p; })();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, VOIDBASE_SUPERUSER_EMAIL: "root@example.com", VOIDBASE_SUPERUSER_PASSWORD: "root-password-1", VOIDBASE_USER_EMAIL: "", VOIDBASE_USER_PASSWORD: "", VOIDBASE_LOG_MIN_LEVEL: "8", VOIDBASE_HOOKS_DIR: `${WORK}/.voidbase/pb_hooks`, VOIDBASE_MIGRATIONS_DIR: `${WORK}/.voidbase/pb_migrations` };
  // one session across the pages and the API: the cookie knob, with the origin rule beside it, since the knob is
  // refused without one of the two CSRF protections (checked at the end of this file, on an instance without one)
  const cookieEnv = { ...env, VOIDBASE_AUTH_COOKIE: "1", VOIDBASE_CORS_ORIGINS: base, VOIDBASE_CSRF: "" };
  procs.push(Bun.spawn(["bun", "main.ts", "--http", `127.0.0.1:${port}`, "--dir", `${WORK}/.voidbase/pb_data`], { cwd: `${WORK}/.voidbase`, env: cookieEnv as Record<string, string>, stdout: "inherit", stderr: "inherit" }));
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
  const pbApi = await get("/api/collections-count");
  check("a Void route reaches PocketBase's own API through the adapter's pb", pbApi.status === 200 && pbApi.json.collection === "_superusers" && Number(pbApi.json.superusers) >= 1 && pbApi.json.error === "BadRequestError", JSON.stringify(pbApi.json));
  const guarded = await get("/api/collections-count", { method: "POST" });
  check("requireAuth() refuses an unauthenticated request the way $apis.requireAuth does", guarded.status === 401, `${guarded.status} ${JSON.stringify(guarded.json).slice(0, 80)}`);
  const order = await get("/api/order");
  check("middleware runs in file order before the handler", JSON.stringify(order.json.middleware) === JSON.stringify(["01", "02"]), JSON.stringify(order.json));
  const fromPlugin = await fetch(`${base}/api/carried`);
  check("the carried plugin is loaded by the generated app, verified against the lockfile, and its route answers", fromPlugin.status === 200 && (await fromPlugin.text()) === "carried", String(fromPlugin.status));
  const missing = await get("/api/nope");
  check("an unknown /api path is still a 404", missing.status === 404, String(missing.status));
  const health = await fetch(`${base}/api/health`);
  check("Void middleware wraps every request, PocketBase's own endpoints included", health.headers.get("x-void-middleware") === "all", `${health.status} ${health.headers.get("x-void-middleware")}`);

  const enqueued = await get("/api/enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "queue@example.com" }) });
  const outbox1 = await get("/api/outbox");
  check("void/queues sends to the app queue and the consumer runs it (inline without a queue binding)", enqueued.json.queued === "queue@example.com" && (outbox1.json.outbox as string[])?.includes("queue@example.com"), JSON.stringify([enqueued.json, outbox1.json]));

  const su = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "root@example.com", password: "root-password-1" }) }).then((r) => r.json() as Promise<{ token: string }>);
  const owned = await fetch(`${base}/api/collections/carried_notes`, { headers: { authorization: su.token } });
  check("the collection the carried plugin owns was created by the plugin at bootstrap, table and all", owned.status === 200 && ((await owned.json()) as { name: string }).name === "carried_notes", String(owned.status));
  const crons = await fetch(`${base}/api/crons`, { headers: { authorization: su.token } }).then((r) => r.json() as Promise<{ id: string; expression: string }[]>);
  check("the cron is registered with the schedule its module exports", crons.some((j) => j.id === "tick" && j.expression === "*/5 * * * *"), JSON.stringify(crons.slice(0, 3)));
  await fetch(`${base}/api/crons/tick`, { method: "POST", headers: { authorization: su.token } });
  const outbox2 = await get("/api/outbox");
  check("running the cron reaches the app's scheduled handler with the bindings", (outbox2.json.outbox as string[])?.includes("cron@example.com"), JSON.stringify(outbox2.json));

  const boot1 = await get("/api/from-bootstrap");
  const boot2 = await get("/api/from-bootstrap");
  check("a tsconfig alias whose target is a directory resolves to its index file", boot1.status === 200, `${boot1.status}`);
  check("an onBootstrap hook ran once when the app mounted, not once per request", boot1.json.boots === 1 && boot2.json.boots === 1 && boot1.json.requests === 1 && boot2.json.requests === 2, JSON.stringify([boot1.json, boot2.json]));
  await fetch(`${base}/api/collections/_superusers/records`, { headers: { authorization: su.token } });
  const boot3 = await get("/api/from-bootstrap");
  check("an event hook is registered on its own hook, limited to the collections it tags", boot1.json.lists === 0 && boot3.json.lists === 1, JSON.stringify([boot1.json, boot3.json]));
  const secret = await get("/api/secret");
  check("a declared secret's local value reaches the app through $os.getenv; an unvalued one is empty; a default is filled in and typed", secret.json.fromOs === "s3cret-from-file" && secret.json.missing === "" && secret.json.max === 3 && secret.json.label === "fixture" && JSON.stringify(secret.json.unresolved) === '["OTHER_SECRET"]', JSON.stringify(secret.json));
  const marker = await get("/api/marker");
  check("the project's own pb_migration ran alongside the generated ones", marker.json.marker === 0, JSON.stringify(marker));
  const root = await get("/");
  check("pb_public is served at / by the same process", root.status === 200 && root.text.includes("<h1>static</h1>"), `${root.status} ${root.text.slice(0, 60)}`);
  // Void's SSG writes /faq as faq.html; Cloudflare's asset layer resolves that shape and so must the Bun runtime
  writeFileSync(`${WORK}/.voidbase/pb_public/faq.html`, "<h1>faq</h1>");
  const extensionless = await get("/faq");
  check("an extensionless path resolves against <path>.html, like Cloudflare's asset layer", extensionless.status === 200 && extensionless.text.includes("<h1>faq</h1>"), `${extensionless.status} ${extensionless.text.slice(0, 40)}`);
  const robots = await get("/robots.txt");
  check("files from public/ ride along", robots.status === 200 && robots.text.includes("User-agent"), String(robots.status));
  const swServed = await get("/sw.js");
  const manifestServed = await get("/manifest.webmanifest");
  check("sw.js and manifest.webmanifest are served from pb_public, the worker with the precache list the option asked for", swServed.status === 200 && /javascript/.test(swServed.type) && swServed.text.includes('"/robots.txt"') && manifestServed.status === 200 && manifestServed.json.name === "Void on voidbase", `${swServed.status} ${swServed.type} ${manifestServed.status} ${manifestServed.type}`);
  const panelServed = await get("/admin/");
  const panelChunk = await get(`/admin/assets/${readdirSync(`${WORK}/.voidbase/pb_public/admin/assets`).filter((f) => f.endsWith(".js"))[0]}`);
  const panelHome = await get("/_/");
  check("the moved panel is served by the same process at its path, chunks included, and /_/ still answers (hide is off)", panelServed.status === 200 && panelServed.text.includes("<title>PocketBase</title>") && panelChunk.status === 200 && panelHome.status === 200, `${panelServed.status} ${panelChunk.status} ${panelHome.status}`);
  const collections = await get("/api/collections?perPage=1");
  check("PocketBase's own API is untouched by the app's routes", collections.status === 401 || collections.status === 200, String(collections.status));

  // ---- one session across the pages and the API ------------------------------------------------------------------
  // VOIDBASE_AUTH_COOKIE=1 makes every route that mints a token set it as a cookie too, and makes the server take
  // that cookie as the token when there is no Authorization header. The header still wins; sign-out takes it away;
  // and the CSRF rule the cookie makes necessary is on, because the knob is refused without one.
  const signIn = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ identity: "root@example.com", password: "root-password-1" }) });
  const session = (await signIn.json()) as { token: string; record: { id: string; email: string } };
  const setCookie = signIn.headers.get("set-cookie") ?? "";
  check("signing in sets the token as a cookie: vb_auth on http, Path=/, HttpOnly, SameSite=Lax, and a Max-Age that is the token's own",
    setCookie.startsWith(`vb_auth=${session.token};`) && /;\s*Path=\/(;|$)/.test(setCookie) && /;\s*HttpOnly(;|$)/.test(setCookie) && /;\s*SameSite=Lax(;|$)/.test(setCookie) && Number(/Max-Age=(\d+)/.exec(setCookie)?.[1] ?? 0) > 0 && !/Secure/.test(setCookie) && !setCookie.includes("__Host-"), setCookie);
  const cookie = `vb_auth=${session.token}`;
  const byCookie = await fetch(`${base}/api/collections/_superusers/records?perPage=1`, { headers: { cookie } });
  check("a later request with only the cookie is authenticated by the API", byCookie.status === 200, `${byCookie.status} ${(await byCookie.text()).slice(0, 90)}`);
  const loaded = await get("/api/account", { headers: { cookie } });
  check("a page loader calling sessionOf() sees the same signed-in user, through the generated app's own verification",
    loaded.json.id === session.record.id && loaded.json.email === "root@example.com" && loaded.json.collection === "_superusers" && loaded.json.api === session.record.id, JSON.stringify(loaded.json));
  const anonymous = await get("/api/account");
  check("with no cookie the loader renders for nobody, rather than failing", anonymous.status === 200 && anonymous.json.id === null && anonymous.json.email === null && anonymous.json.api === null, JSON.stringify(anonymous.json));
  // the header decides who the request is, whichever of the two is the good one: a bad header beside a good cookie
  // is nobody, and a good header beside a bad cookie is the record the header names
  const headerOverCookie = await get("/api/account", { headers: { cookie, authorization: "not-a-token" } });
  const cookieUnderHeader = await get("/api/account", { headers: { cookie: "vb_auth=not-a-token", authorization: session.token } });
  check("the Authorization header still wins when both are there, whichever of the two is the good one",
    headerOverCookie.json.api === null && headerOverCookie.json.id === session.record.id && cookieUnderHeader.json.api === session.record.id && cookieUnderHeader.json.id === null,
    JSON.stringify([headerOverCookie.json, cookieUnderHeader.json]));
  const crossSite = await fetch(`${base}/api/collections/_superusers/auth-clear`, { method: "POST", headers: { cookie, origin: "https://evil.example" } });
  check("the hole a cookie opens is closed: a state-changing cookie request from another origin is refused, naming the knob that decides",
    crossSite.status === 403 && /VOIDBASE_CORS_ORIGINS/.test(String(((await crossSite.json()) as { message: string }).message)), String(crossSite.status));
  const signOut = await fetch(`${base}/api/collections/_superusers/auth-clear`, { method: "POST", headers: { cookie, origin: base } });
  const cleared = signOut.headers.get("set-cookie") ?? "";
  check("sign-out answers 204 and takes the cookie away: the same cookie, empty and already expired", signOut.status === 204 && cleared.startsWith("vb_auth=;") && /;\s*Max-Age=0(;|$)/.test(cleared) && /;\s*HttpOnly(;|$)/.test(cleared), `${signOut.status} ${cleared}`);

  // the knob on its own, with neither CSRF protection: the same generated app, the same data, one env apart. The
  // first instance is stopped before this one starts, so only one process is ever holding the database.
  procs[0]!.kill(); await procs[0]!.exited; procs.length = 0;
  const port2 = (() => { const sv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = sv.port; sv.stop(true); return p; })();
  const refusedProc = Bun.spawn(["bun", "main.ts", "--http", `127.0.0.1:${port2}`, "--dir", `${WORK}/.voidbase/pb_data`], { cwd: `${WORK}/.voidbase`, env: { ...env, VOIDBASE_AUTH_COOKIE: "1", VOIDBASE_CORS_ORIGINS: "", VOIDBASE_CSRF: "" } as Record<string, string>, stdout: "ignore", stderr: "pipe" });
  procs.push(refusedProc);
  const base2 = `http://127.0.0.1:${port2}`;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base2}/api/health`)).ok) break; } catch { /* booting */ } await Bun.sleep(200); }
  const refusedSignIn = await fetch(`${base2}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "root@example.com", password: "root-password-1" }) });
  const refusedSession = (await refusedSignIn.json()) as { token: string };
  const refusedByCookie = await fetch(`${base2}/api/account`, { headers: { cookie: `vb_auth=${refusedSession.token}` } }).then((r) => r.json() as Promise<Record<string, unknown>>);
  check("without either CSRF protection the knob does not take effect: no cookie is set, and none is a session for the API or for a loader",
    refusedSignIn.status === 200 && !refusedSignIn.headers.get("set-cookie") && refusedByCookie.api === null && refusedByCookie.id === null, `${refusedSignIn.status} ${refusedSignIn.headers.get("set-cookie")} ${JSON.stringify(refusedByCookie)}`);
  refusedProc.kill(); await refusedProc.exited;
  const said = await new Response(refusedProc.stderr as ReadableStream).text().catch(() => "");
  check("and it says so, naming both ways to fix it", /VOIDBASE_AUTH_COOKIE was refused/.test(said) && /VOIDBASE_CORS_ORIGINS/.test(said) && /VOIDBASE_CSRF=double-submit/.test(said), said.split("\n").filter((l) => l.includes("refused")).join(" ").slice(0, 200) || said.slice(-200));
} finally {
  for (const p of procs) p.kill();
  rmSync(resolve(PKG, "test/.tmp"), { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
