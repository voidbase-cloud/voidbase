// `@voidbase-cloud/voidbase/records-preview`: the preview flag as the previews plugin reads it.
//
// plugins/previews.ts names the field and the two ways a request asks for a branch, and it lists the collections
// that carry the flag. The rest of ../records/preview.ts — the scope SQL, `visibleInPreview`, `addPreviewField`,
// the refusal text — is what the records service itself runs on every read and write of a flagged collection, and
// publishing it would hand a plugin the core's own query building for no use anyone has.
export { PREVIEW_FIELD, PREVIEW_HEADER, PREVIEW_PARAM, flaggedCollections } from "../records/preview";
