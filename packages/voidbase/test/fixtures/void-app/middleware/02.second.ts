import { defineMiddleware } from "void";

export default defineMiddleware(async (c, next) => {
  c.set("mwOrder", [...((c.get("mwOrder") as string[]) ?? []), "02"]);
  await next();
  // proves routerUse wraps every request, not only the app's own routes
  c.res.headers.set("x-void-middleware", "all");
});
