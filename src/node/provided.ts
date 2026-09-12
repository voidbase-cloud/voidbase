// What a plugin bundle may import, the module each name is, and the names an instance refuses. One list, read by
// both halves of an instance.
//
// A bundle installed from a marketplace imports voidbase by name. On Bun those imports do not go through
// node_modules: they resolve to the modules this process is already running (src/platform/node/plugins.ts registers
// each one as a virtual module), which is what lets the same bundle load inside the standalone executable, which
// has no node_modules at all, and what gives a plugin the instance's own kernel and hono rather than a second copy.
// When a Worker is built the same bundle's imports are resolved at build time instead, by `providedImport` in
// ./installed.ts, to the same files. This file is where both halves read the list from: it sat under
// src/platform/node/ through 0.9.0-beta.49, which the Workers half could not import, and the two answered
// differently — every name `NOT_PROVIDED` refuses was built into a Worker without a word.
//
// The list of names is not written here. It is package.json's `exports`, which is also what a plugin package is
// type-checked against, so the two cannot say different things: a name that type-checks and then fails to load was
// the failure a marketplace bundle would hit first, and through 0.9.0-beta.49 twenty-odd names were in that state.
// What is written here is the other half — the file behind each name, keyed by the path `exports` maps the name to,
// so an entry whose target moves stops matching and the entry-point test says so — and `NOT_PROVIDED`, the entries
// an instance deliberately does not hand a bundle, each with the reason it does not.
//
// The modules are thunks holding a literal specifier, not static imports. Literal, because that is what
// `bun build --compile` embeds in the executable; thunks, because static imports here would put twenty plugins,
// `@resvg/resvg-wasm` and the whole records service on the startup path of every Bun instance, including the ones
// that have no plugins installed. A dynamic import of a file this process already imported returns that module
// rather than a second copy, which is the only property any of this depends on.
import pkg from "../../package.json" with { type: "json" };

