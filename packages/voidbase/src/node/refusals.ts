// What an instance refuses a plugin, and how a specifier is read: data and two pure functions, and nothing else.
//
// This is its own module because both halves of an instance read it and only one of them can import the other's
// modules. The Bun loader (src/platform/node/plugins.ts) reads it beside the thunks in ./provided.ts, which import
// the Bun platform's own modules; the Workers build reads it through src/node/installed.ts while it resolves a
// bundle's imports. Holding both in one module put the Bun platform in the Workers build's import graph, which is
// what test/unit/ci-plan.test.ts refuses: the two flavours must not reach each other's suites.

/**
 * The published entries an instance does not hand a bundle, and why not. Two kinds: entries that are not a module a
 * plugin could run, and entries that are the application or the tooling around it — importing one would put the
 * whole app in a plugin's graph, which is the one thing this phase exists to prevent.
 *
 * Both halves of an instance read this: the Bun loader refuses one of these names before it imports a bundle
 * (src/platform/node/plugins.ts), and the Workers build refuses it while it resolves the bundle's imports
 * (`providedImport` below is called from hooks-plugin.ts's `resolveId`), each with the reason written here.
 */
export const NOT_PROVIDED: Record<string, string> = {
  "./package.json": "the manifest, read as data; not a module",
  // these three were one `./scripts/*` pattern until the repository became a workspace; the pattern also reached
  // 25 scripts that are now the root's and are not published, so it named entries that resolve to nothing
  "./scripts/export.ts": "a script the package ships to be run, not a module an instance loads",
  "./scripts/sync-panel.ts": "the same: the panel sync, run from a project or as `voidbase panel sync`",
  "./scripts/sync-app.ts": "the same: the app sync, run from a project or as `voidbase app sync`",
  "./schema": "the project's drizzle schema, which every project defines for itself",
  "./env": "the project's env definition, likewise",
  "./secrets": "src/env/define.ts, read by the deploy to declare secrets, not by an instance",
  "./plugin": "hooks-plugin.ts: the Void build plugin, which runs in the build",
  "./deploy-plugin": "types only, and a deploy plugin runs in the build (src/node/deploy-plugins.ts)",
  ".": "the CLI (src/node/index.ts)",
  "./serve": "the Bun server the CLI starts",
  "./bundle": "the marketplace bundler: it builds plugins, it is not one",
  "./adapter": "the Void adapter, which runs in the build",
  "./adapter/plugin": "the same adapter's Vite half",
  "./cloud": "voidbase.cloud's Cloudflare API client",
  "./cloud-client": "voidbase.cloud's browser client",
  "./app": "the application a plugin is loaded into; a plugin that imports it is the failure this phase prevents",
  "./api": "the application's REST routes",
  "./static": "the application's static handler",
  "./crons": "a Worker entry point",
  "./jobs": "a Worker entry point",
  "./hub": "a Worker entry point (the realtime Durable Object)",
  "./durable-db": "a Worker entry point (the database Durable Object)",
  "./workflows": "a Worker entry point, and it imports ./app; a project's own workflows/ module may import it, a plugin may not",
};

const PKG = "@voidbase-cloud/voidbase";

/** the `exports` entry a bundle's specifier names, or null when the specifier is not this package's */
export const entryOf = (specifier: string): string | null =>
  specifier === PKG ? "." : specifier.startsWith(`${PKG}/`) ? `.${specifier.slice(PKG.length)}` : null;

/**
 * Why an instance refuses this specifier to a plugin, or null when it does not refuse it. The message both halves
 * answer with: the Bun loader before it imports a bundle, the Workers build while it resolves one. A name that is
 * neither provided nor refused is not this package's at all, and answers null here the way `left-pad` does.
 */
export function refusalFor(specifier: string): string | null {
  const entry = entryOf(specifier);
  if (!entry) return null;
  const why = NOT_PROVIDED[entry] ?? Object.entries(NOT_PROVIDED).find(([e]) => e.endsWith("/*") && entry.startsWith(e.slice(0, -1)))?.[1];
  return why ? `${specifier} is not something an instance provides to a plugin: ${why}` : null;
}

/**
 * What a bundle may import at all: this package and hono, nothing else. Enforced in the two places a bundle is
 * read — the Bun loader's check before it imports one (src/platform/node/plugins.ts), and hooks-plugin.ts's
 * `resolveId` when a Worker is built, which hands anything else back to Vite and fails the build on it.
 */
export const PROVIDED_RE = /^(@voidbase-cloud\/voidbase|hono)(\/|$)/;
