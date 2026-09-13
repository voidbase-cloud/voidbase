// Telling voidbase Workers apart by asking them. `voidbase instances --cloudflare` used to list the Workers voidbase had
// tagged when it deployed them, which is the deploy's memory of what it did rather than what is running. Now it asks
// each Worker on the account its /api/health: a voidbase instance answers with its version and plugins (every caller
// gets that since this change), and anything else simply does not, so it is not listed.
import { workersSubdomain, type CfApi } from "../cloud/rest";

/**
 * `kind` is what the Worker's tags say it was made from: `vanilla` when it carries `voidbase-release:<version>` (an
 * instance provisioned from a release), `extended` when it carries none (a project deployed with voidbase deploy),
 * and `unknown` when the tags could not be read, rather than a guess.
 */
export interface FoundInstance { name: string; url: string; version: string; plugins: string[]; kind: "vanilla" | "extended" | "unknown" }

/** what a health answer says about voidbase, or null when it is not a voidbase answer */
export function voidbaseOf(body: unknown): { version: string; plugins: string[] } | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as { data?: { voidbase?: unknown } }).data?.voidbase;
  if (!v || typeof v !== "object") return null;
  const { version, plugins } = v as { version?: unknown; plugins?: unknown };
  if (typeof version !== "string" || !Array.isArray(plugins)) return null;
  return { version, plugins: plugins.filter((p): p is string => typeof p === "string") };
}

/** every Worker on the account that answers as voidbase on its workers.dev address, asked in parallel */
export async function probeWorkers(api: CfApi, account: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<{ instances: FoundInstance[]; subdomain: string | null; asked: number }> {
  const scripts = await api.json<{ id: string }[]>("GET", `/accounts/${account}/workers/scripts`);
  const subdomain = await workersSubdomain(api, account);
  if (!subdomain) return { instances: [], subdomain: null, asked: 0 };
  const names = (scripts.result ?? []).map((s) => s.id);
  const answers = await Promise.all(names.map(async (name) => {
    const url = `https://${name}.${subdomain}.workers.dev`;
    try {
      const res = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const found = res.ok ? voidbaseOf(await res.json()) : null;
      if (!found) return null;
      // what it was made from is on the Worker, not in its answer: the tag a release upload sets, or none
      let kind: FoundInstance["kind"] = "unknown";
      try {
        const settings = await api.json<{ tags?: string[] | null }>("GET", `/accounts/${account}/workers/scripts/${name}/settings`);
        kind = (settings.result?.tags ?? []).some((t) => t.startsWith("voidbase-release:")) ? "vanilla" : "extended";
      } catch { kind = "unknown"; }
      return { name, url, ...found, kind };
    } catch { return null; }
  }));
  return { instances: answers.filter((a): a is FoundInstance => a !== null), subdomain, asked: names.length };
}
