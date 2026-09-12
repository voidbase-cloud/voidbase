// The entry points a plugin package imports from, checked against the files they map to.
//
// A plugin in its own package can only be typed against this voidbase through package.json's `exports`; a deep
// import is refused once that map exists. So the map has to name the plugin API and the plugins that ship, and each
// name has to reach a module that exports what the package expects. This keeps the map from drifting from the code.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "../..");
const exportsMap = pkg.exports as Record<string, string>;

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
  "./plugins/ai": ["ai", "aiWith", "aiRoute"],
  "./plugins/observability": ["observability", "observabilityWith", "observabilityReport", "sampler"],
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
};

describe("the plugin API is reachable from a package", () => {
  for (const [entry, names] of Object.entries(expected)) {
    test(`${entry} maps to a module exporting ${names.join(", ")}`, async () => {
      const target = exportsMap[entry];
      expect(target).toBeDefined();
      expect(existsSync(resolve(root, target!))).toBe(true);
      const mod = (await import(resolve(root, target!))) as Record<string, unknown>;
      for (const n of names) expect(typeof mod[n]).not.toBe("undefined");
    });
  }

  // The map is what a package may import, and a bundle on Bun imports the same names at runtime, where they
  // resolve to this process's own modules rather than through node_modules (src/platform/node/plugins.ts). A name
  // in one and not the other type-checks and then fails to load, which is the failure a marketplace bundle would
  // hit first, so the slots are checked in both.
  test("a bundle can import the slots at runtime too, not only type against them", () => {
    const provided = readFileSync(resolve(root, "src/platform/node/plugins.ts"), "utf8");
    for (const entry of ["auth-slot", "record-slot", "realtime-slot"]) {
      expect(exportsMap[`./${entry}`]).toBeDefined();
      expect(provided).toContain(`"@voidbase-cloud/voidbase/${entry}":`);
    }
  });

  // And the shape of the gap between the two lists, so that the docs' account of it cannot go stale unnoticed:
  // `PROVIDED` is the shorter list today, and squaring the rest of it is 7.2's work.
  test("the provided map is the shorter list: sixteen plugin entry points are in exports and not in it", () => {
    const provided = readFileSync(resolve(root, "src/platform/node/plugins.ts"), "utf8");
    const inProvided = (entry: string) => provided.includes(`"@voidbase-cloud/voidbase${entry.slice(1)}":`);
    const plugins = Object.keys(exportsMap).filter((e) => e.startsWith("./plugins/"));
    expect(plugins.filter(inProvided).sort()).toEqual(["./plugins/auth", "./plugins/backups", "./plugins/collections", "./plugins/hardening", "./plugins/realtime"]);
    expect(plugins.filter((e) => !inProvided(e))).toHaveLength(16);
  });

  // Published through 0.9.0-beta.48 and dropped here: `mountWebAuthn` is the only thing src/server/webauthn.ts
  // exports, and it cannot stand
  // on a router of its own any more. Its login handler finishes by building the request's record context, which it
  // used to reach with `await import("./app")` — the import this phase took out of every plugin — and now asks the
  // slot for. On a consumer's own router nothing has filled that slot, so the route threw where the dynamic import
  // used to heal itself. Putting the import back would give plugins/auth.ts, which mounts these four routes, the
  // whole application in its module graph again, which is the one thing this phase exists to prevent. voidbase's
  // own app mounts them, so every instance has passkeys; there is no supported way to have them without it.
  test("./passkeys is not an entry point: mountWebAuthn needs the app that fills the slots", () => {
    expect(exportsMap["./passkeys"]).toBeUndefined();
    expect(Object.values(exportsMap)).not.toContain("./src/server/webauthn.ts");
  });

  test("each shipped plugin's manifest name is its entry point's last segment", async () => {
    const camel: Record<string, string> = { "tax-flat": "taxFlat", "shipping-flat": "shippingFlat" };
    for (const name of ["auth", "observability", "backups", "realtime", "hardening", "openapi", "mcp", "seo", "mail", "ai", "translations", "stripe", "polar", "lemonsqueezy", "tax-flat", "shipping-flat", "commerce", "previews", "domains"]) {
      const mod = (await import(resolve(root, exportsMap[`./plugins/${name}`]!))) as Record<string, { manifest: { name: string } }>;
      expect(mod[camel[name] ?? name]!.manifest.name).toBe(name);
    }
  });
});
