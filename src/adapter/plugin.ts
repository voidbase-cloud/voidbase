// The Vite plugin a Void app adds next to voidPlugin(): it makes `vite build` produce a voidbase app.
//
//   import { voidPlugin } from "void";
//   import { voidbaseAdapter } from "@voidbase-cloud/voidbase/adapter/plugin";
//   export default defineConfig({ plugins: [voidPlugin(), voidbaseAdapter()] });
//
// The whole voidbase app is generated under `.voidbase/`, in PocketBase's layout: the client build lands in
// `.voidbase/pb_public` (served at `/`), and the server code (routes/, middleware/, vb_hooks/, crons/, queues/)
// is bundled into `.voidbase/pb_hooks/`. The whole `.voidbase/` directory is build output: delete it and the next
// build makes it again.
// The project root stays a plain Void app. Void's own dist/ssr worker is left alone: voidbase composes the
// generated main.ts into its own Worker on deploy, so the app's server code is bundled there instead.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleHookApp } from "./bundle";
import { generateHookWrapper, hasServerCode, writeVoidbaseApp, type GenerateOptions } from "./codegen";
import { scanVoidApp, SECRETS_DIR, type VoidManifest } from "./scan";
import { loadDefinition, readSecretsValues } from "../node/secrets";

export interface AdapterOptions extends GenerateOptions {
  /** where the built site goes inside the generated app; voidbase serves it at `/` */
  publicDir?: string;
  /** the client build to copy from; defaults to <outDir>/client, then dist/client */
  clientDir?: string;
  /** turn db/migrations/*.sql into pb_migrations/*.void.js (default true) */
  migrations?: boolean;
  /** log what was produced (default true) */
  quiet?: boolean;
}

export interface AdaptResult { manifest: VoidManifest; written: string[]; copied: number; bundleBytes: number }

/** Runs the whole conversion once. Exported so `voidbase adapt` and the tests do not need Vite. */
export async function adapt(root: string, opts: AdapterOptions & { clientDir?: string } = {}): Promise<AdaptResult> {
  const manifest = scanVoidApp({ root, dev: false });
  const { written } = writeVoidbaseApp(manifest, { pkg: opts.pkg, migrations: opts.migrations });

  // routes/, middleware/, vb_hooks/, crons/ and queues/ become one bundled hook: a hook cannot import from npm, and Void's
  // handlers do (see src/adapter/bundle.ts)
  let bundleBytes = 0;
  if (hasServerCode(manifest)) {
    const hooks = join(root, ".voidbase", "pb_hooks");
    mkdirSync(hooks, { recursive: true });
    const { code, bytes } = await bundleHookApp(join(root, ".voidbase", "void-entry.ts"), root);
    writeFileSync(join(hooks, "void-app.js"), code);
    writeFileSync(join(hooks, "void-app.pb.js"), generateHookWrapper(manifest.crons));
    written.push(".voidbase/pb_hooks/void-app.js", ".voidbase/pb_hooks/void-app.pb.js");
    bundleBytes = bytes;
  }

  const publicDir = resolve(root, opts.publicDir ?? ".voidbase/pb_public");
  const client = opts.clientDir ? resolve(root, opts.clientDir) : firstExisting([join(root, "dist", "client"), join(root, "public")]);
  const copied = client ? syncPublic(client, publicDir) : 0;
  return { manifest, written, copied, bundleBytes };
}

const firstExisting = (paths: string[]) => paths.find((p) => existsSync(p) && statSync(p).isDirectory());

/** Replaces pb_public with the build, keeping `_` (the admin panel) and dotfiles, and giving the asset layer a 404. */
function syncPublic(from: string, to: string): number {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(to)) {
    if (entry === "_" || entry.startsWith(".")) continue;
    rmSync(join(to, entry), { recursive: true, force: true });
  }
  let copied = 0;
  for (const entry of readdirSync(from)) {
    if (entry === "_") continue; // that path belongs to the admin panel
    cpSync(join(from, entry), join(to, entry), { recursive: true });
    copied++;
  }
  // Cloudflare answers an unmatched path with 404.html (void.json routing.notFound "404-page"); on Bun voidbase
  // falls back to index.html. Copying one to the other keeps a deep link behaving the same on both.
  const index = join(to, "index.html");
  if (existsSync(index) && !existsSync(join(to, "404.html"))) cpSync(index, join(to, "404.html"));
  return copied;
}

