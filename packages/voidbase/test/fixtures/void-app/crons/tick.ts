import { defineScheduled } from "void";

export const cron = "*/5 * * * *";

export default defineScheduled(async (_controller, env) => {
  await env.DB.prepare("insert into outbox (id, `to`) values (?, ?)").bind(crypto.randomUUID(), "cron@example.com").run();
});
