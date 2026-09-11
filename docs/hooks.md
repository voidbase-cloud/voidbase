# JS hooks and migrations

voidbase runs PocketBase's `pb_hooks/*.pb.js` and `pb_migrations/*.js` files with the same globals. The
difference is *when* they load: the files are bundled into the Worker at build time (`hooks-plugin.ts`), so a
hook change needs a rebuild and redeploy, not a restart. Directories are configured with `VOIDBASE_HOOKS_DIR`
and `VOIDBASE_MIGRATIONS_DIR` (defaults `pb_hooks`, `pb_migrations`).

## Writing hooks

Hook code is written exactly as for PocketBase. Because `$app.*`, `$http.send`, `$filesystem.*` and mail
calls are asynchronous on Workers, the bundler rewrites the file so each of those calls is awaited and the
enclosing function becomes async; `e.next()` is awaited too. Ordinary synchronous-looking PocketBase code works
unchanged. `require("./other.js")` resolves against the hooks directory bundle.

The rewrite follows names. A call to a function the file declares is awaited once that function has become async,
but a function handed over as a value and called through a parameter is not: in `run("seed", seedRecords)`, the
`fn()` inside `run` gets no `await`, so its errors escape a `try` around it and the writes it started are cut off when
the handler returns. Call such functions directly. The demo's hourly reset was written the other way for one hour on
2026-09-11, and it saved one record, lost the rest, and reported no failure. `compileHooksDir(dir)` in
`hooks-plugin.ts` returns the rewritten source, which is the quick way to see which calls got their `await`.

```js
/// <reference path="../pb_data/types.d.ts" />
routerAdd("GET", "/api/hello", (e) => {
  return e.json(200, { hello: e.auth?.email() ?? "guest" });
}, $apis.requireAuth());

onRecordCreateRequest((e) => {
  e.record.set("slug", e.record.get("title").toLowerCase().replaceAll(" ", "-"));
  e.next();
}, "posts");

cronAdd("digest", "0 8 * * *", () => {
  const users = $app.findRecordsByFilter("users", "verified = true", "-created", 100, 0);
  $app.logger().info("digest", "count", users.length);
});
```

## Events

Every `on*` function registers a handler; `e.next()` runs the remaining handlers and then the core action.
Throwing an `ApiError` subclass (`BadRequestError`, `ForbiddenError`, `NotFoundError`, `UnauthorizedError`,
`InternalServerError`, `ValidationError`) answers the request with that error. Handlers accept optional
collection-name tags as trailing arguments.

| Family | Events |
| --- | --- |
| App | `onBootstrap`, `onServe` (both once per isolate on its first request), `onSettingsReload` |
| Records (model) | `onRecordEnrich`, `onRecordValidate`, `onRecord{Create,Update,Delete}`, `onRecord{Create,Update,Delete}Execute`, `onRecordAfter{Create,Update,Delete}{Success,Error}`, and the `onModel*` equivalents |
| Records (request) | `onRecordsListRequest`, `onRecordViewRequest`, `onRecord{Create,Update,Delete}Request` |
| Auth (request) | `onRecordAuthRequest`, `onRecordAuthWithPasswordRequest`, `onRecordAuthWithOAuth2Request`, `onRecordAuthWithOTPRequest`, `onRecordAuthRefreshRequest`, `onRecordRequestOTPRequest`, `onRecordRequest{Verification,PasswordReset,EmailChange}Request`, `onRecordConfirm{Verification,PasswordReset,EmailChange}Request` |
| Collections | `onCollectionValidate`, `onCollection{Create,Update,Delete}`, `onCollectionAfter{Create,Update,Delete}{Success,Error}`, `onCollectionsListRequest`, `onCollectionViewRequest`, `onCollection{Create,Update,Delete}Request`, `onCollectionsImportRequest` |
| Files | `onFileDownloadRequest` (`e.servedName` editable), `onFileTokenRequest` |
| Realtime | `onRealtimeConnectRequest`, `onRealtimeSubscribeRequest` (`e.subscriptions` editable), `onRealtimeMessageSend` (`e.message` editable) |
| Settings | `onSettingsListRequest` (`e.settings` editable), `onSettingsUpdateRequest` (`e.oldSettings`, `e.newSettings`) |
| Mail | `onMailerSend`, `onMailerRecord{AuthAlert,PasswordReset,Verification,EmailChange,OTP}Send` |
| Batch | `onBatchRequest` (`e.batch` editable) |
| Registered, never fired | `onTerminate`, `onBackupCreate`, `onBackupRestore` |

