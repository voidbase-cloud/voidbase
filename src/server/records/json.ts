import { isMultiple, type Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import type { AuthRecord, Row } from "../types";
import { fromColumn } from "./values";

export interface JSONOptions { auth?: AuthRecord | null; own?: boolean; expand?: Record<string, unknown> }

// The record JSON PocketBase returns: hidden fields dropped, password fields always "", collectionId/Name added,
// keys sorted, email hidden unless emailVisibility, own record, or superuser; `expand` attached when present.
export function recordToJSON(c: Collection, row: Row, opts: JSONOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { collectionId: c.id, collectionName: c.name };
  const superuser = opts.auth?.collection.name === "_superusers";
  for (const f of c.fields as Field[]) {
    if (f.hidden) continue;
    out[f.name] = f.type === "password" ? "" : fromColumn(f, row[f.name]);
    if (f.type === "relation" || f.type === "file" || f.type === "select") {
      if (!isMultiple(f) && Array.isArray(out[f.name])) out[f.name] = (out[f.name] as string[])[0] ?? "";
    }
  }
  if (c.type === "auth" && !superuser && !opts.own && !row.emailVisibility) delete out.email;
  if (opts.expand) out.expand = opts.expand;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
