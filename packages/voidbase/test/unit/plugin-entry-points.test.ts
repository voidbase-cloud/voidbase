// The entry points a plugin package imports from, checked against the files they map to.
//
// A plugin in its own package can only be typed against this voidbase through package.json's `exports`; a deep
// import is refused once that map exists. So the map has to name the plugin API and the plugins that ship, and each
// name has to reach a module that exports what the package expects. This keeps the map from drifting from the code.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { NOT_PROVIDED, PROVIDED, refusalFor } from "../../src/node/provided";

const root = resolve(import.meta.dir, "../..");
/** an entry maps to one file, or to one file per runtime condition: the platform picks are the second kind */
type Target = string | { workerd: string; default: string };
const exportsMap = pkg.exports as Record<string, Target>;
/** what a bundle on Bun loads for an entry, and what the entry-point check imports: the default condition */
const fileOf = (t: Target): string => (typeof t === "string" ? t : t.default);

const expected: Record<string, string[]> = {
  "./kernel": ["createKernel", "load", "serve", "using", "whatLoaded", "onBootstrap", "runBootstraps"],
  "./plugins": ["checkManifest"],
  // the slots the core and a plugin hand each other things through. A plugin package cannot import the application
  // that loads it, so these are how it reaches what the request carries: auth-slot to ask who is signed in,
  // record-slot to ask for the request's record context (plugins/auth.ts and plugins/seo.ts both do), realtime-slot
  // to read the realtime@1 provider through the same guard the core reads it through.
  "./auth-slot": ["provideAuthLookup", "authProvider", "authenticate", "fromToken", "isSuperuser", "requireAuth", "requireSuperuser"],
  "./record-slot": ["provideRecordContext", "recordContextFor", "recordContextBuilder", "restoreRecordContext"],
  "./realtime-slot": ["realtimeOf", "realtimeOff"],
  "./deploy-plugin": [], // types only: DeployPlugin, DeployContext
  "./interfaces": ["KNOWN"],
  "./plugins/auth": ["auth", "provider"],
  "./plugins/backups": ["backups"],
  "./plugins/realtime": ["realtime"],
  "./plugins/hardening": ["hardening"],
  "./plugins/openapi": ["openapi", "openapiWith", "buildDocument"],
  "./plugins/mcp": ["mcp", "mcpWith", "toolsOf"],
  "./plugins/seo": ["seo", "seoWith", "parseSitemap"],
  "./plugins/mail": ["mail", "cloudflareMail"],
  // not a plugin: the two names the mail plugin and `voidbase deploy` have to agree on, so that src/node/deploy-cf.ts
  // can write the binding without importing what the plugin does. Published in 7.6, when the plugin left the core
  // and the sibling import that carried the agreement stopped resolving.
  // Same shape again, for the same reason, published in 7.7 when the ai plugin left the core: src/node/deploy-cf.ts
  // writes the AI binding and has to name it, and the plugin package cannot be what tells it the name.
  "./plugins/ai-binding": ["AI_BINDING", "AI_VAR", "DEFAULT_MODEL", "aiModelOf"],
  "./plugins/mail-binding": ["MAIL_BINDING", "MAIL_DOMAIN_VAR"],
  "./plugins/ai": ["ai", "aiWith", "aiRoute"],
  "./plugins/observability": ["observability", "observabilityWith", "observabilityReport", "sampler"],
  // not a plugin either: the names the observability plugin and `voidbase deploy` agree on, so that
  // src/node/deploy-cf.ts can turn the Worker's own logs on and bake the knobs without importing what the plugin
  // does (the kernel, the routes, D1, the SQL client). Published in 7.6, for the reason /plugins/mail-binding was.
  "./plugins/observability-binding": ["ANALYTICS_BINDING", "OBSERVABILITY_VAR", "SAMPLE_VAR", "ACCOUNT_VAR", "TOKEN_VAR", "DATASET_VAR", "WORKER_NAME_VAR", "ACCOUNT_ID_VAR", "observabilityOn", "sampleRateOf", "analyticsDataset", "workerObservability"],
  "./plugins/translations": ["translations", "translationsWith", "parseTranslatable", "parseLocales", "negotiateLocale"],
  "./plugins/stripe": ["stripe", "stripeWith", "verifySignature", "formEncode", "applyEvent"],
  "./plugins/polar": ["polar", "polarWith", "verifySignature", "applyEvent"],
  "./plugins/lemonsqueezy": ["lemonsqueezy", "lemonsqueezyWith", "verifySignature", "applyEvent"],
  "./plugins/payments-shared": ["paymentsPlugin", "collectionDefinitions", "d1Rows", "ensureCustomer", "upsert", "customerForUser", "onPaymentWritten"],
  "./plugins/tax-flat": ["taxFlat", "taxRate", "taxQuote"],
  "./plugins/shipping-flat": ["shippingFlat", "flatAmount", "freeOver", "flatRates"],
  "./plugins/commerce": ["commerce", "commerceWith", "collectionDefinitions", "commerceOn", "COMMERCE_COLLECTIONS"],
  "./plugins/domains": ["domains", "domainsInfo"],
  "./plugins/previews": ["previews", "previewsInfo", "previewWorkerName"],
  "./plugins/collections": ["ensureCollections"],
  "./workflows": ["withApp"],
  "./registry": ["fetchIndex", "problemsWithIndex", "integrityOf", "download"],

  // ---- 7.2: the surface a plugin package imports, so that none of it is a relative path or a `#platform/*` pick.
  // The aggregate of what more than one shipped plugin uses. Each name is re-exported from the module that
  // declares it, so a plugin package's `ApiError` is the instance's own and its `loadSettings` reads the same cache.
  "./sdk": [
    "isSuperuser", "requireAuth", "requireSuperuser",
    "ApiError", "badRequest", "forbidden", "notFound",
    "all", "ident", "one", "stmt", "bufferedTransaction",
    "collectionToJSON", "findCollection", "isAuth", "isView", "listCollections", "loadCollections", "SUPERUSERS",
    "collectionId", "createCollection", "updateCollection", "isMultiple",
    "createRecord", "deleteRecord", "listRecords", "PreconditionFailed", "updateRecord", "rowToValues",
    "loadSettings", "VERSION", "nowString",
  ],
  // types only, and the module that declares Bindings, so a plugin package augments this name to add its own knobs.
  // Handed to a bundle all the same, for the reason src/node/provided.ts records and the test below spells out.
  "./types": [],
  // the `#platform/*` picks a plugin makes, published under names that resolve outside this package too. Each keeps
  // both conditions, so the same plugin file gets the workerd half on Workers and the node half on Bun.
  "./platform": ["env", "logger", "defaultLogMinLevel"],
  "./platform/email": ["EmailMessage"],
  "./platform/raster": ["rasterize"],
  // the narrow seams, one shipped plugin each: what that plugin alone imports and nothing more.
  "./auth-routes": ["authMethods", "authRefresh", "authWithPassword", "findAuthRecordByToken", "isSuperuserRecord", "tokenFromRequest", "AUTH_CLEAR_PATH", "authClearCookieFor", "mountAuthExtra", "mountAuthFlows", "authWithOAuth2", "mountOAuth2Redirect", "mountWebAuthn"],
  "./backups-api": ["mountBackupsApi"],
  "./hardening-middleware": ["mountCsrfRoute", "bodyLimitMiddleware", "rateLimitMiddleware", "responsePolicy", "responsePolicyMiddleware"],
  "./realtime-client": ["realtimeFor"],
  "./mail": ["mailRoute", "buildMime", "htmlToText"],
  "./records-preview": ["PREVIEW_FIELD", "PREVIEW_HEADER", "PREVIEW_PARAM", "flaggedCollections"],
  "./records-files": ["deleteAllRecordFiles"],
  "./project-sync": ["LOCKFILE", "commitPlugins", "lockOf"],
};