Request events expose the PocketBase `RequestEvent` surface: `e.auth`, `e.request`, `e.requestInfo()`,
`e.pathParam(name)`, `e.bindBody(obj)`, `e.json(status, data)`, `e.string`, `e.html`, `e.noContent`,
`e.redirect`, `e.next()`.


### The app's own schema

`$app` carries PocketBase's schema methods, which an app that ships its own collections uses at runtime:

| call | what it does |
| --- | --- |
| `$app.importCollections(list, deleteMissing)` | create or update every collection in the list; with `deleteMissing` the ones it does not name are dropped |
| `$app.importCollectionsByMarshaledJSON(json, deleteMissing)` | the same, from a JSON string |
| `$app.truncateCollection(collection)` | delete every record of a collection (and its files); a view has none to delete |
| `$app.findPluginCollections(...types)` | voidbase's own: the collections the loaded plugins own (their manifests name them) that exist here, of those types if any are named |
| `record.setPassword(value)` | set an auth record's password; `$app.save()` then asks for no confirmation, as PocketBase's `app.Save` does |

With `deleteMissing`, `importCollections` drops only the collections the caller manages: the system collections and
every collection a loaded plugin owns stay, because the plugin owns that schema and creates it once per isolate.
Deleting one of those is a deliberate `DELETE /api/collections/:name`, not a sweep; clearing its rows is
`findPluginCollections` and `truncateCollection`.

The list is the schema as the app wrote it, so a system field voidbase adds to a collection at runtime is kept when
the list leaves it out. Today that is `_preview`, the flagged preview lane's mark ([plugins.md](./plugins.md)), which a
collection gains on its first flagged write. The import keeps the column and the rows' marks in it, where it used to
refuse the list from then on as deleting a system field. A definition that names such a field is judged like any
other, so renaming or retyping it is refused. `id` and an auth collection's `password`, `tokenKey`, `email`,
`emailVisibility` and `verified` are never carried over: left out, they are put back from PocketBase's defaults, and
the import is refused (`validation_system_field_change`) when those do not match the stored field.

Together they are enough for an app to restore itself, the rows its plugins keep included:

```js
// pb_hooks/reset.pb.js
const data = require(`${__hooks}/data.js`);
cronAdd("reset", "0 * * * *", () => {
  $app.importCollections(data.COLLECTIONS, true);        // whatever was added is gone; what plugins own stays
  for (const c of data.NAMES) $app.truncateCollection($app.findCollectionByNameOrId(c));
  for (const c of $app.findPluginCollections("base", "auth")) if (!c.system) $app.truncateCollection(c); // their rows
  data.seed();                                            // records, users, whatever the app ships with
});
```

### Transactions

`$app.runInTransaction(fn)` runs `fn` as one unit of work. What that is worth depends on which database the
instance is on.

On the **Durable Object database** (`VOIDBASE_DATABASE=durable`) it is a real transaction. The writes `fn` makes
are collected and sent as one batch when `fn` returns, and the object runs a batch inside
`ctx.storage.transactionSync`: all of them land or none do. `fn` throwing rolls everything back, by never sending
it, and rethrows. Realtime events the writes announced are held until the batch commits, so a transaction that
rolled back announces nothing.

On **D1** there is no transaction and nothing has changed: `fn` is called directly with `$app`, and a throw halfway
leaves behind whatever it had already written. A hook can ask which one it is getting:

```js
if ($app.transactionsAreReal()) { /* runInTransaction is all or nothing here */ }
```

