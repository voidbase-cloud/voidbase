// pb_public uploads of a vanilla instance on Cloudflare, served from its bucket (src/server/public-r2.ts). Void hands
// the voidbase app only /api/* (routes/api/[...path].ts), so a page at / never reaches the app's own middleware: this
// runs before Void's router, for every path, and answers only a path someone uploaded.
import { defineMiddleware } from "void";
import { servePublic } from "../src/server/public-r2";
import { rebuildsOnCloudflare } from "../src/server/rebuild/cloudflare";

export default defineMiddleware(async (c, next) => {
  const env = c.env as { STORAGE?: R2Bucket } & Parameters<typeof rebuildsOnCloudflare>[0];
  if (env.STORAGE && rebuildsOnCloudflare(env)) {
    const hit = await servePublic(env.STORAGE, c.req.raw);
    if (hit) return hit;
  }
  await next();
});
