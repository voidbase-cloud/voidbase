import { defineHandler } from "void";
import { storage } from "void/storage";

// storage resolves through Void's runtime env, so this 500s unless the adapter opened that context
export const GET = defineHandler(async (c) => {
  const row = await c.env.DB.prepare("select count(*) as n from _collections").first<{ n: number }>();
  return { collections: row?.n ?? 0, storage: typeof storage.put === "function" };
});
