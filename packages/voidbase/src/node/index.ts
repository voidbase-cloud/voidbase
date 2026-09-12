// voidbase as a library (Bun): PocketBase's server as a process you compose in your own main.ts.
export { voidbase, serve, parseServeArgs, openLocal, type ServeOptions, type VoidbaseServer } from "./serve";
export type { VoidbaseApp, HookGlobals } from "../server/api";
export { RequestEvent } from "../server/hooks/runtime";
export { HookRecord, CollectionRef } from "../server/hooks/record";
