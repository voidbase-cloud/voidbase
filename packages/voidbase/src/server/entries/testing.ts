// What a plugin's own tests import to stand one up: a kernel, the core plugins it runs beside, a database on bun:sqlite
// with the system collections, and the collection, record and settings services a test drives.
//
// A plugin that lives in a repository of its own (voidbase-stories plugin-repos.feature, 11.3) has no `../../src` to
// reach into, so the names its tests used from the core's internals are published here, each re-exported from the
// module that declares it, so a test's `ApiError` or `load` is the instance's own. An instance never hands this entry to
// a plugin at runtime (src/node/refusals.ts): it is test support, Bun only, and it opens SQLite.
export { provideAuthLookup } from "../auth-slot";
export { provideRecordContext } from "../record-slot";
export { createKernel, load, runAfterRead, runBootstraps } from "../kernel";
export type { Plugin, PluginManifest } from "../plugins/manifest";
export { ApiError } from "../errors";
export { VERSION } from "../version";
export type { AppEnv, AuthRecord, Bindings, Row } from "../types";

// the core plugins a tier 3 plugin is tested beside
export { auth, provider } from "../plugins/auth";
export { observability } from "../plugins/observability";
export { openapiWith } from "../plugins/openapi";

// a database: bun:sqlite as D1, the system collections, and the services over them
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
/** the core's own schema, db/migrations, applied to a bun:sqlite database, the way an instance's first start lays it down */
export function migrateDatabase(sqlite: { run(sql: string): unknown }): void {
  const dir = resolve(import.meta.dir, "../../../db/migrations");
  for (const file of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${dir}/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.run(s);
  }
}
export { d1 } from "../../node/d1";
export { insertCollection } from "../bootstrap";
export type { Field } from "../collections/fields";
export { collectionToJSON, invalidateCollections, listCollections, loadCollections, type Collection } from "../collections/model";
export { createCollection, importCollections, planCreate, prepareCollection, RUNTIME_SYSTEM_FIELDS, updateCollection } from "../collections/service";
export { systemCollections } from "../collections/system";
export { createRecord, deleteRecord, fetchRecord, listRecords, updateRecord, viewRecord, type ListQuery, type RecordContext } from "../records/service";
export { addPreviewField, hasPreviewField, PREVIEW_FIELD, PREVIEW_HEADER, previewOf, visibleInPreview } from "../records/preview";
export { ensureSettingsRow, invalidateSettings, type Settings } from "../settings";
