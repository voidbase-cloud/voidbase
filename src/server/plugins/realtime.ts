// The hub half of the experiment, and the thing it got wrong first.
//
// The plan was `inject: { hub: false }`, meaning "use the hub if it is there, fall back to the D1 change feed if it
// is not". cordis has no such declaration. Its Inject type maps a service name to that service's *config*, so every
// entry is required: a plugin either has what it injected or does not run at all. The first version of this file
// injected the hub optionally, and without a HUB binding it silently never loaded.
//
// The pattern that replaces it is better than the conditional it would have replaced. Hub fanout and the change
// feed are two implementations of one thing, so they become two plugins that provide the same service name, and
// composition picks between them by whether the binding exists. Nothing downstream branches: records injects
// `realtime` and cannot tell which one it got. That is the shape voidbase would have to take, and it means
// `if (hubActive())` in records/service.ts and realtime/index.ts is not a line to move but a fork to split.
//
// This plugin is the smaller half of that: it provides nothing and only reports what the kernel resolved, which is
// enough to see the mechanism working end to end without rewriting the realtime path for a spike.
import type { Kernel } from "../kernel";

export const name = "realtime-kernel-probe";

export function apply(ctx: Kernel) {
  ctx.app.get("/api/_kernel", (c) =>
    c.json({
      plugins: ["backups", "realtime-kernel-probe"],
      hub: "hub" in ctx ? "provided as a service" : "not registered: bindings arrive per request, not at module scope",
    }),
  );
}
