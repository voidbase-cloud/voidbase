import { expect, test } from "bun:test";
import { attachJobs, consumeJobs, dispatch, dispatchIfQueued, registerJobHandler, runJob, type Job } from "../../src/server/jobs";
import type { Bindings } from "../../src/server/types";

const ran: Job[] = [];
registerJobHandler("backup", async (_env, job) => { ran.push(job); if (job.name === "boom.zip") throw new Error("disk full"); });
const base = { DB: {} as D1Database, STORAGE: {} as R2Bucket };
const fakeQueue = () => { const sent: unknown[] = []; return { sent, send: async (body: unknown) => { sent.push(body); } }; };

test("dispatch runs inline without a queue binding", async () => {
  ran.length = 0;
  attachJobs(base as Bindings);
  expect(await dispatch({ type: "backup", name: "a.zip" })).toBe("ran");
  expect(ran.map((j) => (j as { name: string }).name)).toEqual(["a.zip"]);
});

test("dispatch queues with a binding, inline forces the immediate path", async () => {
  ran.length = 0;
  const q = fakeQueue(); const env = { ...base, QUEUE_JOBS: q } as Bindings;
  expect(await dispatch({ type: "backup", name: "b.zip" }, { env })).toBe("queued");
  expect(q.sent).toEqual([{ type: "backup", name: "b.zip" }]);
  expect(ran).toEqual([]);
  expect(await dispatch({ type: "backup", name: "c.zip" }, { env, inline: true })).toBe("ran");
  expect(ran.length).toBe(1);
});

test("messages over the queue limit run inline", async () => {
  ran.length = 0;
  const q = fakeQueue(); const env = { ...base, QUEUE_JOBS: q } as Bindings;
  expect(await dispatch({ type: "backup", name: "x".repeat(130_000) }, { env })).toBe("ran");
  expect(q.sent).toEqual([]);
});

test("dispatchIfQueued is a no-op without a queue and swallows send failures", async () => {
  expect(await dispatchIfQueued({ type: "backup", name: "d.zip" }, base as Bindings)).toBe(false);
  const env = { ...base, QUEUE_JOBS: { send: async () => { throw new Error("queue down"); } } } as Bindings;
  expect(await dispatchIfQueued({ type: "backup", name: "d.zip" }, env)).toBe(false);
  const q = fakeQueue();
  expect(await dispatchIfQueued({ type: "backup", name: "e.zip" }, { ...base, QUEUE_JOBS: q } as Bindings)).toBe(true);
  expect(q.sent.length).toBe(1);
});

test("consumeJobs acks successes and retries failures with backoff", async () => {
  ran.length = 0;
  const events: string[] = [];
  const msg = (id: string, name: string, attempts = 1) => ({ id, body: { type: "backup", name } as Job, attempts, ack: () => events.push(`ack ${id}`), retry: (o?: { delaySeconds?: number }) => events.push(`retry ${id} ${o?.delaySeconds}`) });
  const result = await consumeJobs({ messages: [msg("1", "ok.zip"), msg("2", "boom.zip"), msg("3", "boom.zip", 3)] }, base as Bindings, 5);
  expect(result).toEqual({ done: 1, failed: 2 });
  expect(events).toEqual(["ack 1", "retry 2 30", "retry 3 120"]);
});

test("runJob rejects unknown job types", async () => {
  await expect(runJob(base as Bindings, { type: "nope" } as unknown as Job)).rejects.toThrow(/no handler/);
});
