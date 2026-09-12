// Realtime, as the plugin that provides `realtime@1`.
//
// One plugin, not two. The plan first had hub fanout and the D1 change feed as two providers chosen by composition,
// and building it showed why that is the wrong shape here: nobody installs a hub. It is a deployment detail, so the
// choice belongs to the binding, and the binding arrives with the request. What this provides is therefore a
// factory: `for(env)` returns the client for this request, and callers ask it `active()` before choosing the feed.
import { realtimeFor } from "../realtime/hub-client";
import type { Realtime } from "../interfaces";
import { serve, type Kernel } from "../kernel";
import type { Plugin } from "./manifest";

export const realtime: Plugin = {
  manifest: {
    name: "realtime",
    version: "0.1.0",
    tier: "official",
    voidbase: "*",
    provides: ["realtime@1"],
  },
  apply(ctx: Kernel) {
    serve<Realtime>(ctx, "realtime@1", { for: realtimeFor });
  },
};
