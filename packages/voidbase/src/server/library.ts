// `@voidbase-cloud/voidbase` inside a Worker. An extended project is an entry file that loads voidbase and hands it
// the pb_ folders (`const app = await voidbase({...}); app.router.get(...); await app.start()`), and a deploy imports
// that same file into the Worker (src/node/cloud-init.ts). There the instance is already the Worker: the pb_ folders
// were bundled by the hooks plugin, the data is D1 and the server is Cloudflare's. So `voidbase()` hands back the
// Worker's own app API, where whatever the entry registers lands, and `start()` has nothing left to start.
// The hooks plugin resolves the bare package name to this file for every importer but a plugin bundle
// (hooks-plugin.ts), so the Bun library entry (src/node/index.ts), which opens SQLite files, never reaches a Worker.
import { appApi, type VoidbaseApp } from "./api";
import type { ServeOptions } from "../node/serve";

export type { VoidbaseApp, HookGlobals } from "./api";
export type { ServeOptions } from "../node/serve";
export { RequestEvent } from "./hooks/runtime";
export { HookRecord, CollectionRef } from "./hooks/record";

export interface VoidbaseServer { server: undefined; env: undefined; stop: () => void }

export async function voidbase(opts: ServeOptions = {}): Promise<VoidbaseApp & { env: undefined; dir: string; start: () => Promise<VoidbaseServer> }> {
  return { ...appApi(), env: undefined, dir: opts.dir ?? "pb_data", start: async () => ({ server: undefined, env: undefined, stop() {} }) };
}

export async function serve(opts: ServeOptions = {}): Promise<VoidbaseServer> {
  return (await voidbase(opts)).start();
}

/** the flags are the Worker's configuration on Cloudflare, so there are none to parse */
export function parseServeArgs(_argv?: string[]): ServeOptions { return {}; }

export async function openLocal(): Promise<never> {
  throw new Error("openLocal opens a data directory on this machine; on Cloudflare the instance's data is its D1 database");
}
