// The domains plugin's deploy-time half: the first deploy plugin (src/node/deploy-plugin.ts).
//
// From VOIDBASE_DOMAINS (or VOIDBASE_DEPLOY_DOMAIN, the older name, still read; `--domain` is the flag form): a
// comma-separated list of hostnames whose zones are on the account, the first of which is canonical. Before the
// upload it validates them, turns workers.dev off, bakes the list and the canonical name as vars for the runtime
// half (src/server/plugins/domains.ts) and claims the URL the deploy reports. After the upload it attaches each
// hostname through the Workers Custom Domains API (Cloudflare adds the DNS record and issues the certificate),
// waits for that certificate to be active (up to 90 seconds, and says where it got), and sets a zone Redirect Rule
// per non-canonical hostname sending everything under it, 301, to the same path on the canonical one. On
// `voidbase deploy --remove` it detaches every hostname pointing at the Worker and deletes those rules.
import { attachCustomDomain, listCustomDomains, type CfApi, type CustomDomain } from "../../cloud/rest";
import { CANONICAL_DOMAIN_VAR, DOMAINS_VAR, domains } from "../../server/plugins/domains";
import type { RedirectEntry } from "../cloud-init";
import type { DeployPlugin } from "../deploy-plugin";
import { applyZoneRedirects, clearZoneRedirects } from "../zone-redirects";

/** the knob: the same name as the var it bakes, so the shell's value and the Worker's are one thing */
export const DOMAINS_KNOB = DOMAINS_VAR;
/** the knob's older name, from when the deploy did this itself; still read, the newer one wins when both are set */
export const LEGACY_KNOB = "VOIDBASE_DEPLOY_DOMAIN";
/** the tag scope of the plugin's redirect rules on a zone (src/node/zone-redirects.ts): `voidbase:<worker>:@domains:<host>` */
export const SCOPE = "domains";
/** how long `after` waits for a hostname's certificate before carrying on */
export const CERTIFICATE_WAIT_MS = 90_000;
const POLL_MS = 3_000;
const HOSTNAME = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** the hostnames the knobs name, cleaned (scheme and path dropped, lowercased); the first is canonical; none when unset */
export function hostnamesOf(env: Record<string, string | undefined>): string[] {
  return String(env[DOMAINS_KNOB] || env[LEGACY_KNOB] || "").split(",").map((d) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase()).filter(Boolean);
}
export function validateHostnames(hosts: string[]): void {
  for (const d of hosts) if (!HOSTNAME.test(d)) throw new Error(`invalid custom domain "${d}"`);
}
/** the redirect a non-canonical hostname gets: everything under it, permanently, to the same path on the canonical one */
export const canonicalRedirect = (host: string, canonical: string): RedirectEntry => ({ source: host, host, path: "/*", to: `https://${canonical}/:splat`, status: 301, line: 0 });

/**
 * The certificate's standing for an attached hostname, as far as the token can see. The domain object carries the
 * certificate's id (`cert_id`, once issued) and nothing about its state; the state is on the zone's certificate
 * packs (GET /zones/<zone>/ssl/certificate_packs), which the token reads with SSL and Certificates Read. Returns
 * the pack's status ("active" is the one that matters), "not issued yet", or "unreadable" when the token may not.
 */
export async function certificateStatus(api: CfApi, account: string, d: Pick<CustomDomain, "id" | "hostname" | "zone_id">): Promise<string> {
  const fresh = await api.json<{ cert_id?: string }>("GET", `/accounts/${account}/workers/domains/${d.id}`).then((r) => r.result).catch(() => ({} as { cert_id?: string }));
  const r = await api.raw("GET", `/zones/${d.zone_id}/ssl/certificate_packs?status=all`); const body = await r.text();
  if (r.status === 401 || r.status === 403) return "unreadable";
  if (!r.ok) return `unknown (HTTP ${r.status})`;
  const packs = ((JSON.parse(body) as { result?: { id?: string; hosts?: string[]; status?: string }[] }).result ?? []);
  const covers = (h: string) => h === d.hostname || (h.startsWith("*.") && d.hostname.endsWith(h.slice(1)));
  const pack = (fresh.cert_id && packs.find((p) => p.id === fresh.cert_id)) || packs.find((p) => (p.hosts ?? []).some(covers));
  return pack?.status ?? "not issued yet";
}

