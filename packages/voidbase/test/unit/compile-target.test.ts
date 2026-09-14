// From the prebuilt executable, `voidbase build --compile` compiles onto a plain Bun of the same version rather than onto
// the voidbase executable acting as Bun (src/node/compile-project.ts, src/node/bun-runtime.ts).
import { expect, test } from "bun:test";
import { compilesOntoExecutable } from "../../src/node/compile-project";

test("Bun compiles onto itself; the voidbase executable acting as Bun names a target instead", () => {
  expect(compilesOntoExecutable("/home/me/.bun/bin/bun")).toBe(false);
  expect(compilesOntoExecutable("C:\\Users\\me\\.bun\\bin\\bun.exe")).toBe(false);
  expect(compilesOntoExecutable("/home/me/app/voidbase")).toBe(true);
  expect(compilesOntoExecutable("C:\\tools\\voidbase.exe")).toBe(true);
});

