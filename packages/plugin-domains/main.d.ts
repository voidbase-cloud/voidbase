import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
export { CANONICAL_DOMAIN_VAR, DOMAINS_VAR } from "@voidbase-cloud/voidbase/plugins/domains-names";
export interface DomainsInfo {
    hostnames: string[];
    canonical: string | null;
}
/** what GET /api/plugins says in its `domains` field: the vars the deploy baked, or nothing when it attached no hostname */
export declare const domainsInfo: (env?: object) => DomainsInfo;
declare const domains: Omit<Plugin, "manifest">;
export default domains;
