// The flagged preview lane: a preview as a query rather than a deploy.
//
// The previews plugin's first shape gives a branch a whole instance (a Worker with its own database, bucket and
// queue). This is the second shape the roadmap asked for, for the case where an instance is expensive or the data
// matters: the branch shares the production instance, its writes are marked, and production reads do not see them.
//
// The mark is one text column, `_preview`, added to a collection the first time a flagged write reaches it, through
// the collections service so the schema stays one thing and the panel sees it. It is a system field and a hidden
// one, so it is dropped from the API's answers the way every hidden field is, and no client can write it: the value
// comes from the request, never from the body.
//
// The filter is a condition on every read of a collection that has the column. A request with no branch sees only
// the rows whose `_preview` is empty; a request carrying one sees those and its own branch's. It is applied where
// the read's SQL is built (records/service.ts selectSQL, which is behind the list, the count, the view, the write
// path's own fetch and the realtime feed; records/expand.ts's two fetchers for expanded records), so a filter, a
// sort, an expand, a view and the realtime feed cannot disagree about what a row is.
//
// What it cannot do is isolate a change to a row that is already production's. A flagged write that updates a
// production row is a real change to production, so the write path refuses it instead (`refusal`): a preview that
// silently edits production is worse than no preview.
import type { Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import { collectionToJSON } from "../collections/model";
import { updateCollection } from "../collections/service";
import { ident } from "../db";
import type { Row } from "../types";

/** the header a request carries to write and read in a branch's lane */
export const PREVIEW_HEADER = "X-Voidbase-Preview";
/** the same thing as a query parameter, which is what an address can carry without a client that sets headers */
export const PREVIEW_PARAM = "preview";
/** the column the mark lives in */
export const PREVIEW_FIELD = "_preview";
/** a branch name, as loosely as git takes one; anything else is read as no branch at all */
const BRANCH = /^[A-Za-z0-9][\w./-]{0,99}$/;

/** what a read or a write is told about the request it is part of (a subset of the filter's RequestInfo) */
export interface PreviewRequest { headers: Record<string, string>; query: Record<string, string> }

/**
 * The branch this request is in, or "" for production. The header wins over the parameter. Header keys reach here
 * two ways (the records routes lowercase them and turn `-` into `_`, a realtime subscription's options only
 * lowercase them), so both spellings are read. A value that is not a branch name is read as production.
 */
export function previewOf(request: PreviewRequest | undefined): string {
  if (!request) return "";
  const h = request.headers ?? {};
  const raw = String(h.x_voidbase_preview ?? h["x-voidbase-preview"] ?? request.query?.[PREVIEW_PARAM] ?? "").trim();
  return BRANCH.test(raw) ? raw : "";
}

/** whether this collection has a lane at all: no column, nothing to filter and nothing to hide */
export const hasPreviewField = (c: Collection): boolean => (c.fields as Field[]).some((f) => f.name === PREVIEW_FIELD);

/** the field as the collections service takes it: a system, hidden text field, so it is neither answered nor writable */
export const previewFieldDefinition = (): Record<string, unknown> => ({
  name: PREVIEW_FIELD, type: "text", system: true, hidden: true, required: false, presentable: false,
  help: "the preview branch this row belongs to; empty on a production row (the previews plugin)",
});

/**
 * The condition every read of this collection carries, or null when the collection has no lane. A row whose mark is
 * empty is production's and everyone sees it; a row with a mark is seen only by a request in that branch.
 */
export function previewScope(c: Collection, branch: string, table = c.name): { sql: string; params: unknown[] } | null {
  if (!hasPreviewField(c)) return null;
  const col = `${ident(table)}.${ident(PREVIEW_FIELD)}`;
  const own = `(${col} = '' OR ${col} IS NULL)`;
  return branch ? { sql: `(${own} OR ${col} = ?)`, params: [branch] } : { sql: own, params: [] };
}

/** the same judgement on a row already in hand, for the realtime feed's delete events (the row is gone from the table) */
export function visibleInPreview(c: Collection, row: Row, branch: string): boolean {
  if (!hasPreviewField(c)) return true;
  const mark = String(row[PREVIEW_FIELD] ?? "");
  return mark === "" || mark === branch;
}

/** the branch a stored row belongs to, "" for production's */
export const markOf = (row: Row): string => String(row[PREVIEW_FIELD] ?? "");

/**
 * Add the column, through the collections service so the `_collections` row, the table and the panel agree. Returns
 * the collection as it now is. Called only on the first flagged write to a collection, so an instance nobody
 * previews never grows a column.
 */
export async function addPreviewField(db: D1Database, c: Collection): Promise<Collection> {
  const json = collectionToJSON(c);
  const fields = [...((json.fields as Record<string, unknown>[]) ?? []), previewFieldDefinition()];
  return updateCollection(db, c, { fields });
}

/** the collections that have a lane (views left out: a view stores no rows of its own) */
export const flaggedCollections = (collections: Collection[]): Collection[] =>
  collections.filter((c) => c.type !== "view" && hasPreviewField(c));

/** whether the lane applies at all: never to a system collection, never to a view, which stores no rows of its own */
export const previewable = (c: Collection): boolean => !c.system && c.type !== "view";

/** why a flagged write to a row that is not the branch's is refused, said in full */
export const refusal = (op: "update" | "delete", collection: string, id: string, branch: string): string =>
  `Failed to ${op} record. ${JSON.stringify(id)} in ${JSON.stringify(collection)} is not a row of the preview ${JSON.stringify(branch)}, ` +
  `and a flagged preview cannot isolate a change to a row production already has: the write would change production itself. ` +
  `Create the row under the preview header instead, or give the branch an instance of its own ` +
  `(voidbase deploy --preview ${branch} --shape instance).`;
