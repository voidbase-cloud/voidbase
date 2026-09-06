// Global middleware. Its presence puts the Worker in front of every request (Void's "worker owns HTML" shape),
// and routing.notFound = "none" leaves unmatched requests to us: PocketBase's static serving (src/server/static.ts).
import { defineMiddleware } from "void";
import { staticFallback } from "../src/server/static";

export default defineMiddleware(async (c, next) => {
  await next();
  if (c.res.status !== 404) return;
  const alt = await staticFallback(c.req.raw, (c.env as unknown as { ASSETS?: Fetcher }).ASSETS);
  if (alt) c.res = alt;
});
