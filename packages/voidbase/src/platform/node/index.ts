// `@voidbase-cloud/voidbase/platform` on Bun: the runtime env and the logger, the two platform picks nearly
// every plugin makes. Inside this package these are `#platform/env` and `#platform/log`, which resolve only here;
// a plugin in its own package imports this name and gets the same two files under the same `default` condition.
//
// Only the two that are free to load. `#platform/email` and `#platform/raster` are published one entry each
// (`/platform/email`, `/platform/raster`) because raster's workerd half imports ~2.4 MB of wasm and is reached by a
// dynamic import on the first card for exactly that reason, and email is `cloudflare:email`, which exists on
// workerd alone. `#platform/plugins` is published nowhere: on Bun it *is* the loader that imports plugin bundles,
// and a bundle cannot import the module that is importing it.
export { defaultLogMinLevel, env } from "./env";
export { logger } from "./log";
