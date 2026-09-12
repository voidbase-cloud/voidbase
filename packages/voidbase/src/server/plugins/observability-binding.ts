// The names the deploy and the observability plugin agree on: data, so src/node/deploy-cf.ts can turn the Worker's
// own observability on and bake the knobs the plugin reads without importing what the plugin does (the kernel, the
// routes, D1, the SQL client).
/** the Analytics Engine binding the deploy declares with `--analytics`; the plugin samples the request path into it */
export const ANALYTICS_BINDING = "LOGS_ANALYTICS";
/** the knob: on unless it says off, because the plugin is core and this is the thing that makes it useful */
export const OBSERVABILITY_VAR = "VOIDBASE_OBSERVABILITY";
/** how much is sampled, 0 to 1: the Worker's `head_sampling_rate` and the plugin's own rate, one number for both */
export const SAMPLE_VAR = "VOIDBASE_OBSERVABILITY_SAMPLE";
/** the account the summary queries; unset, the deploy's own `VOIDBASE_ACCOUNT_ID` answers */
export const ACCOUNT_VAR = "VOIDBASE_OBSERVABILITY_ACCOUNT_ID";
/** an API token with Account Analytics Read. A secret, never a var: unset, the summary reads the D1 request log */
export const TOKEN_VAR = "VOIDBASE_OBSERVABILITY_TOKEN";
/** the dataset to query, when it is not the one this Worker's name derives */
export const DATASET_VAR = "VOIDBASE_OBSERVABILITY_DATASET";
/** vars `voidbase deploy` already bakes, which is why the plugin needs neither of the two above to find its dataset */
export const WORKER_NAME_VAR = "VOIDBASE_WORKER_NAME";
export const ACCOUNT_ID_VAR = "VOIDBASE_ACCOUNT_ID";

const OFF = /^(0|false|off|no)$/i;

/** whether the knob is on: unset means on, `0`/`false`/`off`/`no` mean off */
export function observabilityOn(value: string | undefined): boolean {
  const v = String(value ?? "").trim();
  return !v || !OFF.test(v);
}

/** the sampling rate a knob value means: a number in 0..1, or 1 when it says nothing usable */
export function sampleRateOf(value: string | undefined): number {
  const v = String(value ?? "").trim();
  if (!v) return 1;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(1, n);
}

/** the Analytics Engine dataset a Worker's name means; the deploy names it, the plugin queries it */
export const analyticsDataset = (worker: string): string => `${worker.replace(/-/g, "_")}_requests`;

/**
 * The Worker's `observability` field, as Cloudflare's configuration documents it today (checked 2026-09-11):
 * `enabled` persists the Worker's logs and `head_sampling_rate` is a number between 0 and 1
 * (https://developers.cloudflare.com/workers/wrangler/configuration/). Invocation logs, which carry the request
 * and the response of every invocation, are on by default and only need `observability.logs.invocation_logs =
 * false` to turn off (https://developers.cloudflare.com/workers/observability/logs/workers-logs/), so nothing here
 * writes them.
 */
export const workerObservability = (rate: number): { enabled: true; head_sampling_rate: number } => ({ enabled: true, head_sampling_rate: rate });
