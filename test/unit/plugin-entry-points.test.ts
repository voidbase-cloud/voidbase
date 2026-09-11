// The entry points a plugin package imports from, checked against the files they map to.
//
// A plugin in its own package can only be typed against this voidbase through package.json's `exports`; a deep
// import is refused once that map exists. So the map has to name the plugin API and the plugins that ship, and each
// name has to reach a module that exports what the package expects. This keeps the map from drifting from the code.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "../..");
const exportsMap = pkg.exports as Record<string, string>;

const expected: Record<string, string[]> = {
  "./kernel": ["createKernel", "load", "serve", "using", "whatLoaded", "onBootstrap", "runBootstraps"],
  "./plugins": ["checkManifest"],
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
  "./plugins/payments-shared": ["paymentsPlugin", "collectionDefinitions", "d1Rows", "ensureCustomer", "upsert", "customerForUser"],
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

  test("each shipped plugin's manifest name is its entry point's last segment", async () => {
    for (const name of ["auth", "observability", "backups", "realtime", "hardening", "openapi", "mcp", "seo", "mail", "ai", "translations", "stripe", "polar", "lemonsqueezy", "previews", "domains"]) {
      const mod = (await import(resolve(root, exportsMap[`./plugins/${name}`]!))) as Record<string, { manifest: { name: string } }>;
      expect(mod[name]!.manifest.name).toBe(name);
    }
  });
});
