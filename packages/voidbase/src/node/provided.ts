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
  "./src/server/plugins/mail-binding.ts": () => import("../server/plugins/mail-binding"),
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


/** an `exports` target as one path: the conditional entries are the platform picks, and Bun takes the default */
const targetOf = (target: string | Record<string, string>): string => (typeof target === "string" ? target : (target.default ?? ""));

/** `./kernel` as a bundle writes it; `.` would be the package itself, which is not something a bundle imports */
const specifierOf = (entry: string): string => `@voidbase-cloud/voidbase${entry === "." ? "" : entry.slice(1)}`;


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

// the refusal list and the specifier helpers live in ./refusals.ts, which the Workers half reads without this
// module's thunks; they are re-exported here so a reader of either name finds it where it was
export { entryOf, NOT_PROVIDED, PROVIDED_RE, refusalFor } from "./refusals";
