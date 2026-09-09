// Cloudflare Flagship, for the flags an app declares (define.ts `flag(...)`).
//
// A flag is a boolean the app reads at request time, changed in the dashboard without a deploy. The deploy makes
// sure the account has a Flagship app named after the Worker and that every declared flag exists in it with its
// declared default (a flag that exists is left alone: the dashboard's word wins over the code's default), binds
// the app to the Worker as FLAGS, and bakes the defaults as vars so the code has an answer where Flagship is
// not reachable. src/server/flags.ts evaluates them per request.
import type { CfApi } from "../cloud/rest";

export const FLAGS_BINDING = "FLAGS";
/** the var the defaults travel in, so a Worker knows which keys to evaluate and what to answer without Flagship */
export const FLAGS_VAR = "VOIDBASE_FLAGS";

const guide = (e: unknown): never => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/10000|401|403|Authentication error|not authorized|permission/i.test(msg)) throw new Error(`${msg}\n  Flagship needs the deploy token to carry "Flagship: Write" (account); add it and try again, or leave the flags to their baked defaults.`);
  throw e;
};

interface App { id: string; name: string }
interface Flag { key: string }

async function pages<T>(api: CfApi, path: string): Promise<T[]> {
  const out: T[] = []; let cursor = "";
  for (let i = 0; i < 50; i++) {
    const r = await api.json<T[]>("GET", `${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`).catch(guide);
    out.push(...(r.result ?? []));
    cursor = String((r as { result_info?: { cursor?: string } }).result_info?.cursor ?? "");
    if (!cursor) break;
  }
  return out;
}

/** the Flagship app named after the Worker; created when missing (not in a dry run) */
export async function ensureFlagshipApp(api: CfApi, account: string, name: string, dryRun = false): Promise<{ id: string; created: boolean }> {
  const found = (await pages<App>(api, `/accounts/${account}/flagship/apps`)).find((a) => a.name === name);
  if (found) return { id: found.id, created: false };
  if (dryRun) return { id: "", created: true };
  const r = await api.json<App>("POST", `/accounts/${account}/flagship/apps`, { name }).catch(guide);
  return { id: r.result.id, created: true };
}

/** every declared flag exists in the app; an existing one is left as the dashboard has it. Returns the keys created. */
export async function ensureFlags(api: CfApi, account: string, app: string, flags: { key: string; description?: string; fallback: boolean }[], dryRun = false): Promise<string[]> {
  const have = new Set(app ? (await pages<Flag>(api, `/accounts/${account}/flagship/apps/${app}/flags`)).map((f) => f.key) : []);
  const missing = flags.filter((f) => !have.has(f.key));
  if (dryRun) return missing.map((f) => f.key);
  for (const f of missing) {
    await api.json("POST", `/accounts/${account}/flagship/apps/${app}/flags`, { key: f.key, description: (f.description ?? "").slice(0, 512), enabled: true, default_variation: f.fallback ? "on" : "off", variations: { on: true, off: false } }).catch(guide);
  }
  return missing.map((f) => f.key);
}
