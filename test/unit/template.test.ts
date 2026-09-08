import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEmptyEnough, parseRepository, resolveTemplate } from "../../src/node/template";

test("a template is named as owner/name, or as a GitHub URL in any of its usual shapes", () => {
  expect(parseRepository("voidbase-cloud/voidbase-demo")).toBe("voidbase-cloud/voidbase-demo");
  expect(parseRepository("https://github.com/voidbase-cloud/voidbase-demo")).toBe("voidbase-cloud/voidbase-demo");
  expect(parseRepository("https://github.com/voidbase-cloud/voidbase-demo.git")).toBe("voidbase-cloud/voidbase-demo");
  expect(parseRepository("https://www.github.com/voidbase-cloud/voidbase-demo/")).toBe("voidbase-cloud/voidbase-demo");
  // a bare word is not a repository: it is a name to look up in the registry
  expect(parseRepository("voidbase-demo")).toBeNull();
  expect(parseRepository("owner/name/extra")).toBeNull();
  expect(parseRepository("")).toBeNull();
});

test("a bare name is looked up in the registry, by title or by repository name", async () => {
  const registry = mkdtempSync(join(tmpdir(), "vb-reg-"));
  const file = join(registry, "templates.json");
  writeFileSync(file, JSON.stringify({ entries: [
    { repository: "voidbase-cloud/voidbase-demo", title: "The public demo", summary: "x" },
    { repository: "someone/blog-starter", title: "Blog with comments", summary: "y" },
  ] }));
  const url = `file://${file}`;
  try {
    expect((await resolveTemplate("voidbase-demo", url)).repository).toBe("voidbase-cloud/voidbase-demo");
    expect((await resolveTemplate("Blog with comments", url)).repository).toBe("someone/blog-starter");
    // matching is case-insensitive, because nobody types a listing's capitalisation back exactly
    expect((await resolveTemplate("BLOG WITH COMMENTS", url)).repository).toBe("someone/blog-starter");
    // owner/name never consults the registry at all
    const direct = await resolveTemplate("other/thing", url);
    expect(direct).toEqual({ repository: "other/thing", from: "direct" });
    expect((await resolveTemplate("voidbase-demo", url)).from).toBe("registry");
    // and a name nobody listed says what is listed instead of failing blankly
    await expect(resolveTemplate("not-a-thing", url)).rejects.toThrow(/no template called .*someone\/blog-starter/s);
  } finally { rmSync(registry, { recursive: true, force: true }); }
});

test("a template will not be unpacked over somebody's existing work", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-tpl-"));
  try {
    expect(isEmptyEnough(dir)).toBe(true);
    expect(isEmptyEnough(join(dir, "does-not-exist"))).toBe(true); // it gets created
    // a checkout that is empty apart from git's own housekeeping is still empty enough to start in
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".DS_Store"), "");
    expect(isEmptyEnough(dir)).toBe(true);
    writeFileSync(join(dir, "README.md"), "mine");
    expect(isEmptyEnough(dir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
