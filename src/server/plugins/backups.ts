// Backups as a plugin: the leaf half of the kernel experiment.
//
// The feature is unchanged and still lives in ../backups.ts. What changes is how it arrives. Today app.ts imports
// `mountBackupsApi` and calls it, so the routes exist because a line in app.ts says so and app.ts is the only place
// that knows backups exist. Here the plugin mounts itself onto the app the kernel handed it, and app.ts says only
// that backups are among the plugins this instance runs.
//
// Backups is the right leaf to try first because almost nothing depends on it: crons calls autoBackup, app.ts
// mounts the routes, and that is all. Its own imports point the other way, into auth, collections, db, hooks, jobs,
// settings and storage, which is what makes it a plugin rather than a service: it consumes and provides nothing.
import { mountBackupsApi } from "../backups";
import type { Kernel } from "../kernel";

export const name = "backups";

export function apply(ctx: Kernel) {
  mountBackupsApi(ctx.app);
}
