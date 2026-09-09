// Bundles the Void app's server code into one file that a pb_hooks sandbox can run.
//
// A hook file has no module resolution: its `require` reaches only its sibling hook files, and nothing else. Void's
// routes import npm packages (`void/response`, `void/db`, Drizzle), so they have to arrive pre-bundled. Two details
// make that work:
//   - `node:async_hooks` cannot be bundled and cannot be required at runtime inside the sandbox, so the build
//     rewrites it to read `globalThis.AsyncLocalStorage`, which voidbase's hook runtime publishes on both runtimes
//     (src/server/hooks/runtime.ts);
//   - the output carries the `// voidbase:raw` pragma, which tells the hook compiler to leave it alone instead of
//     running the await-insertion transform over it (hooks-plugin.ts).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BunPlugin } from "bun";

export const RAW_PRAGMA = "// voidbase:raw";

// A hook cannot require a node builtin: the sandbox resolves only its sibling hook files. Two are handled here and
// anything else fails the build, loudly, rather than at the first request.
const ASYNC_HOOKS_SHIM = `const g = globalThis;
if (!g.AsyncLocalStorage) throw new Error("voidbase: AsyncLocalStorage is missing; the hook runtime publishes it");
export const AsyncLocalStorage = g.AsyncLocalStorage;
export default { AsyncLocalStorage };`;
// Bun's CommonJS output opens with an unused \`require("node:module")\` for interop; an empty module satisfies it.
const MODULE_SHIM = `export const createRequire = () => { throw new Error("voidbase: createRequire is not available inside a hook"); };
export default { createRequire };`;

const builtinShims: BunPlugin = {
  name: "voidbase-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^(node:)?async_hooks$/ }, () => ({ path: "async_hooks", namespace: "voidbase-shim" }));
    build.onResolve({ filter: /^(node:)?module$/ }, () => ({ path: "module", namespace: "voidbase-shim" }));
    build.onResolve({ filter: /^node:/ }, (args) => {
      throw new Error(`voidbase: ${args.path} cannot be used in code compiled into pb_hooks (imported by ${args.importer}). A hook has no module resolution, so nothing reachable from routes/, middleware/, crons/ or queues/ may import a node builtin.`);
    });
    build.onLoad({ filter: /.*/, namespace: "voidbase-shim" }, (args) => ({
      contents: args.path === "async_hooks" ? ASYNC_HOOKS_SHIM : MODULE_SHIM,
      loader: "js",
    }));
  },
};

/**
 * The aliases the bundle needs, which Vite would otherwise apply:
 *  - `void` itself resolves to the package entry, which carries the Vite plugin and its Cloudflare dependency. A
 *    route only ever wants the runtime half, so it is rewritten to `void/handler`.
 *  - the tsconfig paths Void generates (`@schema`, and the shims this adapter points `void/db` and `void/queues`
 *    at) are compiler-only, so the bundler is told about them explicitly.
 */
const CODE_EXT = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
// the bare "" comes first so `@schema` -> db/schema.ts wins over a `db/schema/` directory, but an alias whose target
// is a directory (`@/shared` -> src/shared) has to fall through to its index file rather than resolve to the folder
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const asFile = (base: string): string | null => CODE_EXT.map((e) => base + e).find(isFile) ?? null;

/** every `paths` entry of a tsconfig fragment, with its targets resolved against that file */
function pathsOf(file: string): Record<string, string[]> {
  if (!existsSync(file)) return {};
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as { compilerOptions?: { paths?: Record<string, string[]> } };
    const out: Record<string, string[]> = {};
    for (const [key, targets] of Object.entries(cfg.compilerOptions?.paths ?? {})) {
      out[key] = targets.map((t) => (isAbsolute(t) ? t : resolve(dirname(file), t)));
    }
    return out;
  } catch { return {}; }
}

