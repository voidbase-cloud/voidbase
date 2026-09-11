// Host-scoped redirects as zone Redirect Rules (Rulesets API, phase http_request_dynamic_redirect).
//
// One rule per entry, tagged in its description so a redeploy replaces exactly its own rules and leaves the zone's
// other redirect rules alone: `voidbase:<worker>:<source>` for the lines of a project's `_redirects`, and
// `voidbase:<worker>:@<scope>:<source>` for a set a plugin owns (the domains plugin's canonical redirects), so the
// two sets on one zone never replace each other. Needs the zone permission Single Redirect (edit) on the deploy
// token ("Dynamic URL Redirects Write" in the API's permission listing, next to the DNS permission the token may
// already carry for the zone). Without it the deploy logs the rules to create by hand and carries on.
import { CfApi, findZone } from "../cloud/rest";
import type { RedirectEntry } from "./cloud-init";

const quote = (v: string) => JSON.stringify(v);
type Rule = Record<string, unknown>;

/** the description prefix a set's rules carry: the worker's `_redirects` set, or a plugin's scoped set */
export const ruleTag = (worker: string, scope?: string): string => `voidbase:${worker}:${scope ? `@${scope}:` : ""}`;
/** whether a rule on the zone belongs to this set: the scoped one, or the unscoped one (which never claims a scoped rule) */
export const ownsRule = (worker: string, scope: string | undefined, description: unknown): boolean => {
  const d = String(description ?? "");
  return scope ? d.startsWith(ruleTag(worker, scope)) : d.startsWith(ruleTag(worker)) && !d.slice(ruleTag(worker).length).startsWith("@");
};

export function redirectRule(worker: string, r: RedirectEntry, scope?: string): Rule {
  const wildcard = r.path.endsWith("/*"); const prefix = wildcard ? r.path.slice(0, -1) : r.path; // "/docs/*" -> "/docs/"
  const expression = wildcard ? (prefix === "/" ? `(http.host eq ${quote(r.host!)})` : `(http.host eq ${quote(r.host!)} and starts_with(http.request.uri.path, ${quote(prefix)}))`) : `(http.host eq ${quote(r.host!)} and http.request.uri.path eq ${quote(r.path)})`;
  const absolute = (to: string) => (/^https?:\/\//.test(to) ? to : `https://${r.host}${to.startsWith("/") ? "" : "/"}${to}`);
  const splat = r.to.includes(":splat");
  const target_url = splat
    ? { expression: `concat(${quote(absolute(r.to).replace(":splat", "").replace(/\/$/, ""))}, ${prefix === "/" ? "http.request.uri.path" : `substring(http.request.uri.path, ${prefix.length - 1})`})` }
    : { value: absolute(r.to) };
  return { description: `${ruleTag(worker, scope)}${r.source}`, expression, action: "redirect", action_parameters: { from_value: { status_code: r.status, target_url, preserve_query_string: true } }, enabled: true };
}

const entrypoint = (zone: string) => `/zones/${zone}/rulesets/phases/http_request_dynamic_redirect/entrypoint`;
const why = (e: unknown) => (e instanceof Error && e.message === "permission" ? "the token lacks the zone permission Single Redirect > Edit (API name: Dynamic URL Redirects Write) for the zone" : e instanceof Error ? e.message : String(e));

/** the zone's redirect rules as they are, or "permission" thrown when the token may not read them */
async function currentRules(api: CfApi, zone: string): Promise<Rule[]> {
  const cur = await api.raw("GET", entrypoint(zone)); const body = await cur.text();
  if (cur.status === 403 || cur.status === 401) throw new Error("permission");
  return cur.ok ? ((JSON.parse(body) as { result?: { rules?: Rule[] } }).result?.rules ?? []) : [];
}

/** every entry's zone, found once; entries whose host no zone on the account covers are logged and skipped */
async function byZone(api: CfApi, account: string, worker: string, entries: RedirectEntry[], scope: string | undefined, log: (l: string) => void): Promise<Map<string, { zone: { id: string; name: string }; rules: Rule[] }>> {
  const out = new Map<string, { zone: { id: string; name: string }; rules: Rule[] }>();
  for (const r of entries) {
    const zone = await findZone(api, r.host!, account);
    if (!zone) { log(`redirect ${r.source}: no zone on the account covers ${r.host}, rule skipped`); continue; }
    const slot = out.get(zone.id) ?? { zone, rules: [] }; slot.rules.push(redirectRule(worker, r, scope)); out.set(zone.id, slot);
  }
  return out;
}

/** set this worker's rules (of one set) on the zones the entries name, replacing the set's previous rules and nothing else */
export async function applyZoneRedirects(api: CfApi, account: string, worker: string, entries: RedirectEntry[], log: (l: string) => void, scope?: string): Promise<void> {
  for (const { zone, rules } of (await byZone(api, account, worker, entries, scope, log)).values()) {
    try {
      const kept = (await currentRules(api, zone.id)).filter((x) => !ownsRule(worker, scope, x.description));
      await api.json("PUT", entrypoint(zone.id), { rules: [...kept, ...rules] });
      log(`zone ${zone.name}: ${rules.length} redirect rule(s) set (${rules.map((x) => String(x.description).slice(ruleTag(worker, scope).length)).join(", ")})`);
    } catch (e) {
      log(`zone ${zone.name}: redirect rules not set (${why(e)}). Add that permission to the token and deploy again, or create them under Rules > Redirect Rules:\n${rules.map((x) => `  ${x.expression} -> ${JSON.stringify((x.action_parameters as { from_value: { target_url: unknown } }).from_value.target_url)}`).join("\n")}`);
    }
  }
}

/** remove this worker's rules (of one set) from the zones the hosts belong to, leaving every other rule as it is */
export async function clearZoneRedirects(api: CfApi, account: string, worker: string, hosts: string[], log: (l: string) => void, scope?: string): Promise<void> {
  const zones = new Map<string, { id: string; name: string }>();
  for (const h of hosts) { const zone = await findZone(api, h, account); if (zone) zones.set(zone.id, zone); }
  for (const zone of zones.values()) {
    try {
      const current = await currentRules(api, zone.id);
      const kept = current.filter((x) => !ownsRule(worker, scope, x.description));
      if (kept.length === current.length) continue;
      await api.json("PUT", entrypoint(zone.id), { rules: kept });
      log(`zone ${zone.name}: ${current.length - kept.length} redirect rule(s) removed`);
    } catch (e) {
      log(`zone ${zone.name}: redirect rules not removed (${why(e)}); remove the rules tagged ${ruleTag(worker, scope)} under Rules > Redirect Rules`);
    }
  }
}
