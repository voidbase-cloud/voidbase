// The version an instance is running, so the loader can refuse a plugin that does not fit it.
//
// Baked at build time rather than read at runtime: on Workers there is no filesystem to read package.json from,
// and the version has to be a constant the bundle carries. A JSON import is how the bundler is told that.
import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = (pkg as { version: string }).version;
