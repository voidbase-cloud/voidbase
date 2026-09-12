import { defineHandler } from "void";

export const GET = defineHandler(async (c) => {
  const row = await c.env.DB.prepare("select count(*) as n from marker").first<{ n: number }>();
  return { marker: row?.n ?? -1 };
});
