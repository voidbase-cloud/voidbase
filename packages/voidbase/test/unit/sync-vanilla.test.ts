// Which directories `voidbase sync up` treats as an instance rather than a project (src/node/sync-vanilla.ts).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVanillaLocal } from "../../src/node/sync-vanilla";

const dirs: string[] = []; afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const dir = (files: string[]) => { const d = mkdtempSync(join(tmpdir(), "vb-sync-vanilla-")); dirs.push(d); for (const f of files) { mkdirSync(join(d, f, ".."), { recursive: true }); if (f.endsWith("/")) mkdirSync(join(d, f), { recursive: true }); else writeFileSync(join(d, f), "x"); } return d; };

test("a local instance voidbase keeps is an instance, even with the scaffold's hook in it", () => {
  const d = dir(["pb_hooks/main.pb.js", "pb_data/"]);
  expect(isVanillaLocal(d, [{ name: "passwords", dir: d, port: 8392, created: "2026-09-14" }])).toBe(true);
});
test("the pb_data beside an executable, with no project around it, is an instance", () => {
  expect(isVanillaLocal(dir(["pb_data/", "voidbase"]), [])).toBe(true);
});
test("a project is a project: a package.json, an entry, or a Vite config", () => {
  for (const f of ["package.json", "main.ts", "index.ts", "vite.config.ts"]) expect(isVanillaLocal(dir(["pb_data/", f]), [])).toBe(false);
  expect(isVanillaLocal(dir(["pb_hooks/main.pb.js"]), [])).toBe(false);
});
