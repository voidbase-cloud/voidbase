// Backups, as a plugin. The first feature to leave the core, because almost nothing depends on it.
//
// The feature itself is unchanged and still lives in the core, behind one published name. app.ts used to import
// `mountBackupsApi` and call it, so the routes existed because a line in app.ts said so and app.ts was the only
// place that knew backups existed. Now it mounts itself onto the app the kernel handed it, and app.ts says only
// that backups are among the plugins this instance runs.
//
// It owns no collections and provides no interface: it reads whatever is there. That is what makes it the right
// first one, and also what makes it a poor test of the parts of the loader that matter most.
//
// What the core's backups module does now (docs/plugins.md, "Backups worth relying on"): two archive kinds (`full`,
// the whole instance with its settings and schema; `data`, the non-system collections' rows and files), each read
// back and verified after the write, restorable per kind, copied to an off-site S3 bucket when VOIDBASE_BACKUP_S3_*
// are set, and a scheduled write shaped by VOIDBASE_BACKUP_KIND and VOIDBASE_BACKUP_KEEP. Still no collections of
// its own.
//
// The file is the one that sat in `packages/voidbase/src/server/plugins/backups.ts`, with its three relative imports
// written as the three published names they already resolved to: `../backups`, `../kernel` and `./manifest` become
// `@voidbase-cloud/voidbase/backups-api`, `/kernel` and `/plugins`. `/backups-api` is the narrow entry 7.2 published
// for exactly this plugin -- `mountBackupsApi` and nothing else of the module behind it, which also writes the
// archives the scheduled job and the restore read.
import { mountBackupsApi } from "@voidbase-cloud/voidbase/backups-api";
import type { Kernel } from "@voidbase-cloud/voidbase/kernel";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";

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
