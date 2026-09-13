import type { Bindings, Collection } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
export { PREVIEW_FIELD, PREVIEW_HEADER, PREVIEW_PARAM } from "@voidbase-cloud/voidbase/records-preview";
export { branchHash, branchSlug, PREVIEW_OF_VAR, PREVIEW_VAR, previewPrefix, previewWorkerName, type PreviewShape } from "@voidbase-cloud/voidbase/plugins/previews-names";
import { type PreviewShape } from "@voidbase-cloud/voidbase/plugins/previews-names";
export interface PreviewsInfo {
    shape: PreviewShape;
    of?: string;
    branch?: string;
}
/**
 * What GET /api/plugins says in its `previews` field. An instance the deploy baked the vars into is a preview
 * instance and says so; every other instance is in flagged mode, because a request carrying the header is all a
 * flagged preview takes. The branches with rows are added by `previewsReport`, which needs the database.
 */
export declare const previewsInfo: (env?: object) => PreviewsInfo;
/** one branch with rows on this instance: how many, and in which collections */
export interface FlaggedBranch {
    branch: string;
    rows: number;
    collections: string[];
}
/** the branches that have rows here, newest count first; empty on an instance nobody has previewed this way */
export declare function flaggedBranches(db: D1Database, collections: Collection[]): Promise<FlaggedBranch[]>;
/** the `previews` field in full: the shape, and in flagged mode the branches with rows */
export declare function previewsReport(env: Bindings): Promise<PreviewsInfo & {
    branches?: FlaggedBranch[];
}>;
/** every row of a branch taken away, collection by collection, with the files those rows owned */
export declare function removeFlagged(env: Bindings, branch: string): Promise<{
    branch: string;
    deleted: Record<string, number>;
    rows: number;
}>;
declare const previews: Omit<Plugin, "manifest">;
export default previews;
