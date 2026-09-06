// Cloudflare cron trigger. Hourly here (PocketBase's maintenance and settings.backups.cron are caught up to an hour late);
// `voidbase deploy` generates a project whose triggers are the hooks' own cronAdd expressions plus this hourly tick.
// `runDue` runs every job that became due since the previous tick.
import { defineScheduled } from "void";
import "../src/server/app"; // loads the pb_hooks so their cronAdd registrations exist
import { runDue } from "../src/server/crons";

export const cron = "0 * * * *";

export default defineScheduled(async (controller, env) => {
  const ran = await runDue(env as never, new Date(controller.scheduledTime));
  if (ran.length) console.log(`voidbase: cron ran ${ran.join(", ")}`);
});