/** every module behind a published entry, by the path package.json's `exports` names */
const MODULES: Record<string, () => Promise<object>> = {
  // the plugin API
  "./src/server/kernel.ts": () => import("../server/kernel"),
  "./src/server/plugins/manifest.ts": () => import("../server/plugins/manifest"),
  "./src/server/interfaces/index.ts": () => import("../server/interfaces"),
  // the three slots the core and a plugin hand each other things through
  "./src/server/auth-slot.ts": () => import("../server/auth-slot"),
  "./src/server/record-slot.ts": () => import("../server/record-slot"),
  "./src/server/realtime-slot.ts": () => import("../server/realtime-slot"),
  // the core helpers a plugin is written against, its types, and the platform picks it makes
  "./src/server/entries/sdk.ts": () => import("../server/entries/sdk"),
  // `./types` declares no value, so this thunk loads an empty namespace, and handing one over is the point. The
  // reading that refused it through 0.9.0-beta.49 — a bundler erases a type import, so no bundle ever asks for the
  // name — holds for `import type` and not for the other spelling: a plugin package compiled with
  // `verbatimModuleSyntax`, which is what a TypeScript package is written with now, emits
  // `import {} from "@voidbase-cloud/voidbase/types"` for `import { type Bindings }`, and both bundlers keep that
  // side-effect import of a module they were told is external. So the specifier does reach an instance, and
  // refusing it refused the whole plugin, at load, over a module with nothing in it to refuse.
  "./src/server/types.ts": () => import("../server/types"),
  "./src/platform/node/index.ts": () => import("../platform/node/index"),
  "./src/platform/node/email.ts": () => import("../platform/node/email"),
  "./src/platform/node/raster.ts": () => import("../platform/node/raster"),
  // the narrow seams, one shipped plugin each
  "./src/server/entries/auth-routes.ts": () => import("../server/entries/auth-routes"),
  "./src/server/entries/backups-api.ts": () => import("../server/entries/backups-api"),
  "./src/server/entries/hardening-middleware.ts": () => import("../server/entries/hardening-middleware"),
  "./src/server/entries/mail.ts": () => import("../server/entries/mail"),
  "./src/server/entries/realtime-client.ts": () => import("../server/entries/realtime-client"),
  "./src/server/entries/records-preview.ts": () => import("../server/entries/records-preview"),
  "./src/server/entries/records-files.ts": () => import("../server/entries/records-files"),
  "./src/server/entries/project-sync.ts": () => import("../server/entries/project-sync"),
  "./src/node/registry.ts": () => import("./registry"),
  // the plugins this package ships, which the official @voidbase-cloud/plugin-* packages re-export
  "./src/server/plugins/ai.ts": () => import("../server/plugins/ai"),
  "./src/server/plugins/auth.ts": () => import("../server/plugins/auth"),
  "./src/server/plugins/backups.ts": () => import("../server/plugins/backups"),
  "./src/server/plugins/collections.ts": () => import("../server/plugins/collections"),
  "./src/server/plugins/commerce.ts": () => import("../server/plugins/commerce"),
  "./src/server/plugins/domains.ts": () => import("../server/plugins/domains"),
  "./src/server/plugins/hardening.ts": () => import("../server/plugins/hardening"),
  "./src/server/plugins/lemonsqueezy.ts": () => import("../server/plugins/lemonsqueezy"),
  "./src/server/plugins/mail.ts": () => import("../server/plugins/mail"),
  "./src/server/plugins/mcp.ts": () => import("../server/plugins/mcp"),
  "./src/server/plugins/observability.ts": () => import("../server/plugins/observability"),
  "./src/server/plugins/openapi.ts": () => import("../server/plugins/openapi"),
  "./src/server/plugins/payments-shared.ts": () => import("../server/plugins/payments-shared"),
  "./src/server/plugins/polar.ts": () => import("../server/plugins/polar"),
  "./src/server/plugins/previews.ts": () => import("../server/plugins/previews"),
  "./src/server/plugins/realtime.ts": () => import("../server/plugins/realtime"),
  "./src/server/plugins/seo.ts": () => import("../server/plugins/seo"),
  "./src/server/plugins/shipping-flat.ts": () => import("../server/plugins/shipping-flat"),
  "./src/server/plugins/stripe.ts": () => import("../server/plugins/stripe"),
  "./src/server/plugins/tax-flat.ts": () => import("../server/plugins/tax-flat"),
  "./src/server/plugins/translations.ts": () => import("../server/plugins/translations"),
};

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
  "./scripts/*": "a pattern over this repository's own build scripts",
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

/** an `exports` target as one path: the conditional entries are the platform picks, and Bun takes the default */
const targetOf = (target: string | Record<string, string>): string => (typeof target === "string" ? target : (target.default ?? ""));

/** `./kernel` as a bundle writes it; `.` would be the package itself, which is not something a bundle imports */
const specifierOf = (entry: string): string => `@voidbase-cloud/voidbase${entry === "." ? "" : entry.slice(1)}`;

const PKG = "@voidbase-cloud/voidbase";

/** the `exports` entry a bundle's specifier names, or null when the specifier is not this package's */
export const entryOf = (specifier: string): string | null =>
  specifier === PKG ? "." : specifier.startsWith(`${PKG}/`) ? `.${specifier.slice(PKG.length)}` : null;

/**
 * The entry points a bundle may import, as the modules this process runs. Generated from package.json's `exports`,
 * so the two lists are one list; `NOT_PROVIDED` is what `exports` names and this does not, on purpose.
 */
export const PROVIDED: Record<string, () => Promise<object>> = Object.fromEntries(
  Object.entries(pkg.exports as Record<string, string | Record<string, string>>).flatMap(([entry, target]) => {
    const load = MODULES[targetOf(target)];
    return load ? ([[specifierOf(entry), load]] as const) : [];
  }),
);

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