function aliasPlugin(root: string): BunPlugin {
  // the adapter's own fragment first (it repoints void/db and void/queues at the shims), then Void's, then the
  // project's own tsconfig; `@schema` falls back to Void's convention when no fragment has been generated yet
  const paths: Record<string, string[]> = {
    ...pathsOf(join(root, "tsconfig.json")),
    ...pathsOf(join(root, ".void", "tsconfig.json")),
    ...pathsOf(join(root, ".voidbase", "tsconfig.json")),
  };
  if (!paths["@schema"] && existsSync(join(root, "db", "schema.ts"))) paths["@schema"] = [join(root, "db", "schema.ts")];

  const exact = Object.entries(paths).filter(([k]) => !k.includes("*"));
  const wildcard = Object.entries(paths).filter(([k]) => k.endsWith("/*")).map(([k, v]) => [k.slice(0, -1), v] as const);

  return {
    name: "voidbase-aliases",
    setup(build) {
      // `void` itself is the package entry, which carries the Vite plugin; a route only wants the runtime half
      build.onResolve({ filter: /^void$/ }, () => ({ path: Bun.resolveSync("void/handler", root) }));
      build.onResolve({ filter: /.*/ }, (args) => {
        for (const [key, targets] of exact) {
          if (args.path !== key) continue;
          const hit = targets.map(asFile).find(Boolean);
          if (hit) return { path: hit };
        }
        for (const [prefix, targets] of wildcard) {
          if (!args.path.startsWith(prefix)) continue;
          const rest = args.path.slice(prefix.length);
          const hit = targets.map((t) => asFile(t.replace(/\*$/, "") + rest)).find(Boolean);
          if (hit) return { path: hit };
        }
        return undefined; // let Bun resolve it
      });
    },
  };
}

export interface BundleResult { code: string; bytes: number }

/**
 * Builds `entry` (a generated module exporting `register(api)`) into a single CommonJS file.
 * Throws with Bun's own diagnostics when the app's code does not bundle.
 */
export async function bundleHookApp(entry: string, root: string): Promise<BundleResult> {
  if (!existsSync(entry)) throw new Error(`voidbase: bundle entry ${entry} does not exist`);
  const built = await Bun.build({
    entrypoints: [resolve(entry)],
    root: resolve(root),
    target: "node", // Bun and workerd both run the result; the shim keeps node builtins out of it
    format: "cjs",
    minify: false, // the file is read when something goes wrong in production
    sourcemap: "none",
    plugins: [builtinShims, aliasPlugin(resolve(root))],
    throw: false, // the diagnostics below are more useful than Bun's AggregateError
  });
  if (!built.success) {
    const why = built.logs.map((l) => `${l.level}: ${l.message}${(l as { position?: { file?: string } }).position?.file ? ` (${(l as { position?: { file?: string } }).position!.file})` : ""}`).join("\n");
    throw new Error(`voidbase: could not bundle the app's server code for pb_hooks.\n${why}`);
  }
  const [artifact] = built.outputs;
  if (!artifact) throw new Error("voidbase: the bundler produced no output");
  const code = await artifact.text();
  return { code: `${RAW_PRAGMA}\n// Generated by voidbase's Void adapter from routes/, middleware/, crons/ and queues/.\n${code}`, bytes: code.length };
}

export const WORKFLOW_PRAGMA = "// voidbase:workflow";
/**
 * A workflows/ module, bundled as one ES module for the Worker entry to export: the app's own code is inlined (its
 * aliases resolved), voidbase's entry points and cloudflare:workers stay imports, because a Workflow step runs inside
 * the same Worker as the app and has to share its modules (the hook store, the collections) rather than carry copies.
 * The first line names the class the deploy exports it under.
 */
export async function bundleWorkflow(entry: string, root: string, className: string): Promise<BundleResult> {
  if (!existsSync(entry)) throw new Error(`voidbase: workflow ${entry} does not exist`);
  const built = await Bun.build({
    entrypoints: [resolve(entry)], root: resolve(root), target: "node", format: "esm", minify: false, sourcemap: "none",
    external: ["cloudflare:workers", "cloudflare:*", "@voidbase-cloud/voidbase", "@voidbase-cloud/voidbase/*", "hono", "hono/*"],
    plugins: [builtinShims, aliasPlugin(resolve(root))], throw: false,
  });
  if (!built.success) throw new Error(`voidbase: could not bundle the workflow ${entry}.\n${built.logs.map((l) => `${l.level}: ${l.message}`).join("\n")}`);
  const [artifact] = built.outputs; if (!artifact) throw new Error("voidbase: the bundler produced no output");
  const code = await artifact.text();
  return { code: `${WORKFLOW_PRAGMA} ${className}\n// Generated by voidbase's Void adapter from workflows/; the deploy exports ${className} from the Worker and binds it.\n${code}`, bytes: code.length };
}
