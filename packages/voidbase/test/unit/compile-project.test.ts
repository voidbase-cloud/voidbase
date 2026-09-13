// An extended project squashed into one binary: what it carries, where the carried folders are used, and which
// voidbase it is compiled against.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFolder } from "../../src/node/baked-project";
import { projectFiles } from "../../src/node/compile-project";
import { installedVoidbase } from "../../src/node/run-entry";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "vb-compile-")); dirs.push(d); return d; };
const put = (root: string, rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("the binary carries the pb_ folders and voidbase.lock, and nothing else of the project", () => {
  const d = temp();
  put(d, "pb_hooks/a.pb.js", "routerAdd()"); put(d, "pb_plugins/audit/bundle.js", "export default {}"); put(d, "pb_public/index.html", "<h1>");
  put(d, "voidbase.lock", "{}"); put(d, "index.ts", "import"); put(d, "pb_data/data.db", "records");
  const files = projectFiles(d);
  expect(Object.keys(files).sort()).toEqual(["pb_hooks/a.pb.js", "pb_plugins/audit/bundle.js", "pb_public/index.html", "voidbase.lock"]);
  expect(Buffer.from(files["pb_hooks/a.pb.js"]!, "base64").toString()).toBe("routerAdd()");
});

test("a folder on disk where the binary runs wins over the one it carries", () => {
  const baked = temp(); put(baked, "pb_hooks/a.pb.js", "baked");
  const here = temp(); put(here, "pb_hooks/b.pb.js", "on disk");
  expect(projectFolder(join(here, "pb_hooks"), baked)).toBe(join(here, "pb_hooks"));
  expect(projectFolder(join(temp(), "pb_hooks"), baked)).toBe(join(baked, "pb_hooks"));
  // nothing carried and nothing on disk: the path asked for, as before
  expect(projectFolder(join(here, "pb_public"), baked)).toBe(join(here, "pb_public"));
  expect(projectFolder(join(here, "pb_public"), null)).toBe(join(here, "pb_public"));
});

test("a project's own install of voidbase is found in node_modules above it, and none is found without one", () => {
  const d = temp(); put(d, "node_modules/@voidbase-cloud/voidbase/package.json", "{}"); mkdirSync(join(d, "app/src"), { recursive: true });
  expect(installedVoidbase(join(d, "app/src"))).toBe(join(d, "node_modules/@voidbase-cloud/voidbase"));
  expect(installedVoidbase(temp())).toBeNull();
});
