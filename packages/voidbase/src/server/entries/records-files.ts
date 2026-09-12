// `@voidbase-cloud/voidbase/records-files`: the one file call a plugin makes.
//
// plugins/previews.ts deletes a discarded preview record's files with it. The rest of ../records/files.ts is the
// storage layer the records service owns — `putUpload`, `deleteFiles`, `fileKey`, and `deletePrefix`, which empties
// everything under a prefix and would empty the bucket if it were handed an empty one. None of it is something a
// plugin asks for, so the entry is this call and not the module.
export { deleteAllRecordFiles } from "../records/files";
