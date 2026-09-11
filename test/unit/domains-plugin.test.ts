// The domains plugin's pure parts: the knobs, the redirect a non-canonical hostname gets, the rule tags that keep the
// plugin's set apart from a project's _redirects set on one zone, and what the runtime half reports.
import { describe, expect, test } from "bun:test";
import { canonicalRedirect, DOMAINS_KNOB, domainsDeploy, hostnamesOf, LEGACY_KNOB, SCOPE, validateHostnames } from "../../src/node/plugins/domains";
import { ownsRule, redirectRule, ruleTag } from "../../src/node/zone-redirects";
import type { DeployContext } from "../../src/node/deploy-plugin";
import { CANONICAL_DOMAIN_VAR, DOMAINS_VAR, domains, domainsInfo } from "../../src/server/plugins/domains";

const ctxOf = (env: Record<string, string>, over: Partial<DeployContext> = {}): DeployContext => ({ name: "site", account: { id: "acc" }, api: null, env, config: {}, vars: {}, url: null, log: () => undefined, local: false, dryRun: false, ...over });

describe("the knobs", () => {
  test("VOIDBASE_DOMAINS is the knob, VOIDBASE_DEPLOY_DOMAIN the older name still read, and the newer wins", () => {
    expect(hostnamesOf({ [LEGACY_KNOB]: "Api.Example.com" })).toEqual(["api.example.com"]);
    expect(hostnamesOf({ [DOMAINS_KNOB]: "example.com, https://www.example.com/", [LEGACY_KNOB]: "other.test" })).toEqual(["example.com", "www.example.com"]);
    expect(hostnamesOf({})).toEqual([]);
    expect(hostnamesOf({ [DOMAINS_KNOB]: " , " })).toEqual([]);
  });
  test("a hostname is validated before anything is touched", () => {
    expect(() => validateHostnames(["example.com", "a b.example.com"])).toThrow('invalid custom domain "a b.example.com"');
    expect(() => validateHostnames(["localhost"])).toThrow();
    expect(() => validateHostnames(["api.example.com"])).not.toThrow();
  });
});

describe("before", () => {
  test("turns workers.dev off, bakes the list and the canonical name, claims the URL; nothing without a hostname", async () => {
    const ctx = ctxOf({ [DOMAINS_KNOB]: "example.com,www.example.com" });
    await domainsDeploy.deploy!.before!(ctx);
    expect(ctx.config.workers_dev).toBe(false);
    expect(ctx.vars).toEqual({ [DOMAINS_VAR]: "example.com,www.example.com", [CANONICAL_DOMAIN_VAR]: "example.com" });
    expect(ctx.url).toBe("https://example.com");
    const none = ctxOf({});
    await domainsDeploy.deploy!.before!(none);
    expect(none.config).toEqual({}); expect(none.vars).toEqual({}); expect(none.url).toBeNull();
  });
  test("an invalid hostname refuses the deploy", async () => {
    await expect(domainsDeploy.deploy!.before!(ctxOf({ [DOMAINS_KNOB]: "nope" }))).rejects.toThrow('invalid custom domain "nope"');
  });
});

describe("the canonical redirect", () => {
  test("everything under a non-canonical hostname goes, 301, to the same path on the canonical one, tagged as the plugin's", () => {
    const rule = redirectRule("site", canonicalRedirect("www.example.com", "example.com"), SCOPE) as { description: string; expression: string; action_parameters: { from_value: { status_code: number; target_url: { expression: string }; preserve_query_string: boolean } } };
    expect(rule.description).toBe("voidbase:site:@domains:www.example.com");
    expect(rule.expression).toBe('(http.host eq "www.example.com")');
    expect(rule.action_parameters.from_value).toEqual({ status_code: 301, target_url: { expression: 'concat("https://example.com", http.request.uri.path)' }, preserve_query_string: true });
  });
  test("the plugin's set and the _redirects set never claim each other's rules; another worker's are nobody's", () => {
    expect(ruleTag("site")).toBe("voidbase:site:"); expect(ruleTag("site", "domains")).toBe("voidbase:site:@domains:");
    expect(ownsRule("site", undefined, "voidbase:site:https://api.example.com/")).toBe(true);
    expect(ownsRule("site", undefined, "voidbase:site:@domains:www.example.com")).toBe(false);
    expect(ownsRule("site", "domains", "voidbase:site:@domains:www.example.com")).toBe(true);
    expect(ownsRule("site", "domains", "voidbase:site:https://api.example.com/")).toBe(false);
    expect(ownsRule("site", undefined, "voidbase:other:https://api.example.com/")).toBe(false);
    expect(ownsRule("site", undefined, undefined)).toBe(false);
  });
});

describe("the runtime half", () => {
  test("is a shipped plugin that reports the baked vars and provides nothing else", () => {
    expect(domains.manifest.name).toBe("domains"); expect(domains.apply).toBeUndefined();
    expect(domainsInfo({ [DOMAINS_VAR]: "Example.com,www.example.com", [CANONICAL_DOMAIN_VAR]: "example.com" })).toEqual({ hostnames: ["example.com", "www.example.com"], canonical: "example.com" });
    expect(domainsInfo({ [DOMAINS_VAR]: "api.example.com" })).toEqual({ hostnames: ["api.example.com"], canonical: "api.example.com" });
    expect(domainsInfo({})).toEqual({ hostnames: [], canonical: null });
  });
});
