// The prebuilt executable deploys with the Void toolchain it carries (src/node/toolchain.ts), and there `node` is the
// executable acting as Bun. Void's env-schema probe (void/dist/cli/env-schema-probe.mjs) runs project code in a child
// and reads the child's answer from file descriptor 3 through `spawnSync`'s `output[3]`, which Bun never fills, so every
// `voidbase sync up` / `deploy` from the executable stopped at "the env-schema probe produced no parseable result"
// (voidbase-stories b-binary-extended.feature, "Deploying to the cloud"). The toolchain the executable embeds is patched
// when it is staged (scripts/build-exe.ts): the parent names a file in the child's environment and reads the answer from
// it, and the child writes there when the file is named. stdout and stderr stay ignored, as Void intends. The anchors are
// the pinned Void's exact text, so a Void that changed the probe fails the build rather than shipping it unpatched.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROBE_PATH = "void/dist/cli/env-schema-probe.mjs";
/** the variable the patched parent sets and the patched child reads */
export const RESULT_FILE_ENV = "VOID_ENV_SCHEMA_PROBE_RESULT_FILE";
const MARK = "// voidbase: env-schema probe result through a file (src/node/void-probe-patch.ts)";

const IMPORT_ANCHOR = `import { writeSync } from "node:fs";\n`;
const SPAWN_START = "const defaultSpawn = (command, args, options) => {\n";
const SPAWN_END = "\n};\n";
const EMIT_ANCHOR = "\twriteSync(RESULT_FD, JSON.stringify(result));\n";

function once(source: string, anchor: string, what: string): number {
  const at = source.indexOf(anchor);
  if (at < 0 || source.indexOf(anchor, at + 1) >= 0) throw new Error(`the Void env-schema probe no longer has ${what} where voidbase patches it (${PROBE_PATH}): check the pinned void version`);
  return at;
}

/** the probe's source with the file transport; the same source when it is already patched */
export function patchVoidEnvProbe(source: string): string {
  if (source.includes(MARK)) return source;
  let s = source;
  const imp = once(s, IMPORT_ANCHOR, "its node:fs import");
  s = s.slice(0, imp + IMPORT_ANCHOR.length) +
    `${MARK}\nimport { mkdtempSync as __vbMkdtemp, readFileSync as __vbRead, rmSync as __vbRm, writeFileSync as __vbWrite } from "node:fs";\nimport { tmpdir as __vbTmpdir } from "node:os";\nimport { join as __vbJoin } from "node:path";\n` +
    s.slice(imp + IMPORT_ANCHOR.length);
  const start = once(s, SPAWN_START, "defaultSpawn");
  const end = s.indexOf(SPAWN_END, start);
  if (end < 0) throw new Error(`the Void env-schema probe's defaultSpawn has no end voidbase recognises (${PROBE_PATH})`);
  if (!s.slice(start, end).includes('"pipe"')) throw new Error(`the Void env-schema probe's defaultSpawn no longer pipes fd 3 (${PROBE_PATH})`);
  const spawn = `const defaultSpawn = (command, args, options) => {
	const resultDir = __vbMkdtemp(__vbJoin(__vbTmpdir(), "void-env-probe-"));
	const resultFile = __vbJoin(resultDir, "result.json");
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: { ...options.env, ${RESULT_FILE_ENV}: resultFile },
		stdio: [
			"ignore",
			"ignore",
			"ignore"
		],
		encoding: "utf-8"
	});
	let fd3 = null;
	try { fd3 = __vbRead(resultFile, "utf8"); } catch {}
	try { __vbRm(resultDir, { recursive: true, force: true }); } catch {}
	return {
		status: result.status,
		fd3,
		error: result.error ?? null,
		signal: result.signal ?? null
	};`;
  s = s.slice(0, start) + spawn + s.slice(end);
  const emit = once(s, EMIT_ANCHOR, "its fd 3 write");
  s = s.slice(0, emit) + `\tif (process.env.${RESULT_FILE_ENV}) __vbWrite(process.env.${RESULT_FILE_ENV}, JSON.stringify(result));\n\telse writeSync(RESULT_FD, JSON.stringify(result));\n` + s.slice(emit + EMIT_ANCHOR.length);
  return s;
}

/** patch the probe inside a node_modules directory; throws when the toolchain has no probe to patch */
export function patchVoidEnvProbeIn(nodeModules: string): void {
  const file = join(nodeModules, PROBE_PATH);
  if (!existsSync(file)) throw new Error(`${file} is missing: the toolchain carries no Void env-schema probe to patch`);
  writeFileSync(file, patchVoidEnvProbe(readFileSync(file, "utf8")));
}

// The same executable builds the project with `vp build`, whose Vite (@voidzero-dev/vite-plus-core) loads vite.config.ts
// by bundling it to a temporary file and importing that, which fails under Bun with a bare ResolveMessage. Its "runner"
// loader works, and the CLI flag that selects it is not Void's to pass, so under Bun the default is "runner".
export const VITE_CORE_PATH = "@voidzero-dev/vite-plus-core/dist/vite/node/chunks/node.js";
const LOADER_ANCHOR = 'customLogger, configLoader = "bundle") {';
const LOADER_PATCHED = 'customLogger, configLoader = globalThis.Bun ? "runner" : "bundle") {';

/** Vite's source with "runner" as the config loader Bun defaults to; the same source when it is already patched */
export function patchViteConfigLoader(source: string): string {
  if (source.includes(LOADER_PATCHED)) return source;
  const at = once(source, LOADER_ANCHOR, "loadConfigFromFile's configLoader default");
  return source.slice(0, at) + LOADER_PATCHED + source.slice(at + LOADER_ANCHOR.length);
}

/** every patch the executable's toolchain needs, applied inside its node_modules */
export function patchToolchainIn(nodeModules: string): void {
  patchVoidEnvProbeIn(nodeModules);
  const file = join(nodeModules, VITE_CORE_PATH);
  if (!existsSync(file)) throw new Error(`${file} is missing: the toolchain carries no vite-plus core to patch`);
  writeFileSync(file, patchViteConfigLoader(readFileSync(file, "utf8")));
}
