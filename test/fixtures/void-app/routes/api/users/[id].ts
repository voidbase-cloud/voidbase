import { defineHandler } from "void";

// [id] must reach the handler as a normal Hono route param
export const GET = defineHandler((c) => ({ id: c.req.param("id") }));
