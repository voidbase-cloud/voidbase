import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const outbox = sqliteTable("outbox", {
  id: text("id").primaryKey(),
  to: text("to").notNull(),
});
