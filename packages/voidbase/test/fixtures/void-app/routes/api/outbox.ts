import { defineHandler } from "void";

export const GET = defineHandler(async (c) => {
  const rows = await c.env.DB.prepare("select `to` from outbox order by `to`").all<{ to: string }>();
  return { outbox: (rows.results ?? []).map((r) => r.to) };
});