**Buffered writes, and a read of your own uncommitted write inside the transaction is not visible.** That is the
price of the only honest mechanism there is, and it is not hidden. A Durable Object can hold a transaction open
only inside a single RPC: `ctx.storage.transactionSync` takes a callback that must be synchronous, and `sql.exec`
refuses `BEGIN TRANSACTION` and `SAVEPOINT` outright ("use the state.storage.transaction() or
state.storage.transactionSync() APIs instead"), so the one batch at the end is the only place the transaction can
exist. Rather than quietly answer a stale row, a read of a table this transaction has already written to throws:

```js
$app.runInTransaction((txApp) => {
  const post = new Record(txApp.findCollectionByNameOrId("posts"), { title: "hello" });
  txApp.save(post);                        // held, not written
  txApp.findRecordById("posts", post.id);  // throws: `posts` has uncommitted writes in this transaction
});
```

| inside a transaction you can | you cannot |
| --- | --- |
| `$app.save()` a new record, and use what it hands back: that is the row that was written, not a read of it | read any table the transaction has already written to. `findRecordById`, `findRecordsByFilter`, `countRecords`, a filter or an expand over it all throw |
| `$app.delete()` a record the transaction has not written | `$app.save()` an existing record or `$app.delete()` a record the transaction has already written: both read it first |
| read anything the transaction has not written to | run a statement with `RETURNING`, whose rows exist only once the batch commits |
| write to as many collections as you like | nest transactions: an inner `runInTransaction` throws rather than silently flatten into the outer one |

Do the reads first and the writes last and none of that is in the way. Unique indexes are still enforced, just at
the commit rather than at the call: two records in one transaction that clash leave nothing behind, and the
`UNIQUE constraint failed` error is what `runInTransaction` throws.

## Globals

| Global | Supported members |
| --- | --- |
| `$app` | `findCollectionByNameOrId`, `findAllCollections`, `findPluginCollections`, `findRecordById`, `findFirstRecordByData`, `findFirstRecordByFilter`, `findRecordsByFilter`, `findAuthRecordByEmail`, `findAuthRecordByToken`, `countRecords`, `expandRecord(s)`, `save`, `saveNoValidate`, `delete`, `runInTransaction` (a real transaction on the Durable Object database, a plain call on D1: see Transactions), `transactionsAreReal`, `settings()`, `isDev()`, `logger()`, `newMailClient()`, `dao()` (raw SQL, D1 limits apply) |
| `$apis` | `requireAuth`, `requireSuperuserAuth`, `requireGuestOnly`, `requireSuperuserOrOwnerAuth`, `enrichRecord(s)` |
| `$http` | `send({url, method, body, headers, timeout})` |
| `$filesystem` | `fileFromURL`, `fileFromBytes`; `fileFromPath` throws (no filesystem) |
| `$security` | `randomString`, `randomStringWithAlphabet`, `pseudorandomString`, `sha256` |
| `$os` | `getenv` (Worker env vars), `readFile` (files bundled from the hooks directory), `writeFile`, `args`; `cmd`/`exec` throw |
| `$dbx` | `exp`, `hashExp` |
| `$mails`, `$template` | placeholders: `$template.loadFiles(...).render()` returns `""`. Build mail bodies as strings and send them with `$app.newMailClient().send(new MailerMessage({...}))` |
| Classes | `Record`, `Collection`, `RecordUpsertForm`, `MailerMessage`, `DateTime`, `RequestInfo`, `Field` and the typed field classes (`TextField`, `RelationField`, ...) |
| Registration | `routerAdd`, `routerUse`, `cronAdd`, `cronRemove`, `migrate` |

## Migrations

`pb_migrations/*.js` files written by PocketBase's automigrate (`new Collection({...})`, `app.save`,
`app.findCollectionByNameOrId`, `collection.fields.addAt`, `unmarshal`) run unchanged. Pending migrations are
applied on the first request after a deploy, in file order, and recorded in `_pbMigrations`. The down
function is kept for parity but there is no CLI to run it; roll back by deploying a new migration.

## Testing hooks locally

`bun test/fresh-db.ts` builds the Worker with `test/fixtures/hooks` and `test/fixtures/migrations`, boots
`vp preview` on an empty D1 and checks the hook side effects end to end. Point it at your own hooks with
`VOIDBASE_HOOKS_DIR` / `VOIDBASE_MIGRATIONS_DIR`, or run `./scripts/dev.sh start 5180` and edit `pb_hooks/`:
the dev server rebuilds the hooks bundle on save.
