// Realtime, as the plugin that provides `realtime@1` — and as the first plugin that is a package of its own.
//
// One plugin, not two. The plan first had hub fanout and the D1 change feed as two providers chosen by composition,
// and building it showed why that is the wrong shape here: nobody installs a hub. It is a deployment detail, so the
// choice belongs to the binding, and the binding arrives with the request. What this provides is therefore a
// factory: `for(env)` returns the client for this request, and callers ask it `active()` before choosing the feed.
//
// The file is the one that sat in `packages/voidbase/src/server/plugins/realtime.ts`, with its four relative
// imports written as the four published names they already resolved to. That is the whole of what extraction is:
// a plugin package may import `@voidbase-cloud/voidbase` and nothing else of the core, because a relative path out
// of this directory would reach the consumer's node_modules and a `#platform/*` pick is package-private. The core
// still ships `@voidbase-cloud/voidbase/plugins/realtime`, as a re-export of this package, and always will:
// marketplace bundles are immutable and import that name.
import { realtimeFor } from "@voidbase-cloud/voidbase/realtime-client";
import type { Realtime } from "@voidbase-cloud/voidbase/interfaces";
import { serve, type Kernel } from "@voidbase-cloud/voidbase/kernel";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";

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
