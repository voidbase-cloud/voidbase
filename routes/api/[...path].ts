// Every /api/* request is handled by the voidbase Hono app (PocketBase wire protocol).
import { defineHandler } from "void";
import { app } from "../../src/server/app";

const handle = defineHandler((c) =>
  app.fetch(c.req.raw, c.env, (c as unknown as { executionCtx?: ExecutionContext }).executionCtx),
);

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
