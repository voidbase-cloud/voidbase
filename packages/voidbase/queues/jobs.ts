// Cloudflare Queue consumer for voidbase's background jobs: outbound mail and automatic backups.
// Its presence gives the Worker the QUEUE_JOBS producer binding; without this file every job runs
// inline in the request (the Bun runtime always does). Retries: up to maxRetries with backoff, then dropped and alerted.
import { defineQueue } from "void";
import "../src/server/app"; // registers the job handlers (mail, backups, thumbnails) and the hooks
import { consumeJobs, type Job } from "../src/server/jobs";

export const maxBatchSize = 10;
export const maxBatchTimeout = 1; // seconds: mail should leave promptly
export const maxRetries = 5;
export const retryDelay = 30;

export default defineQueue<Job>(async (batch, env) => { await consumeJobs(batch as never, env as never, maxRetries); });
