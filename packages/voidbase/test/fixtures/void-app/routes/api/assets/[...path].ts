import { defineHandler } from "void";

export const GET = defineHandler((c) => ({ path: c.req.param("path") }));
