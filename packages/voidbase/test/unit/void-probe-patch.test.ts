// The executable's Void toolchain reads the env-schema probe's answer through a file, because Bun never fills the fd 3
// pipe Void reads (src/node/void-probe-patch.ts). Checked against the Void this workspace pins, which is the one the
// executable embeds, and run for real: the patched module is imported and its probe spawned under Bun.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { patchViteConfigLoader, patchVoidEnvProbe, PROBE_PATH, RESULT_FILE_ENV, VITE_CORE_PATH } from "../../src/node/void-probe-patch";

const probeFile = resolve(dirname(Bun.resolveSync("void/package.json", import.meta.dir)), "..", PROBE_PATH);

describe("the Void env-schema probe in the executable's toolchain", () => {
  test("the pinned probe is patched once: the child's answer goes through a named file instead of fd 3", () => {
    const source = readFileSync(probeFile, "utf8");
    const patched = patchVoidEnvProbe(source);
    expect(patched).not.toBe(source);
    expect(patched).toContain(`${RESULT_FILE_ENV}: resultFile`);
    expect(patched).toContain(`if (process.env.${RESULT_FILE_ENV}) __vbWrite(`);
    expect(patched).not.toMatch(/"ignore",\s*"pipe"\s*\]/);
    // patching again changes nothing, and a probe voidbase does not recognise is refused rather than shipped
    expect(patchVoidEnvProbe(patched)).toBe(patched);
    expect(() => patchVoidEnvProbe(source.replace("const defaultSpawn = (command, args, options) => {", "const spawner = (c, a, o) => {"))).toThrow(/defaultSpawn/);
  });

  test("under Bun the patched probe gets the child's answer, where the original gets none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-probe-patch-"));
    try {
      // the probe's own module, beside its relative import, with a child that answers without a project
      const src = readFileSync(probeFile, "utf8");
      const child = `\nif (process.argv[2] === "__vb-test__") { const result = { hasSchema: false, requiredKeys: [], secretKeys: [] }; if (process.env.${RESULT_FILE_ENV}) require("node:fs").writeFileSync(process.env.${RESULT_FILE_ENV}, JSON.stringify(result)); else require("node:fs").writeSync(3, JSON.stringify(result)); process.exit(0); }\nexport const __vbSpawn = defaultSpawn;\n`;
      const probeDir = dirname(probeFile);
      const original = join(probeDir, `.vb-test-original-${process.pid}.mjs`), patched = join(probeDir, `.vb-test-patched-${process.pid}.mjs`);
      writeFileSync(original, src + child); writeFileSync(patched, patchVoidEnvProbe(src) + child);
      try {
        const answer = async (file: string) => {
          const mod = (await import(file)) as { __vbSpawn: (c: string, a: string[], o: { cwd: string; env: Record<string, string> }) => { status: number | null; fd3: string | null } };
          return mod.__vbSpawn(process.execPath, [file, "__vb-test__"], { cwd: dir, env: process.env as Record<string, string> });
        };
        expect((await answer(patched)).fd3).toBe(JSON.stringify({ hasSchema: false, requiredKeys: [], secretKeys: [] }));
        expect((await answer(original)).fd3 ?? "").toBe("");
      } finally { rmSync(original, { force: true }); rmSync(patched, { force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Vite's config loader in the executable's toolchain", () => {
  test("under Bun the pinned vite-plus core loads vite.config.ts with the runner loader; elsewhere it still bundles", () => {
    const file = resolve(dirname(Bun.resolveSync("vite-plus/package.json", import.meta.dir)), "..", VITE_CORE_PATH);
    const source = readFileSync(file, "utf8");
    const patched = patchViteConfigLoader(source);
    expect(patched).toContain('configLoader = globalThis.Bun ? "runner" : "bundle") {');
    expect(patched.length - source.length).toBe('globalThis.Bun ? "runner" : '.length);
    expect(patchViteConfigLoader(patched)).toBe(patched);
    expect(() => patchViteConfigLoader(source.replace('configLoader = "bundle") {', 'loader = "bundle") {'))).toThrow(/configLoader/);
  });
});

