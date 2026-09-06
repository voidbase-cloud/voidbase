import { defineMiddleware } from "void";

export default defineMiddleware(async (c, next) => {
  c.set("mwOrder", [...((c.get("mwOrder") as string[]) ?? []), "02"]);
  await next();
});
