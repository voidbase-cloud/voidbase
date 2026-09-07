// Void's own middleware: every request, in file order. The adapter registers it through PocketBase's routerUse,
// which is the same thing. A PocketBase hook is a different shape and lives in vb_hooks/.
import { defineMiddleware } from "void";

export default defineMiddleware(async (c, next) => {
  c.set("mwOrder", [...((c.get("mwOrder") as string[]) ?? []), "01"]);
  await next();
});
