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
| `record.setPassword(value)` | set an auth record's password; `$app.save()` then asks for no confirmation, as PocketBase's `app.Save` does |

Together they are enough for an app to restore itself:

```js
// pb_hooks/reset.pb.js
const data = require(`${__hooks}/data.js`);
cronAdd("reset", "0 * * * *", () => {
  $app.importCollections(data.COLLECTIONS, true);        // whatever was added is gone
  for (const c of data.NAMES) $app.truncateCollection($app.findCollectionByNameOrId(c));
  data.seed();                                            // records, users, whatever the app ships with
});
```

## Globals

| Global | Supported members |
| --- | --- |
| `$app` | `findCollectionByNameOrId`, `findAllCollections`, `findRecordById`, `findFirstRecordByData`, `findFirstRecordByFilter`, `findRecordsByFilter`, `findAuthRecordByEmail`, `findAuthRecordByToken`, `countRecords`, `expandRecord(s)`, `save`, `saveNoValidate`, `delete`, `runInTransaction` (runs the callback directly), `settings()`, `isDev()`, `logger()`, `newMailClient()`, `dao()` (raw SQL, D1 limits apply) |
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
