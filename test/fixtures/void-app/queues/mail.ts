import { defineQueue } from "void";

export default defineQueue(async (batch, env) => {
  for (const message of batch.messages) {
    const { to } = message.body as { to: string };
    await env.DB.prepare("insert into outbox (id, `to`) values (?, ?)").bind(crypto.randomUUID(), to).run();
  }
});
