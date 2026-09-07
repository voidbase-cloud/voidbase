// A vb_hooks/ file is one PocketBase hook, registered once when the app mounts. This one is onBootstrap, which has
// no routes/ equivalent: it fires while voidbase is opening the database, before the first request.
import { defineHook, pb } from "@voidbase-cloud/voidbase/adapter";
import { state } from "@/server";

export default defineHook("onBootstrap", async (e) => {
  await e.next();
  state.boots++;
  pb.routerAdd("GET", "/api/from-bootstrap", (ev: { json: (s: number, d: unknown) => unknown }) => {
    state.requests++;
    return ev.json(200, { boots: state.boots, requests: state.requests, lists: state.lists });
  });
});
