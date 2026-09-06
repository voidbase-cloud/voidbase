import { defineHandler } from "void";

export const POST = defineHandler(async (c) => ({ echoed: await c.req.json() }));
