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

/** how the core builds the record context of one request; what fills the slot */
export type RecordContextBuilder = (c: Context<AppEnv>) => Promise<RecordContext>;

let build: RecordContextBuilder | undefined;

/**
 * app.ts: how to build the record context for a request. Answers what was in the slot before this call, so that a
 * caller that is borrowing the slot rather than filling it for good can put back exactly what it took
 * (`restoreRecordContext`). app.ts ignores the answer: it fills the slot once, and nothing empties it after.
 */
export function provideRecordContext(fn: RecordContextBuilder): RecordContextBuilder | undefined {
  const previous = build;
  build = fn;
  return previous;
}

/** the record context for this request, as the core's own record routes build it */
export function recordContextFor(c: Context<AppEnv>): Promise<RecordContext> {
  if (!build) throw new Error("voidbase: nothing has filled the record context slot (src/server/record-slot.ts), which app.ts does when it loads the plugins");
  return build(c);
}

/** what is in the slot, or nothing when nothing has filled it: for whoever has to check that a borrow was given back */
export const recordContextBuilder = (): RecordContextBuilder | undefined => build;

/**
 * For tests only: put back what `provideRecordContext` answered. `bun test` runs every file in one process and this
 * is a module global, so a file that fills the slot with a stub of its own has to give back what was there — not
 * empty the slot, which is what this used to do: app.ts fills the slot at module scope, so a file that ran after
 * anything imported app.ts was clearing the application's own builder and leaving the next file with nothing.
 * Whether that mattered depended only on the order bun walked the directory in
 * (test/unit/plugin-slot-restored.test.ts is the file that checks the slot holds no test's stub).
 * Nothing in a running instance calls this: app.ts fills the slot once, before the app serves anything.
 */
export function restoreRecordContext(previous: RecordContextBuilder | undefined): void { build = previous; }
