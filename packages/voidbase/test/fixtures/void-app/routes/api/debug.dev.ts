import { defineHandler } from "void";

// .dev.ts: development only, never in a build
export const GET = defineHandler(() => ({ dev: true }));
