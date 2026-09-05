import type { Collection } from "./collections/model";
import type { AuthRecord, Row } from "./types";

// Shape a raw table row into the record JSON PocketBase returns: hidden fields dropped,
// collectionId/collectionName added, keys sorted (PocketBase marshals records as a sorted map),
// email hidden unless emailVisibility, the record is the requester's own, or the requester is a superuser.
export function recordToJSON(c: Collection, row: Row, opts: { auth?: AuthRecord | null; own?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { collectionId: c.id, collectionName: c.name };
  const superuser = opts.auth?.collection.name === "_superusers";
  for (const f of c.fields) {
    if (f.hidden) continue;
    let v = row[f.name];
    if (f.type === "bool") v = !!v;
    else if (f.type === "json" && typeof v === "string") {
      try { v = JSON.parse(v); } catch { /* keep raw */ }
    } else if ((f.type === "select" || f.type === "relation" || f.type === "file") && typeof v === "string" && (f as { maxSelect?: number }).maxSelect !== 1) {
      try { v = JSON.parse(v); } catch { v = v ? [v] : []; }
    } else if (v === null || v === undefined) {
      v = f.type === "number" ? 0 : f.type === "json" ? null : "";
    }
    out[f.name] = v;
  }
  if (c.type === "auth" && !superuser && !opts.own && !row.emailVisibility) out.email = "";
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
