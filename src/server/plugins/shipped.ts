// The plugins voidbase ships, by name: data, so the CLI can tell a shipped plugin from an installed one without
// importing what a shipped plugin does. app.ts loads the objects and checks its list is this one.
import type { InterfaceName, Tier } from "./manifest";
import type { PluginFacts } from "./resolve";
export const SHIPPED = ["auth", "realtime", "hardening", "backups", "installer", "openapi", "mcp", "seo", "mail", "ai", "translations", "stripe", "polar", "lemonsqueezy", "previews", "domains"] as const;
export type ShippedName = (typeof SHIPPED)[number];

/**
 * What each shipped plugin declares beyond its name: its tier, and its place in the graph.
 *
 * The same reason the list above is data. `voidbase plugins remove <name>` has to know whether it is about to take
 * the instance's auth away, or take something else's provider away, before it writes voidbase.lock — and it cannot
 * import sixteen plugins to find out, because importing a plugin is most of the way to running it. So the manifests'
 * three load-bearing fields are repeated here as data, and app.ts checks this table against the manifests it loads
 * at boot, which is what stops it drifting.
 */
export const SHIPPED_FACTS: Record<ShippedName, { tier: Tier; provides?: InterfaceName[]; requires?: InterfaceName[] }> = {
  auth: { tier: "core", provides: ["auth@1"] },
  realtime: { tier: "official", provides: ["realtime@1"] },
  hardening: { tier: "official", provides: ["hardening@1"] },
  backups: { tier: "official" },
  installer: { tier: "official" },
  openapi: { tier: "official" },
  mcp: { tier: "official" },
  seo: { tier: "official" },
  mail: { tier: "official", provides: ["mail@1"] },
  ai: { tier: "official" },
  translations: { tier: "official" },
  stripe: { tier: "official", provides: ["payments@1"] },
  polar: { tier: "official", requires: ["payments@1"] },
  lemonsqueezy: { tier: "official", requires: ["payments@1"] },
  previews: { tier: "official" },
  domains: { tier: "official" },
};

/** the shipped half of the plugin graph, in the shape the removal check reads */
export const shippedFacts = (): PluginFacts[] =>
  SHIPPED.map((name) => ({ name, tier: SHIPPED_FACTS[name].tier, provides: [...(SHIPPED_FACTS[name].provides ?? [])], requires: [...(SHIPPED_FACTS[name].requires ?? [])] }));
