// What this project adds on voidbase's side: PocketBase hooks and routes the Void conventions do not cover.
import type { VoidbaseApp } from "@voidbase-cloud/voidbase";

export function register(app: VoidbaseApp) {
  app.hooks.routerAdd("GET", "/api/from-register", (e: { json: (s: number, d: unknown) => unknown }) => e.json(200, { register: true }));
}
