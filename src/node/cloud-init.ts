// `voidbase cloud init`: the Void project that deploys ../pb_hooks and ../pb_migrations to Cloudflare Workers.
// Generated, not maintained: consumers regenerate it after upgrading voidbase (it is git-ignored in the starter).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cronTriggers } from "../../hooks-plugin";
const ROOT = resolve(import.meta.dir, "../..");

// mode "package": a visible project importing the voidbase package (voidbase cloud init).
// mode "internal": a project inside this package at .cloud/<slug>, importing ../../src etc. (voidbase deploy).
export function writeCloudProject(out: string, mode: "package" | "internal" = "package", extra: { hooksDir?: string; migrationsDir?: string; entry?: string; queue?: string | false } = {}): { files: number; out: string } {
  const parentPkg = existsSync("package.json") ? (JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string> }) : {};
  const spec = parentPkg.dependencies?.voidbase ?? "^0.1.0";
  const own = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { devDependencies: Record<string, string> };
  const rel = (p: string) => p.replace(/\\/g, "/");
  // import targets: the voidbase package by name (visible project) or this package by relative path (internal
  // project at <package>/.cloud/<slug>; depth = how many directories the importing file sits below the project root)
  const pkg = (depth: number, target: string, byName: string) => (mode === "package" ? byName : "../".repeat(depth + 2) + target);
  const P = {
    plugin: pkg(0, "hooks-plugin", "voidbase/plugin"), env: pkg(0, "env", "voidbase/env"),
    app: pkg(2, "src/server/app", "voidbase/app"), cronsApp: pkg(1, "src/server/app", "voidbase/app"), crons: pkg(1, "src/server/crons", "voidbase/crons"),
    schema: pkg(1, "db/schema", "voidbase/schema"),
    api: pkg(2, "src/server/api", "voidbase/api"),
    jobs: pkg(1, "src/server/jobs", "voidbase/jobs"),
  };
  // the project's main.ts (its register(app) function) is composed into the Worker exactly as in `bun main.ts`
  const entry = extra.entry ? `\nimport { appApi } from "${P.api}";\nimport { register } from ${JSON.stringify(extra.entry)};\nregister(appApi());\n` : "";
  const hooksDir = JSON.stringify(extra.hooksDir ?? "../pb_hooks"); const migrationsDir = JSON.stringify(extra.migrationsDir ?? "../pb_migrations");
  // the hooks' cronAdd expressions become the Worker's triggers (plus an hourly maintenance tick)
  const triggers = cronTriggers(resolve(out, extra.hooksDir ?? "../pb_hooks"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "cloud", private: true, type: "module", scripts: { dev: "vp dev --port 8090 --host 0.0.0.0", build: "vp build", preview: "vp preview --port 8090", "panel:sync": "voidbase panel sync --dest public/_", deploy: "void deploy" }, dependencies: { voidbase: spec }, devDependencies: { "@cloudflare/workers-types": own.devDependencies["@cloudflare/workers-types"], typescript: "^5.9.3", vite: own.devDependencies.vite, "vite-plus": own.devDependencies["vite-plus"], void: own.devDependencies.void } }, null, 2) + "\n",
    "vite.config.ts": `import { defineConfig, loadEnv } from "vite";\nimport { voidPlugin } from "void";\nimport { pbHooksPlugin } from "${P.plugin}";\n\n// the project's pb_hooks/ and pb_migrations/ (one directory up) are bundled into the Worker\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), "");\n  return { plugins: [voidPlugin({ persistTo: env.VOIDBASE_PERSIST_TO || undefined }), pbHooksPlugin({ dir: env.VOIDBASE_HOOKS_DIR || ${hooksDir}, migrationsDir: env.VOIDBASE_MIGRATIONS_DIR || ${migrationsDir} })] };\n});\n`,
    "void.json": JSON.stringify({ $schema: "./node_modules/void/schema.json", worker: { compatibility_date: "2026-09-05", compatibility_flags: ["nodejs_compat"] }, routing: { notFound: "404-page" }, inference: { bindings: { db: true, storage: true } } }, null, 2) + "\n",
    "env.ts": `export { default } from "${P.env}";\n`,
    "routes/api/[...path].ts": `// Every /api/* request is handled by voidbase's Hono app (PocketBase wire protocol).\nimport { defineHandler } from "void";\nimport { app } from "${P.app}";\n${entry}\nconst handle = defineHandler((c) => app.fetch(c.req.raw, c.env, (c as unknown as { executionCtx?: ExecutionContext }).executionCtx));\nexport const GET = handle; export const POST = handle; export const PATCH = handle; export const PUT = handle; export const DELETE = handle; export const OPTIONS = handle;\n`,
    "crons/every-minute.ts": `// Cloudflare cron triggers: the hooks' cronAdd expressions and an hourly tick for PocketBase's maintenance.\nimport { defineScheduled } from "void";\nimport "${P.cronsApp}";\nimport { runDue } from "${P.crons}";\n\nexport const cron = ${JSON.stringify(triggers)};\nexport default defineScheduled(async (controller, env) => { await runDue(env as never, new Date(controller.scheduledTime)); });\n`,
    "db/schema.ts": `// voidbase's system tables; user collections are data, as in PocketBase.\nexport * from "${P.schema}";\n`,
    // the jobs queue (mail and automatic backups with retries); absent, every job runs inline
    ...(extra.queue !== false ? { [`queues/${extra.queue || "jobs"}.ts`]: `// Cloudflare Queue consumer for voidbase's background jobs: outbound mail and automatic backups.\n// Its presence gives the Worker the queue producer binding (QUEUE_<NAME>); without this file every job runs\n// inline in the request. Retries: up to maxRetries with backoff, then dropped and alerted (VOIDBASE_ALERT_WEBHOOK_URL).\nimport { defineQueue } from "void";\nimport "${P.cronsApp}";\nimport { consumeJobs, type Job } from "${P.jobs}";\n\nexport const maxBatchSize = 10;\nexport const maxBatchTimeout = 1;\nexport const maxRetries = 5;\nexport const retryDelay = 30;\n\nexport default defineQueue<Job>(async (batch, env) => { await consumeJobs(batch as never, env as never, maxRetries); });\n` } : {}),
    "tsconfig.json": JSON.stringify({ extends: "./.void/tsconfig.json", compilerOptions: { types: ["@cloudflare/workers-types"], strict: true, noEmit: true, moduleResolution: "bundler", module: "esnext", target: "esnext" }, include: ["routes", "crons", "queues", "db", "env.ts", "vite.config.ts"] }, null, 2) + "\n",
    ".gitignore": "node_modules\ndist\n.void\n.wrangler\n.env\n.env.*\n!.env.example\npublic/*\n",
    ".env.example": "# worker vars for local dev/preview of this Void project (production secrets: void secret put / wrangler secret put)\nVOIDBASE_SUPERUSER_EMAIL=admin@example.com\nVOIDBASE_SUPERUSER_PASSWORD=changeme123\nAUDITLOG=posts,users\n",
    "README.md": "# cloud\n\nGenerated by `voidbase cloud init`: the Void project that deploys ../pb_hooks and ../pb_migrations to Cloudflare Workers.\n\n```bash\nbun install\nbun run panel:sync                   # admin panel into public/_ (copy a frontend build into public/ too, if any)\nvoid deploy                          # Void platform\nvoid deploy --backend cloudflare --provision   # your own Cloudflare account\n```\n\nRegenerate with `voidbase cloud init` after upgrading voidbase; keep your own changes elsewhere.\n",
  };
  for (const [name, content] of Object.entries(files)) { mkdirSync(resolve(out, name, ".."), { recursive: true }); writeFileSync(resolve(out, name), content); }
  if (extra.queue === false) rmSync(resolve(out, "queues"), { recursive: true, force: true }); // a regenerated project drops the queue it no longer has
  mkdirSync(resolve(out, "db/migrations"), { recursive: true });
  cpSync(`${ROOT}/db/migrations`, resolve(out, "db/migrations"), { recursive: true });
  return { files: Object.keys(files).length, out };
}
