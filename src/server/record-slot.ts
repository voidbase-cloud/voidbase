// What the core builds for a plugin that needs the request's record context, and whom it asks.
//
// A plugin that reads records the way the API reads them (the auth routes' OAuth2 and flow handlers, seo's lookup
// of the record behind a page) needs the RecordContext app.ts builds per request: the database, the storage, who is
// asking, the collections. Both used to reach it with `await import("../app")` at request time, which is the whole
// application module graph imported by a plugin the application itself depends on — inside one package a cycle the
// bundler tolerates, and once these plugins are packages of their own, a package importing the app that loads it.
// So the core hands the capability over the way it hands over auth (auth-slot.ts): app.ts fills the slot once the
// plugins are loaded, and a plugin asks for a context whenever it has a request to build one from. Asked per
// request rather than held, because a context is the request's and nothing else's.
import type { Context } from "hono";
import type { RecordContext } from "./records/service";
import type { AppEnv } from "./types";

let build: ((c: Context<AppEnv>) => Promise<RecordContext>) | undefined;

/** app.ts: how to build the record context for a request */
export function provideRecordContext(fn: (c: Context<AppEnv>) => Promise<RecordContext>): void { build = fn; }

/** the record context for this request, as the core's own record routes build it */
export function recordContextFor(c: Context<AppEnv>): Promise<RecordContext> {
  if (!build) throw new Error("voidbase: nothing has filled the record context slot (src/server/record-slot.ts), which app.ts does when it loads the plugins");
  return build(c);
}

/**
 * For tests only: empty the slot again. `bun test` runs every file in one process and this is a module global, so
 * a file that fills the slot with a stub of its own has to put it back, or the stub outlives the file and the next
 * test to reach the slot gets it (test/unit/plugin-slot-restored.test.ts is the file that checks it did).
 * Nothing in a running instance calls this: app.ts fills the slot once, before the app serves anything.
 */
export function resetRecordContext(): void { build = undefined; }
