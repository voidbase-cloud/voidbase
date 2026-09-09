// Background jobs: outbound mail and automatic backups. On Cloudflare a Queue carries them
// (binding QUEUE_JOBS, declared by queues/jobs.ts) with at-least-once delivery and retries; without the binding
// (the Bun runtime, or a deploy whose token could not create the queue) `dispatch` runs the job inline instead.
// Handlers register themselves from the module that owns the work, so this module stays free of heavy imports.
import { logger } from "#platform/log";
import type { MailMessage } from "./mail/message";
import type { Bindings } from "./types";
import { resolveSecretBindings } from "./secrets-store";

export type Job =
  | { type: "mail"; message: MailMessage; text: string }
  | { type: "backup"; name: string }
  // a message for one of the app's own queues (a Void app's queues/<name>.ts, mounted by src/adapter)
  | { type: "queue"; queue: string; body: unknown };
export type JobHandler<T extends Job = Job> = (env: Bindings, job: T) => Promise<void>;

const handlers = new Map<Job["type"], JobHandler>();
export function registerJobHandler<T extends Job["type"]>(type: T, fn: JobHandler<Extract<Job, { type: T }>>): void { handlers.set(type, fn as JobHandler); }

// the bindings of the last bootstrap on this isolate (Workers hand every request the same binding objects)
let attached: Bindings | undefined;
export function attachJobs(env: Bindings): void { attached = env; }
// Void names the binding after the consumer file: QUEUE_JOBS for queues/jobs.ts (this checkout), QUEUE_<WORKER>_JOBS for
// the queues/<worker>-jobs.ts a deploy writes (queue names are account-wide, so each app gets its own)
export function jobQueue(env: Bindings | undefined): Bindings["QUEUE_JOBS"] | undefined {
  if (!env) return undefined;
  if (env.QUEUE_JOBS) return env.QUEUE_JOBS;
  const key = Object.keys(env).find((k) => /^QUEUE_[A-Z0-9_]*JOBS$/.test(k));
  return key ? (env as unknown as Record<string, Bindings["QUEUE_JOBS"]>)[key] : undefined;
}
export const jobsQueued = (): boolean => !!jobQueue(attached);

const MAX_MESSAGE_BYTES = 120_000; // Cloudflare Queues: 128 KB per message, ~100 bytes of it metadata

export async function runJob(env: Bindings, job: Job): Promise<void> {
  const fn = handlers.get(job.type);
  if (!fn) throw new Error(`voidbase: no handler for job "${job.type}"`);
  await fn(env, job);
}

/** Queues the job when a queue is attached (and the message fits), otherwise runs it now. `inline` forces the
 * immediate path so the caller sees delivery errors (the panel's test email, hooks' mail client). */
export async function dispatch(job: Job, opts: { env?: Bindings; inline?: boolean } = {}): Promise<"queued" | "ran"> {
  const env = opts.env ?? attached;
  const queue = jobQueue(env) ?? jobQueue(attached);
  if (!opts.inline && queue && JSON.stringify(job).length <= MAX_MESSAGE_BYTES) { await queue.send(job); return "queued"; }
  if (!env) throw new Error("voidbase: jobs have no bindings (attachJobs was never called)");
  await runJob(env, job);
  return "ran";
}

/** Queue-only: for work that is an optimization and is simply skipped without a queue. */
export async function dispatchIfQueued(job: Job, env: Bindings | undefined = attached): Promise<boolean> {
  const queue = jobQueue(env);
  if (!queue) return false;
  try { await queue.send(job); return true; } catch (err) { logger.warn("voidbase: queue send failed", { job: job.type, error: err instanceof Error ? err.message : String(err) }); return false; }
}

export interface QueuedMessage { id: string; body: Job; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void }
export interface JobBatch { queue?: string; messages: QueuedMessage[] }

/** The queue consumer: runs every message, retries failures with backoff (30 s, 60 s, ... up to 15 min) and logs the
 * ones Cloudflare is about to drop after `maxRetries` (the consumer file's export). */
export async function consumeJobs(batch: JobBatch, env: Bindings, maxRetries = 5): Promise<{ done: number; failed: number }> {
  await resolveSecretBindings(env as unknown as Record<string, unknown>);
  attachJobs(env);
  let done = 0, failed = 0;
  for (const msg of batch.messages) {
    try { await runJob(env, msg.body); msg.ack(); done++; }
    catch (err) {
      failed++;
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const dropping = msg.attempts > maxRetries;
      logger.error(dropping ? "voidbase: job dropped after its last retry" : "voidbase: job failed, will retry", { job: msg.body.type, id: msg.id, attempt: msg.attempts, error });
      if (dropping) await alertWebhook({ message: `job ${msg.body.type} dropped after ${msg.attempts} attempts`, job: msg.body.type, id: msg.id, error });
      msg.retry({ delaySeconds: Math.min(900, 30 * 2 ** Math.max(0, msg.attempts - 1)) });
    }
  }
  return { done, failed };
}

// VOIDBASE_ALERT_WEBHOOK_URL: the same receiver the request error handler posts to
export async function alertWebhook(fields: Record<string, unknown>): Promise<void> {
  const { env } = await import("#platform/env");
  const webhook = String((env as Record<string, unknown>).VOIDBASE_ALERT_WEBHOOK_URL ?? "").trim();
  if (!webhook) return;
  await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "voidbase", level: "error", time: new Date().toISOString(), ...fields }) }).catch(() => undefined);
}