/** poll until the certificate is active, the token turns out unable to read it, or the budget is spent; the last status seen */
export async function waitForCertificate(api: CfApi, account: string, d: Pick<CustomDomain, "id" | "hostname" | "zone_id">, budgetMs = CERTIFICATE_WAIT_MS, pollMs = POLL_MS): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await certificateStatus(api, account, d);
    const left = deadline - Date.now();
    if (status === "active" || status === "unreadable" || left <= 0) return status;
    await Bun.sleep(Math.min(pollMs, left));
  }
}

export const domainsDeploy: DeployPlugin = {
  name: "domains",
  manifest: domains.manifest,
  deploy: {
    async before(ctx) {
      const hosts = hostnamesOf(ctx.env); if (!hosts.length) return;
      validateHostnames(hosts);
      const canonical = hosts[0]!; const others = hosts.slice(1);
      ctx.config.workers_dev = false;
      ctx.vars[DOMAINS_VAR] = hosts.join(","); ctx.vars[CANONICAL_DOMAIN_VAR] = canonical;
      ctx.url = `https://${canonical}`;
      const plan = ctx.local ? "nothing to attach on this machine" : `attached through the Workers Custom Domains API after the upload (Cloudflare adds the DNS record and certificate)${others.length ? `; ${others.join(", ")} redirect${others.length === 1 ? "s" : ""} to ${canonical} (301)` : ""}`;
      ctx.log(`custom domain${hosts.length > 1 ? "s" : ""} ${hosts.join(", ")} (workers.dev off): ${plan}`);
    },
    async after(ctx) {
      const hosts = hostnamesOf(ctx.env); if (!hosts.length || ctx.local || !ctx.api) return;
      const { api, log } = ctx; const account = ctx.account.id; const canonical = hosts[0]!; const others = hosts.slice(1);
      if (ctx.dryRun) { log(`dry run: would attach ${hosts.join(", ")} to ${ctx.name}, wait for ${hosts.length === 1 ? "its" : "each"} certificate${others.length ? ` and set ${others.length} redirect rule(s) to ${canonical}` : ""}`); return; }
      for (const host of hosts) {
        const d = await attachCustomDomain(api, account, { hostname: host, service: ctx.name });
        log(`custom domain ${d.hostname} ${d.created ? "attached" : "already attached"} (zone ${d.zone_id})`);
        const status = await waitForCertificate(api, account, d);
        if (status === "active") log(`certificate for ${d.hostname}: active`);
        else if (status === "unreadable") log(`certificate for ${d.hostname}: not checked (the token cannot read the zone's certificates: SSL and Certificates Read); Cloudflare issues it within a minute or two`);
        else log(`certificate for ${d.hostname}: ${status} after ${Math.round(CERTIFICATE_WAIT_MS / 1000)} s; Cloudflare is still issuing it, and the hostname answers once it is active`);
      }
      if (others.length) await applyZoneRedirects(api, account, ctx.name, others.map((h) => canonicalRedirect(h, canonical)), log, SCOPE);
    },
    async remove(ctx) {
      const hosts = hostnamesOf(ctx.env); const { api, log } = ctx;
      if (!api) { if (hosts.length) log("custom domains: nothing to detach on this machine"); return; }
      const attached = await listCustomDomains(api, ctx.account.id, { service: ctx.name });
      const zonesOf = [...new Set([...attached.map((d) => d.hostname), ...hosts])];
      if (!zonesOf.length) return;
      if (ctx.dryRun) { log(`dry run: would detach ${attached.map((d) => d.hostname).join(", ") || "no custom domain (none attached)"} from ${ctx.name} and remove its redirect rules on the zone(s) of ${zonesOf.join(", ")}`); return; }
      for (const d of attached) { await api.json("DELETE", `/accounts/${ctx.account.id}/workers/domains/${d.id}`); log(`custom domain ${d.hostname} detached`); }
      await clearZoneRedirects(api, ctx.account.id, ctx.name, zonesOf, log, SCOPE);
    },
  },
};
