// Backups, as a plugin. The first feature to leave the core, because almost nothing depends on it.
//
// The feature itself is unchanged and still lives in ../backups.ts. What changes is how it arrives: app.ts used to
// import `mountBackupsApi` and call it, so the routes existed because a line in app.ts said so and app.ts was the
// only place that knew backups existed. Now it mounts itself onto the app the kernel handed it, and app.ts says
// only that backups are among the plugins this instance runs.
//
// It owns no collections and provides no interface: it reads whatever is there. That is what makes it the right
// first one, and also what makes it a poor test of the parts of the loader that matter most.
import { mountBackupsApi } from "../backups";
import type { Kernel } from "../kernel";
import type { Plugin } from "./manifest";

export const backups: Plugin = {
  manifest: {
    name: "backups",
    version: "0.1.0",
    tier: "official",
    voidbase: "*",
  },
  apply(ctx: Kernel) {
    mountBackupsApi(ctx.app);
  },
};