export function voidbaseAdapter(options: AdapterOptions = {}) {
  let root = process.cwd();
  let clientOut: string | undefined;
  let hasClient = false;
  const log = (msg: string) => { if (!options.quiet) console.log(`voidbase: ${msg}`); };
  // Rolldown prints only a plugin error's first line, and the adapter's build errors say what to change on the
  // lines after it. Print the whole thing before it is rethrown.
  const report = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try { return await work(); } catch (err) { if (err instanceof Error && err.message.includes("\n")) console.error(err.message); throw err; }
  };

  return {
    name: "voidbase-adapter",
    // after voidPlugin, so the manifest sees whatever it generated into .void/
    enforce: "post" as const,
    // the browser's share of the configuration: every `public` key of vb_secrets/main.ts, parsed from the local
    // values and the shell, inlined as import.meta.env.KEY. Secrets and server keys never enter the client build.
    async config(cfg: { root?: string }) {
      const projectRoot = cfg.root ? resolve(cfg.root) : root;
      // a fresh checkout has no .voidbase/ yet, and the project's tsconfig extends the fragment written there, which
      // Vite reads before any build hook runs: generate the app now (buildStart does it again, idempotently)
      const manifest = await report(() => scanVoidApp({ root: projectRoot, dev: process.env.NODE_ENV !== "production" }));
      writeVoidbaseApp(manifest, { pkg: options.pkg, migrations: options.migrations });
      const loaded = await report(() => loadDefinition(join(projectRoot, SECRETS_DIR)));
      if (!loaded) return undefined;
      const raw: Record<string, unknown> = { ...(readSecretsValues(join(projectRoot, SECRETS_DIR)) ?? {}) };
      for (const k of loaded.definition.of("public")) if (process.env[k]) raw[k] = process.env[k];
      const ev = await loaded.definition.evaluate(raw, ["public"]);
      if (ev.invalid.length) throw new Error(`voidbase: ${SECRETS_DIR}: ${ev.invalid.map((i) => `${i.name}: ${i.message}`).join(", ")}`);
      const define: Record<string, string> = {};
      for (const [k, v] of Object.entries(ev.stored)) define[`import.meta.env.${k}`] = JSON.stringify(v);
      return { define };
    },
    configResolved(config: { root: string; build?: { outDir?: string }; environments?: Record<string, { build?: { outDir?: string } }> }) {
      root = config.root ?? root;
      const fromEnv = config.environments?.client?.build?.outDir;
      hasClient = !!config.environments?.client;
      clientOut = fromEnv ?? config.build?.outDir;
    },
    async buildStart() {
      // keep the glue in step with the files while developing, so `voidbase serve --entry main.ts` sees new routes
      const manifest = await report(() => scanVoidApp({ root, dev: process.env.NODE_ENV !== "production" }));
      writeVoidbaseApp(manifest, { pkg: options.pkg, migrations: options.migrations });
    },
    // fires once per built environment; the work is idempotent and the client builds last, so report only then
    async closeBundle(this: { environment?: { name?: string } }) {
      const clientDir = options.clientDir ?? (clientOut && existsSync(resolve(root, clientOut)) ? clientOut : undefined);
      const { manifest, copied, bundleBytes } = await report(() => adapt(root, { ...options, clientDir }));
      const counts = `${manifest.routes.length} route(s), ${manifest.middleware.length} middleware, ${manifest.hooks.length} hook(s), ${manifest.crons.length} cron(s), ${manifest.queues.length} queue(s), ${manifest.migrations.length} migration(s)${manifest.secrets ? `, ${manifest.secrets.names.length} secret(s)` : ""}${bundleBytes ? ` -> pb_hooks/void-app.js (${Math.round(bundleBytes / 1024)} kB)` : ""}`;
      if (!hasClient || this.environment?.name === "client") {
          log(`${manifest.mode === "static" ? "static site" : counts}; ${copied} entr(ies) into ${options.publicDir ?? ".voidbase/pb_public"}`);
        for (const u of manifest.unsupported) console.warn(`voidbase: ${u.what} is not carried over — ${u.why}`);
        for (const c of manifest.collisions) console.warn(`voidbase: ${c} is served by voidbase itself, so the app route never runs — move it off that path`);
      }
      writeFileSync(join(root, ".voidbase", "manifest.json"), JSON.stringify({ ...manifest, root: undefined }, null, 2) + "\n");
    },
  };
}
