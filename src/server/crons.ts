// Cron registry (apis/cron.go + core built-ins): jobs registered by hooks (cronAdd) plus PocketBase's own
// maintenance jobs. Cloudflare fires crons/every-minute.ts once a minute; runDue matches every job's expression
// against that minute. The superuser API lists jobs and runs one on demand.
import type { Hono } from "hono";
import { logger } from "#platform/log";
import { requireSuperuser } from "./auth";
import { run } from "./db";
import { notFound } from "./errors";
import { crons as hookCrons } from "./hooks/runtime";
import { withHookStore } from "./hooks/migrations";
import { nowString } from "./ids";
import { deleteOldLogs } from "./logs";
import { autoBackup } from "./backups";
import { loadSettings } from "./settings";
import { s3Bucket } from "./storage/s3";
import type { AppEnv } from "./types";

export interface CronJob { id: string; expr: string; fn: (env: AppEnv["Bindings"]) => Promise<unknown> | unknown }

const BUILTIN: CronJob[] = [
  { id: "__pbDBOptimize__", expr: "0 0 * * *", fn: async () => undefined /* D1 maintains itself */ },
  { id: "__pbMFACleanup__", expr: "0 * * * *", fn: async (env) => { await run(env.DB, "DELETE FROM `_mfas` WHERE created < ?", [nowString(new Date(Date.now() - 24 * 3600_000))]); } },
  { id: "__pbOTPCleanup__", expr: "0 * * * *", fn: async (env) => { await run(env.DB, "DELETE FROM `_otps` WHERE created < ?", [nowString(new Date(Date.now() - 24 * 3600_000))]); } },
  { id: "__pbLogsCleanup__", expr: "0 */6 * * *", fn: async (env) => deleteOldLogs(env.DB, (await loadSettings(env.DB)).logs.maxDays) },
  // voidbase: the realtime change feed and stale stream rows only need to survive a few poll intervals
  { id: "__vbChangesCleanup__", expr: "*/10 * * * *", fn: async (env) => { await run(env.DB, "DELETE FROM `_changes` WHERE created < ?", [nowString(new Date(Date.now() - 10 * 60_000))]); await run(env.DB, "DELETE FROM `_realtime_clients` WHERE updated < ?", [nowString(new Date(Date.now() - 6 * 3600_000))]); } },
];

export function allJobs(backupsCron = ""): CronJob[] {
  const fromHooks: CronJob[] = [...hookCrons.entries()].map(([id, j]) => ({ id, expr: j.expr, fn: async () => j.fn() })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const auto: CronJob[] = backupsCron ? [{ id: "__pbAutoBackup__", expr: backupsCron, fn: (env) => autoBackup(env) }] : [];
  // cronsList: user jobs alphabetically, then PocketBase's own jobs in registration order, then voidbase's
  return [...fromHooks, ...BUILTIN, ...auto];
}

export async function runJob(env: AppEnv["Bindings"], job: CronJob): Promise<void> {
  const s3 = (await loadSettings(env.DB)).s3;
  if (s3.enabled) env = { ...env, STORAGE: s3Bucket(s3) };
  try { await withHookStore(env.DB, env, () => job.fn(env)); } catch (err) { logger.error("voidbase: cron job failed", { job: job.id, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }); }
}

// tools/cron matcher for one minute (UTC, like PocketBase)
export function matches(expr: string, date: Date): boolean {
  const macros: Record<string, string> = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };
  const segments = (macros[expr] ?? expr).split(" ");
  if (segments.length !== 5) return false;
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  const bounds: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return segments.every((seg, i) => seg.split(",").some((part) => {
    const [range, stepStr] = part.split("/"); const step = stepStr ? Number(stepStr) : 1;
    let lo = bounds[i]![0], hi = bounds[i]![1];
    if (range !== "*") { const [a, b] = range!.split("-").map(Number); lo = a!; hi = b ?? a!; }
    const v = values[i]!;
    return v >= lo && v <= hi && (v - lo) % step === 0;
  }));
}

export async function runDue(env: AppEnv["Bindings"], date: Date): Promise<string[]> {
  const ran: string[] = [];
  const settings = await loadSettings(env.DB);
  for (const job of allJobs(settings.backups.cron)) if (matches(job.expr, date)) { await runJob(env, job); ran.push(job.id); }
  return ran;
}

export function mountCronsApi(app: Hono<AppEnv>) {
  app.get("/api/crons", async (c) => { requireSuperuser(c); return c.json(allJobs((await loadSettings(c.env.DB)).backups.cron).map((j) => ({ id: j.id, expression: j.expr }))); });
  app.post("/api/crons/:id", async (c) => {
    requireSuperuser(c);
    const job = allJobs((await loadSettings(c.env.DB)).backups.cron).find((j) => j.id === c.req.param("id"));
    if (!job) throw notFound("Missing or invalid cron job");
    c.executionCtx.waitUntil(runJob(c.env, job));
    return c.body(null, 204);
  });
}
