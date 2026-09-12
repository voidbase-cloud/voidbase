// `@voidbase-cloud/voidbase/sdk`: the core helpers a plugin is written against, in one entry.
//
// A plugin file inside this package reaches them by relative import (`../errors`, `../db`, `../collections/model`).
// A plugin in its own package cannot: a relative path leaves the package, and the specifiers this package resolves
// for itself (`#platform/*`) resolve nowhere outside it. So the names two or more shipped plugins share are
// published once, here, and each is re-exported from the module that declares it — the same module instance an
// instance's own core runs, so a plugin's `ApiError` is the one the error handler catches and its `loadSettings`
// reads the cache the panel already warmed.
//
// The rule for what belongs here: a value that more than one shipped plugin imports from the core, plus the
// siblings of such a value in the same small, general-purpose module (`db`'s `stmt`, `collections/model`'s
// `isView`), because splitting one of four prepared-statement helpers off into an entry of its own would be a
// worse surface, not a smaller one. What one plugin alone uses and is that plugin's own machinery has a narrow
// entry instead (`../entries/auth-routes.ts`, `../entries/hardening-middleware.ts`, `./records-preview`, ...);
// what the core and a plugin hand each other through keeps its own name (`/auth-slot`, `/record-slot`,
// `/realtime-slot`, `/kernel`, `/plugins`, `/interfaces`).
//
// Types live in `@voidbase-cloud/voidbase/types`, which is where `Bindings` is declared and so the module a plugin
// package augments to add its own knobs.

// who is signed in, and the two guards a route uses. Also published as `/auth-slot`, which is where the core fills
// the slot; the same module either way.
//
// This `isSuperuser` is the slot's: it asks whichever plugin provides `auth@1`, so it is still right on an instance
// whose auth provider is not the shipped one. The auth plugin's own answer — the record's collection is
// `_superusers` — is published as `isSuperuserRecord` from `@voidbase-cloud/voidbase/auth-routes`, and is for the
// plugin that provides `auth@1` and nobody else. A plugin package wants this one.
export { isSuperuser, requireAuth, requireSuperuser } from "../auth-slot";

// the API errors the routes throw; the error handler recognises these instances and nothing else
export { ApiError, badRequest, forbidden, notFound } from "../errors";

// D1: a quoted identifier, a prepared statement, and the two reads
export { all, ident, one, stmt } from "../db";

// a transaction that buffers its writes until it commits (plugins/commerce.ts runs an order in one)
export { bufferedTransaction } from "../tx-d1";

// the collections this instance has
export { collectionToJSON, findCollection, isAuth, isView, listCollections, loadCollections, SUPERUSERS } from "../collections/model";
// a collection's deterministic id, and the two writes plugins/collections.ts makes to keep a plugin's own schema
export { collectionId, createCollection, updateCollection } from "../collections/service";
// whether a field holds many values, which decides how it is read and written
export { isMultiple } from "../collections/fields";

// records, through the same path the REST API takes: rules, hooks, files and realtime all run
export { createRecord, deleteRecord, listRecords, PreconditionFailed, updateRecord } from "../records/service";
// a stored row as the values a record has
export { rowToValues } from "../records/values";

// the instance's settings, cached
export { loadSettings } from "../settings";

// this voidbase's version, and a timestamp in the format every table stores
export { VERSION } from "../version";
export { nowString } from "../ids";
