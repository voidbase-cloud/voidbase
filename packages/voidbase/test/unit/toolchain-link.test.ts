// A project generated where nothing on the way up holds vite (a deploy from the prebuilt executable) resolves the
// toolchain's packages through a link (src/node/toolchain-link.ts); one that already resolves vite gets none.
import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasViteAbove, linkToolchainModules } from "../../src/node/toolchain-link";

describe("the toolchain's node_modules in a generated project", () => {
  test("a project that cannot resolve vite links the toolchain's modules, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-toolchain-link-"));
    try {
      const modules = join(dir, "toolchain", "node_modules"); mkdirSync(join(modules, "vite"), { recursive: true });
      writeFileSync(join(modules, "vite", "package.json"), JSON.stringify({ name: "vite", version: "0.0.0" }));
      const project = join(dir, "consumer", ".cloud", "shop"); mkdirSync(project, { recursive: true });
      expect(linkToolchainModules(project, modules)).toBe(true);
      expect(lstatSync(join(project, "node_modules")).isSymbolicLink()).toBe(true);
      expect(resolve(project, readlinkSync(join(project, "node_modules")))).toBe(modules);
      // resolved the way Void's probe and vite build resolve it: in a fresh process (this one keeps the lookup that failed)
      const fresh = Bun.spawnSync([process.execPath, "-e", `console.log(Bun.resolveSync("vite/package.json", ${JSON.stringify(project)}))`], { stdout: "pipe", stderr: "pipe" });
      expect(fresh.stdout.toString().trim()).toBe(join(modules, "vite", "package.json"));
      // Bun's own resolver finds a bare name in its global cache when no node_modules is above; that is not vite for the
      // project, and only a node_modules on disk counts
      expect(hasViteAbove(join(dir, "consumer"))).toBe(false);
      expect(hasViteAbove(project)).toBe(true);
      // resolvable now, so a second deploy changes nothing
      expect(linkToolchainModules(project, modules)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a project inside a tree that already has vite, or with a node_modules of its own, is left alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-toolchain-link-"));
    try {
      expect(linkToolchainModules(resolve(import.meta.dir, "../.."), join(dir, "nowhere"))).toBe(false);
      const project = join(dir, "own"); mkdirSync(join(project, "node_modules"), { recursive: true });
      expect(linkToolchainModules(project, join(dir, "nowhere"))).toBe(false);
      expect(lstatSync(join(project, "node_modules")).isSymbolicLink()).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
