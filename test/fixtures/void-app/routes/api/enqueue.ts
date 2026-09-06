import { defineHandler } from "void";
import { queues } from "void/queues";

export const POST = defineHandler(async (c) => {
  const { to } = (await c.req.json()) as { to: string };
  await queues.mail.send({ to });
  return { queued: to };
});
