// pb_public from the admin panel (src/server/public-files.ts, src/node/public-files.ts): what counts as a path inside
// it, and that an upload lands in the folder `voidbase serve` serves, beside what was there.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicFiles } from "../../src/node/public-files";
import { publicPath } from "../../src/server/public-files";

const dir = mkdtempSync(join(tmpdir(), "vb-public-"));
const before = process.env.VOIDBASE_PUBLIC_DIR;
process.env.VOIDBASE_PUBLIC_DIR = join(dir, "pb_public");
afterAll(() => { rmSync(dir, { recursive: true, force: true }); if (before === undefined) delete process.env.VOIDBASE_PUBLIC_DIR; else process.env.VOIDBASE_PUBLIC_DIR = before; });

test("a path inside pb_public is relative and stays inside it", () => {
  expect(publicPath("/assets/app.css")).toBe("assets/app.css");
  expect(publicPath("index.html")).toBe("index.html");
  for (const bad of ["", "/", "../secrets.json", "assets/../../x", "a//b", "a/./b", "a\\b", "dir/"]) expect(publicPath(bad)).toBeNull();
});

test("an upload is written into the served folder beside what was there, and listed", () => {
  mkdirSync(join(dir, "pb_public"), { recursive: true });
  writeFileSync(join(dir, "pb_public/index.html"), "<h1>old</h1>");
  publicFiles!.write("assets/logo.svg", new TextEncoder().encode("<svg/>"));
  publicFiles!.write("index.html", new TextEncoder().encode("<h1>new</h1>"));
  expect(readFileSync(join(dir, "pb_public/index.html"), "utf8")).toBe("<h1>new</h1>");
  expect(publicFiles!.list()).toEqual([{ path: "assets/logo.svg", size: 6 }, { path: "index.html", size: 12 }]);
  expect(() => publicFiles!.write("../escape.txt", new Uint8Array())).toThrow("is not a path inside pb_public");
});
