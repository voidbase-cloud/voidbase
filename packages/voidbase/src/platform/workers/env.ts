export { env } from "void/env";
// on Cloudflare every request log is a billed D1 row: only warnings and errors by default (VOIDBASE_LOG_MIN_LEVEL overrides)
export const defaultLogMinLevel = 4;
