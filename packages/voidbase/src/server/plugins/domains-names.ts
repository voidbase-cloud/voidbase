// Not a plugin: the names the domains plugin and `voidbase deploy` agree on, so that the deploy can attach hostnames and
// bake them without importing what the plugin does. The domains plugin is a tier 3 plugin an instance has because
// someone installed it (voidbase-stories plugin-kinds.feature); these stay in the core for the reason
// /plugins/ai-binding does.

/** the hostnames attached, comma separated, the first canonical: baked by the deploy (and the deploy knob's name) */
export const DOMAINS_VAR = "VOIDBASE_DOMAINS";
/** the canonical hostname, the one every other attached hostname redirects to and the URL the deploy reports */
export const CANONICAL_DOMAIN_VAR = "VOIDBASE_CANONICAL_DOMAIN";
