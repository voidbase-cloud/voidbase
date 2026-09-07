// The hooks src/node/ts-loader.mjs registers: resolve extensionless TypeScript imports, transpile .ts on load.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TS = /\.(m|c)?tsx?(\?.*)?$/;
const TRY = [".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const code = err && typeof err === "object" ? err.code : undefined;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw err;
    // a relative import without its extension (Bun resolves these; Node does not)
    if (/^\.\.?\//.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of TRY) {
        const candidate = base.href.replace(/\/$/, "") + ext;
        if (existsSync(fileURLToPath(candidate))) return { url: candidate, format: "module", shortCircuit: true };
      }
    }
    throw err;
  }
}

export async function load(url, context, next) {
  if (!url.startsWith("file:") || !TS.test(url)) return next(url, context);
  const file = fileURLToPath(url);
  const out = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true, sourceMap: false },
  });
  return { format: "module", source: out.outputText, shortCircuit: true };
}