describe("the plugin API is reachable from a package", () => {
  for (const [entry, names] of Object.entries(expected)) {
    test(`${entry} maps to a module exporting ${names.join(", ") || "types only"}`, async () => {
      const target = exportsMap[entry];
      expect(target).toBeDefined();
      // a conditional entry has to have both halves on disk: the workerd one is what a Worker build takes
      if (typeof target === "object") expect(existsSync(resolve(root, target.workerd))).toBe(true);
      const file = fileOf(target!);
      expect(existsSync(resolve(root, file))).toBe(true);
      const mod = (await import(resolve(root, file))) as Record<string, unknown>;
      for (const n of names) expect(typeof mod[n]).not.toBe("undefined");
    });
  }

  // The map is what a package may import, and a bundle on Bun imports the same names at runtime, where they
  // resolve to this process's own modules rather than through node_modules (src/platform/node/plugins.ts). A name
  // in one and not the other type-checks and then fails to load, which is the failure a marketplace bundle would
  // hit first, so the slots are checked in both.
  test("a bundle can import the slots at runtime too, not only type against them", () => {
    for (const entry of ["auth-slot", "record-slot", "realtime-slot"]) {
      expect(exportsMap[`./${entry}`]).toBeDefined();
      expect(PROVIDED[`@voidbase-cloud/voidbase/${entry}`]).toBeDefined();
    }
  });

  // The two lists are now one list, which is what 7.2 is for. `src/node/provided.ts` reads package.json's
  // `exports` and hands a bundle the module behind each name, so the names cannot drift; what it does not hand over
  // it refuses by name, with the reason, in `NOT_PROVIDED`. These three tests are the whole of that agreement: the
  // exports map is exactly provided + refused, everything provided is checked above, and every thunk really loads.
  test("every published entry is either provided to a bundle or refused by name", () => {
    const unaccounted = Object.keys(exportsMap).filter((e) => {
      const spec = `@voidbase-cloud/voidbase${e === "." ? "" : e.slice(1)}`;
      return !PROVIDED[spec] && !(e in NOT_PROVIDED);
    });
    expect(unaccounted).toEqual([]);
    // and nothing is in both: a refusal with a module behind it would be a lie in one place or the other
    const both = Object.keys(NOT_PROVIDED).filter((e) => PROVIDED[`@voidbase-cloud/voidbase${e === "." ? "" : e.slice(1)}`]);
    expect(both).toEqual([]);
    // every refusal names an entry that exists, so a renamed entry cannot leave a stale excuse behind
    expect(Object.keys(NOT_PROVIDED).filter((e) => !(e in exportsMap))).toEqual([]);
  });

  test("everything a bundle can import is an entry this file checks", () => {
    const unchecked = Object.keys(PROVIDED)
      .map((spec) => `.${spec.slice("@voidbase-cloud/voidbase".length)}`)
      .filter((entry) => !(entry in expected));
    expect(unchecked).toEqual([]);
  });

  // Names on both sides are not the agreement. What a bundle is handed is a thunk, and a thunk holds a path of its
  // own: `./kernel` in `exports` and a thunk that imports the records service would pass every check above and hand
  // a bundle a module that is not the one it was typed against. So the thunk is loaded and compared against the
  // module the entry's own target resolves to — the same module object, not a copy with the same shape.
  test("every provided name loads the module its export points at, not another one", async () => {
    for (const [spec, load] of Object.entries(PROVIDED)) {
      const entry = `.${spec.slice("@voidbase-cloud/voidbase".length)}`;
      const target = exportsMap[entry];
      expect(target, spec).toBeDefined();
      const mod = await load();
      expect(typeof mod, spec).toBe("object");
      expect(mod, `${spec} loads something other than ${fileOf(target!)}`).toBe(await import(resolve(root, fileOf(target!))));
    }
  });

  // `./types` declares no value, so what a bundle gets here is an empty namespace, and that is the whole of it.
  // It was refused through 0.9.0-beta.49 on the reading that a bundler erases a type import. `import type` it does;
  // `import { type Bindings }` under `verbatimModuleSyntax` emits `import {} from "@voidbase-cloud/voidbase/types"`
  // and both bundlers keep that, so the specifier reaches the instance and the refusal took the whole plugin down
  // at load over a module with nothing in it. The rule a plugin author needs is in docs/plugins.md either way.
  test("./types is handed to a bundle, empty, rather than refused", async () => {
    expect(NOT_PROVIDED["./types"]).toBeUndefined();
    expect(refusalFor("@voidbase-cloud/voidbase/types")).toBeNull();
    const load = PROVIDED["@voidbase-cloud/voidbase/types"];
    expect(load).toBeDefined();
    expect(Object.keys(await load!())).toEqual([]);
  });

  // Two functions called isSuperuser, and a plugin package that imports the wrong one is wrong only on the
  // instances that matter: the ones whose auth is not the shipped plugin. `/sdk`'s asks whichever plugin provides
  // `auth@1`; the auth module's own compares the record's collection and is that plugin's answer, so it is
  // published under a name that says so. Anything else, and the two names are one name in a plugin's editor.
  test("the two isSuperuser are told apart at the entry that publishes each", async () => {
    const sdk = (await import(resolve(root, fileOf(exportsMap["./sdk"]!)))) as Record<string, unknown>;
    const routes = (await import(resolve(root, fileOf(exportsMap["./auth-routes"]!)))) as Record<string, unknown>;
    const slot = await import("../../src/server/auth-slot");
    const authModule = await import("../../src/server/auth");
    expect(sdk.isSuperuser).toBe(slot.isSuperuser as unknown);
    expect(routes.isSuperuserRecord).toBe(authModule.isSuperuser as unknown);
    // and the name is not published twice, so importing `isSuperuser` can only mean the slot's
    expect(routes.isSuperuser).toBeUndefined();
    expect(sdk.isSuperuser).not.toBe(routes.isSuperuserRecord);
  });

  // An entry that is a core module publishes that module's whole surface, which is how `./records-files` came to
  // publish `deletePrefix` — empty everything under a prefix, and the bucket itself if the prefix is empty — to
  // plugins that asked for one call. The four are aggregators now, named after what the one plugin importing them
  // uses; what they leave behind is the core's own and stays the core's own.
  test("the narrow entries publish the calls one plugin makes and not the module behind them", async () => {
    const withheld: Record<string, { core: string; names: string[] }> = {
      "./records-files": { core: "../../src/server/records/files", names: ["deletePrefix", "deleteFiles", "putUpload", "fileKey"] },
      "./records-preview": { core: "../../src/server/records/preview", names: ["visibleInPreview", "addPreviewField", "previewScope"] },
      "./realtime-client": { core: "../../src/server/realtime/hub-client", names: ["HubClient", "NoHub", "sendFilter"] },
      "./project-sync": { core: "../../src/server/project-sync", names: ["parseLock", "lockText", "emptyLock"] },
    };
    for (const [entry, { core, names }] of Object.entries(withheld)) {
      const published = (await import(resolve(root, fileOf(exportsMap[entry]!)))) as Record<string, unknown>;
      const module = (await import(core)) as Record<string, unknown>;
      // the names are the core module's, so the entry is not that module
      expect(names.filter((n) => !(n in module)), `${core} no longer exports these`).toEqual([]);
      expect(names.filter((n) => n in published), entry).toEqual([]);
      expect(Object.keys(published).length, entry).toBeGreaterThan(0);
    }
  });

  // `./passkeys` was an entry point through 0.9.0-beta.48 and is not one now, and what changed is who mounts the
  // four routes rather than whether they are published: `mountWebAuthn`, the only thing src/server/webauthn.ts
  // exports, is published here under `/auth-routes`, with the rest of what plugins/auth.ts mounts. What it may not
  // be is an entry of its own, because that is a name a consumer puts on a router of their own. Its login handler
  // finishes by building the request's record context; it used to reach that with `await import("./app")` — the
  // import this phase took out of every plugin — and asks the slot for it now, so on a router the application did
  // not fill the slot for it throws where the dynamic import used to heal it. voidbase's own app mounts the auth
  // plugin, which is how every instance has passkeys; there is no supported way to have them without it.
  test("passkeys are published with the auth plugin's routes, not as an entry of their own", async () => {
    expect(exportsMap["./passkeys"]).toBeUndefined();
    expect(Object.values(exportsMap)).not.toContain("./src/server/webauthn.ts");
    const routes = (await import(resolve(root, fileOf(exportsMap["./auth-routes"]!)))) as Record<string, unknown>;
    const webauthn = await import("../../src/server/webauthn");
    expect(routes.mountWebAuthn).toBe(webauthn.mountWebAuthn as unknown);
  });

  test("each shipped plugin's manifest name is its entry point's last segment", async () => {
    const camel: Record<string, string> = { "tax-flat": "taxFlat", "shipping-flat": "shippingFlat" };
    for (const name of ["auth", "observability", "backups", "realtime", "hardening", "openapi", "mcp", "seo", "mail", "ai", "translations", "stripe", "polar", "lemonsqueezy", "tax-flat", "shipping-flat", "commerce", "previews", "domains"]) {
      const mod = (await import(resolve(root, exportsMap[`./plugins/${name}`]!))) as Record<string, { manifest: { name: string } }>;
      expect(mod[camel[name] ?? name]!.manifest.name).toBe(name);
    }
  });
});
