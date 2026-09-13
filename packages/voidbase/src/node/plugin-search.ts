// `voidbase plugins search [query]`: what the marketplaces list, as `voidbase templates` shows templates.
//
// A marketplace's index lists each plugin with its versions; the one that counts is the latest, and what a person
// approved of it is its source commit. Whether a plugin is official or community is its manifest's tier read the way
// the tiers are defined: `core` and `official` are ours, `community` is somebody else's.
import { fetchIndex, pick, type PluginListing } from "./registry";

export interface FoundPlugin {
  name: string;
  title: string;
  summary: string;
  repository: string;
  version: string;
  /** who looks after it: `core` and `official` tiers are official, everything else community */
  standing: "official" | "community";
  /** the commit a person approved for that version, when the listing records one */
  commit: string | null;
  marketplace: string;
}

export const standingOf = (tier: string | undefined): "official" | "community" => (tier === "core" || tier === "official" ? "official" : "community");

/** a listing matches when the query is in its name, title, summary or what it provides; an empty query matches all */
export function matches(listing: PluginListing, provides: string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [listing.name, listing.title ?? "", listing.summary ?? "", ...provides].some((field) => field.toLowerCase().includes(q));
}

export async function searchPlugins(query: string, marketplaces: string[], fetchImpl: typeof fetch = fetch): Promise<{ plugins: FoundPlugin[]; problems: string[] }> {
  const plugins: FoundPlugin[] = []; const problems: string[] = [];
  for (const marketplace of marketplaces) {
    try {
      const { index } = await fetchIndex(marketplace, fetchImpl);
      for (const listing of index.plugins ?? []) {
        const latest = pick(index, listing.name);
        if (!latest) continue;
        const manifest = (latest as { manifest?: { tier?: string; provides?: string[] } }).manifest ?? {};
        if (!matches(listing, manifest.provides ?? [], query)) continue;
        const source = (latest as { source?: { commit?: string } }).source;
        plugins.push({
          name: listing.name, title: listing.title ?? listing.name, summary: listing.summary ?? "", repository: listing.repository,
          version: latest.version, standing: standingOf(manifest.tier), commit: source?.commit ?? null, marketplace,
        });
      }
    } catch (err) { problems.push(err instanceof Error ? err.message : String(err)); }
  }
  return { plugins, problems };
}
