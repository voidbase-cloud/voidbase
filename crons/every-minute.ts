// Cloudflare cron trigger: once a minute, run every registered cron job whose expression matches this minute
// (PocketBase's own maintenance jobs, voidbase's change-feed cleanup, and cronAdd jobs from pb_hooks).
import { defineScheduled } from "void";
import "../src/server/app"; // loads the pb_hooks so their cronAdd registrations exist
import { runDue } from "../src/server/crons";

export const cron = "* * * * *";

export default defineScheduled(async (controller, env) => {
  const ran = await runDue(env as never, new Date(controller.scheduledTime));
  if (ran.length) console.log(`voidbase: cron ran ${ran.join(", ")}`);
});
