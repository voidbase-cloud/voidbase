// Registered into Node with `--import`: lets Node load this package's TypeScript from under node_modules.
//
// Node strips types on its own, but refuses to under node_modules, and resolves nothing without an extension.
// Void's deploy runs project code with Node (the env schema probe, the Vite config, drizzle-kit's schema load), and
// an installed voidbase is TypeScript under node_modules with Bun-style extensionless imports. voidbase deploy sets
// NODE_OPTIONS=--import <this file> on the `void deploy` it spawns, and every Node child inherits it.
import { register } from "node:module";

register("./ts-loader-hooks.mjs", import.meta.url);
