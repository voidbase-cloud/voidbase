// Global middleware. Its presence also puts the Worker in front of every request (Void "worker owns HTML" shape),
// so the SPA fallback to /index.html happens after our routes: unknown /api paths stay JSON 404s, exactly like
// PocketBase, while the app's client-side routes still boot from index.html. Request logging lands here later.
import { defineMiddleware } from "void";

export default defineMiddleware(async (_c, next) => {
  await next();
});
