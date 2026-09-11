// Where an instance answers: the hostnames a deploy attached to the Worker, and which of them is the real one.
//
// None of that is a property of the server. DNS, certificates and which name is canonical are account-level facts,
// decided around a deploy, and the core holds no opinion about any of it. So the work lives in the plugin's
// deploy-time half (src/node/plugins/domains.ts): it attaches the hostnames, waits for the certificate, redirects
// the rest to the canonical one, and detaches on --remove. What it leaves the Worker is two vars, and all this
// runtime half does is report them on /api/plugins, so an instance can say where it answers.
import { env as voidEnv } from "#platform/env";
import type { Plugin } from "./manifest";

/** the hostnames attached, comma separated, the first canonical: baked by the deploy plugin (and the deploy knob's name) */
export const DOMAINS_VAR = "VOIDBASE_DOMAINS";
/** the canonical hostname, the one every other attached hostname redirects to and the URL the deploy reports */
export const CANONICAL_DOMAIN_VAR = "VOIDBASE_CANONICAL_DOMAIN";

export interface DomainsInfo { hostnames: string[]; canonical: string | null }

/** what GET /api/plugins says in its `domains` field: the vars the deploy baked, or nothing when it attached no hostname */
export const domainsInfo = (env?: object): DomainsInfo => {
  const read = (k: string) => String((env as Record<string, unknown> | undefined)?.[k] ?? (voidEnv as Record<string, unknown>)[k] ?? "").trim().toLowerCase();
  const hostnames = read(DOMAINS_VAR).split(",").map((h) => h.trim()).filter(Boolean);
  return { hostnames, canonical: read(CANONICAL_DOMAIN_VAR) || hostnames[0] || null };
};

export const domains: Plugin = {
  manifest: { name: "domains", version: "0.1.0", tier: "official", voidbase: "*" },
  info: (env) => domainsInfo(env),
};
