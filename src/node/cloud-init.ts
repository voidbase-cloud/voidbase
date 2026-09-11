// `voidbase cloud init`: the Void project that deploys ../pb_hooks and ../pb_migrations to Cloudflare Workers.
// Generated, not maintained: consumers regenerate it after upgrading voidbase (it is git-ignored in the starter).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cronTriggers } from "../../hooks-plugin";
const ROOT = resolve(import.meta.dir, "../..");

// mode "package": a visible project importing the voidbase package (voidbase cloud init).
// mode "internal": a project inside this package at .cloud/<slug>, importing ../../src etc. (voidbase deploy).
export interface RedirectEntry { source: string; host?: string; path: string; to: string; status: number; line: number }
// Netlify/Pages-style `_redirects`: `source destination [status]`, `#` comments. A source may carry a host
// (`https://api.example.com/`), which scopes the rule to that hostname. 3xx rules only (default 302).
export function parseRedirects(text: string): RedirectEntry[] {
  const out: RedirectEntry[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim(); if (!line) return;
    const [source, to, statusRaw] = line.split(/\s+/); if (!source || !to) return;
    const status = Number((statusRaw ?? "302").replace(/!$/, "")); if (![301, 302, 303, 307, 308].includes(status)) return;
    const m = source.match(/^https?:\/\/([^/]+)(\/.*)?$/);
    out.push({ source, host: m ? m[1]!.toLowerCase() : undefined, path: m ? m[2] || "/" : source, to, status, line: i + 1 });
  });
  return out;
}
export function writeCloudProject(out: string, mode: "package" | "internal" = "package", extra: { hooksDir?: string; migrationsDir?: string; pluginsDir?: string; entry?: string; queue?: string | false; hub?: boolean; database?: "d1" | "durable"; workflows?: { file: string; className: string }[] } = {}): { files: number; out: string } {
  const parentPkg = existsSync("package.json") ? (JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string> }) : {};
  const spec = parentPkg.dependencies?.["@voidbase-cloud/voidbase"] ?? parentPkg.dependencies?.voidbase ?? "^0.1.0";
  const own = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { devDependencies: Record<string, string> };
  const rel = (p: string) => p.replace(/\\/g, "/");
  // import targets: the voidbase package by name (visible project) or this package by relative path (internal
  // project at <package>/.cloud/<slug>; depth = how many directories the importing file sits below the project root)
  const pkg = (depth: number, target: string, byName: string) => (mode === "package" ? byName : "../".repeat(depth + 2) + target);
  const P = {
    plugin: pkg(0, "hooks-plugin", "@voidbase-cloud/voidbase/plugin"), env: pkg(0, "env.ts", "@voidbase-cloud/voidbase/env"), // Void loads env.ts Node-style: the internal path needs its extension
    app: pkg(2, "src/server/app", "@voidbase-cloud/voidbase/app"), cronsApp: pkg(1, "src/server/app", "@voidbase-cloud/voidbase/app"), crons: pkg(1, "src/server/crons", "@voidbase-cloud/voidbase/crons"),
    schema: mode === "package" ? "@voidbase-cloud/voidbase/schema" : `${rel(ROOT)}/db/schema.ts`, // absolute: Void's drift check copies the project into .void/deploy-drift-check/<tmp>/ before drizzle-kit loads db/schema.ts
    api: pkg(2, "src/server/api", "@voidbase-cloud/voidbase/api"),
    jobs: pkg(1, "src/server/jobs", "@voidbase-cloud/voidbase/jobs"),
    hub: pkg(0, "src/server/hub", "@voidbase-cloud/voidbase/hub"),
    database: pkg(0, "src/server/durable-db", "@voidbase-cloud/voidbase/durable-db"),
  };
  // VOIDBASE_DATABASE=durable: the data lives in the database Durable Object, so the project carries its class instead
  // of a D1 schema, and Void is told not to infer a D1 binding (src/server/durable-db.ts, docs/platform.md)
  const durable = extra.database === "durable";
  // the project's main.ts (its register(app) function) is composed into the Worker exactly as in `bun main.ts`
  const entry = extra.entry ? `\nimport { appApi } from "${P.api}";\nimport { register } from ${JSON.stringify(extra.entry)};\nregister(appApi());\n` : "";
  const hooksDir = JSON.stringify(extra.hooksDir ?? "../pb_hooks"); const migrationsDir = JSON.stringify(extra.migrationsDir ?? "../pb_migrations");
  const pluginsDir = JSON.stringify(extra.pluginsDir ?? "../pb_plugins");
  // the hooks' cronAdd expressions become the Worker's triggers (plus an hourly maintenance tick)
  const triggers = cronTriggers(resolve(out, extra.hooksDir ?? "../pb_hooks"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "cloud", private: true, type: "module", scripts: { dev: "vp dev --port 8090 --host 0.0.0.0", build: "vp build", preview: "vp preview --port 8090", "panel:sync": "voidbase panel sync --dest public/_", deploy: "void deploy" }, dependencies: { "@voidbase-cloud/voidbase": spec }, devDependencies: { "@cloudflare/workers-types": own.devDependencies["@cloudflare/workers-types"], typescript: "^5.9.3", vite: own.devDependencies.vite, "vite-plus": own.devDependencies["vite-plus"], void: own.devDependencies.void } }, null, 2) + "\n",
    "vite.config.ts": `import { defineConfig, loadEnv } from "vite";\nimport { voidPlugin } from "void";\nimport { pbHooksPlugin } from "${P.plugin}";\n\n// the project's pb_hooks/ and pb_migrations/ (one directory up) are bundled into the Worker\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), "");\n  return { plugins: [voidPlugin({ persistTo: env.VOIDBASE_PERSIST_TO || undefined }), pbHooksPlugin({ dir: env.VOIDBASE_HOOKS_DIR || ${hooksDir}, migrationsDir: env.VOIDBASE_MIGRATIONS_DIR || ${migrationsDir}, pluginsDir: env.VOIDBASE_PLUGINS_DIR || ${pluginsDir}${extra.hub !== false ? `, hubEntry: ${JSON.stringify(P.hub)}` : ""}${durable ? `, databaseEntry: ${JSON.stringify(P.database)}` : ""}${extra.workflows?.length ? `, workflows: ${JSON.stringify(extra.workflows)}` : ""} })] };\n});\n`,
    "void.json": JSON.stringify({ $schema: "./node_modules/void/schema.json", worker: { compatibility_date: "2026-09-05", compatibility_flags: ["nodejs_compat"] }, routing: { notFound: "404-page" }, inference: { bindings: { db: !durable, storage: true } } }, null, 2) + "\n",
    // self-contained: Void loads env.ts with Node, which strips types only outside node_modules, so the schema is
    // copied in rather than imported from the package (the same declarations as the package's own env.ts)
    "env.ts": `// voidbase's env schema, copied from the package's env.ts by voidbase cloud init (Node loads this file as is)\n${readFileSync(`${ROOT}/env.ts`, "utf8")}`,
    "routes/api/[...path].ts": `// Every /api/* request is handled by voidbase's Hono app (PocketBase wire protocol).\nimport { defineHandler } from "void";\nimport { app } from "${P.app}";\n${entry}\nconst handle = defineHandler((c) => app.fetch(c.req.raw, c.env, (c as unknown as { executionCtx?: ExecutionContext }).executionCtx));\nexport const GET = handle; export const POST = handle; export const PATCH = handle; export const PUT = handle; export const DELETE = handle; export const OPTIONS = handle;\n`,
    "crons/every-minute.ts": `// Cloudflare cron triggers: the hooks' cronAdd expressions and an hourly tick for PocketBase's maintenance.\nimport { defineScheduled } from "void";\nimport "${P.cronsApp}";\nimport { runDue } from "${P.crons}";\n\nexport const cron = ${JSON.stringify(triggers)};\nexport default defineScheduled(async (controller, env) => { await runDue(env as never, new Date(controller.scheduledTime)); });\n`,
    ...(durable ? {} : { "db/schema.ts": `// voidbase's system tables; user collections are data, as in PocketBase.\nexport * from "${P.schema}";\n` }),
    // the jobs queue (mail and automatic backups with retries); absent, every job runs inline
    ...(extra.queue !== false ? { [`queues/${extra.queue || "jobs"}.ts`]: `// Cloudflare Queue consumer for voidbase's background jobs: outbound mail and automatic backups.\n// Its presence gives the Worker the queue producer binding (QUEUE_<NAME>); without this file every job runs\n// inline in the request. Retries: up to maxRetries with backoff, then dropped and alerted (VOIDBASE_ALERT_WEBHOOK_URL).\nimport { defineQueue } from "void";\nimport "${P.cronsApp}";\nimport { consumeJobs, type Job } from "${P.jobs}";\n\nexport const maxBatchSize = 10;\nexport const maxBatchTimeout = 1;\nexport const maxRetries = 5;\nexport const retryDelay = 30;\n\nexport default defineQueue<Job>(async (batch, env) => { await consumeJobs(batch as never, env as never, maxRetries); });\n` } : {}),
    "tsconfig.json": JSON.stringify({ extends: "./.void/tsconfig.json", compilerOptions: { types: ["@cloudflare/workers-types"], strict: true, noEmit: true, moduleResolution: "bundler", module: "esnext", target: "esnext" }, include: ["routes", "crons", "queues", "db", "env.ts", "vite.config.ts"] }, null, 2) + "\n",
    ".gitignore": "node_modules\ndist\n.void\n.wrangler\n.env\n.env.*\n!.env.example\npublic/*\n",
    ".env.example": "# worker vars for local dev/preview of this Void project (production secrets: void secret put / wrangler secret put)\nVOIDBASE_SUPERUSER_EMAIL=admin@example.com\nVOIDBASE_SUPERUSER_PASSWORD=changeme123\nAUDITLOG=posts,users\n",
    "README.md": "# cloud\n\nGenerated by `voidbase cloud init`: the Void project that deploys ../pb_hooks and ../pb_migrations to Cloudflare Workers.\n\n```bash\nbun install\nbun run panel:sync                   # admin panel into public/_ (copy a frontend build into public/ too, if any)\nvoid deploy                          # Void platform\nvoid deploy --backend cloudflare --provision   # your own Cloudflare account\n```\n\nRegenerate with `voidbase cloud init` after upgrading voidbase; keep your own changes elsewhere.\n",
  };
  for (const [name, content] of Object.entries(files)) { mkdirSync(resolve(out, name, ".."), { recursive: true }); writeFileSync(resolve(out, name), content); }
  if (extra.queue === false) rmSync(resolve(out, "queues"), { recursive: true, force: true }); // a regenerated project drops the queue it no longer has
  if (durable) rmSync(resolve(out, "db"), { recursive: true, force: true }); // the object applies the same files itself (src/server/schema-sql.ts)
  else { mkdirSync(resolve(out, "db/migrations"), { recursive: true }); cpSync(`${ROOT}/db/migrations`, resolve(out, "db/migrations"), { recursive: true }); }
  return { files: Object.keys(files).length, out };
}
