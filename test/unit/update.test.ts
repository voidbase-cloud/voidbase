import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSuffix, cachedLatest, compareVersions, detectInstall, findManifest, installedVersion, managerFor,
  noticeFor, noticeWanted, parseChecksums, sha256, updateCommand, writeCache,
} from "../../src/node/update";

test("archive suffix follows PocketBase's naming for the platforms Bun builds", () => {
  expect(archiveSuffix("linux", "x64")).toBe("_linux_amd64.zip");
  expect(archiveSuffix("linux", "arm64")).toBe("_linux_arm64.zip");
  expect(archiveSuffix("darwin", "arm64")).toBe("_darwin_arm64.zip");
  expect(archiveSuffix("win32", "x64")).toBe("_windows_amd64.zip");
  expect(archiveSuffix("freebsd", "x64")).toBeNull();
  expect(archiveSuffix("linux", "ia32")).toBeNull();
});

test("version comparison handles v prefixes, missing parts and pre-releases", () => {
  expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
  expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
});

test("checksums.txt parses goreleaser's format", async () => {
  const sum = await sha256(new TextEncoder().encode("hello"));
  expect(sum).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  const parsed = parseChecksums(`${sum}  voidbase_0.1.0_linux_amd64.zip\nnot a line\n${"a".repeat(64)} *voidbase_0.1.0_windows_amd64.zip\n`);
  expect(parsed.get("voidbase_0.1.0_linux_amd64.zip")).toBe(sum);
  expect(parsed.get("voidbase_0.1.0_windows_amd64.zip")).toBe("a".repeat(64));
  expect(parsed.size).toBe(2);
});

test("the install shape is read from where the caller stands, not where the package lives", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-shape-"));
  try {
    // a project is any package.json above the caller that depends on voidbase
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@voidbase-cloud/voidbase": "^0.6.0" } }));
    writeFileSync(join(dir, "bun.lock"), "");
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    const fromDeep = detectInstall({ executable: false, cwd: join(dir, "src", "deep"), packageRoot: "/anywhere/node_modules/@voidbase-cloud/voidbase" });
    expect(fromDeep.shape).toBe("project");
    expect(fromDeep.range).toBe("^0.6.0");
    expect(fromDeep.manager).toBe("bun");

    // the executable wins over everything: it has no package.json to update
    expect(detectInstall({ executable: true, cwd: dir, packageRoot: "/$bunfs/root" }).shape).toBe("executable");

    // outside a project, a copy inside node_modules is a global install and a copy outside one is the repository
    const outside = mkdtempSync(join(tmpdir(), "vb-none-"));
    expect(detectInstall({ executable: false, cwd: outside, packageRoot: "/home/u/.bun/install/global/node_modules/@voidbase-cloud/voidbase" }).shape).toBe("global");
    expect(detectInstall({ executable: false, cwd: outside, packageRoot: "/home/u/src/voidbase" }).shape).toBe("checkout");
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a package.json that does not depend on voidbase is not a project to update", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-unrelated-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "something-else", dependencies: { react: "^19.0.0" } }));
    expect(findManifest(dir)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the lockfile picks the package manager", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-lock-"));
  try {
    expect(managerFor(dir)).toBe("bun"); // no lockfile: what we ship for
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(managerFor(dir)).toBe("npm");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(managerFor(dir)).toBe("pnpm"); // pnpm is checked before npm, so a repo with both is pnpm's
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updating keeps the range style the project chose", () => {
  const project = (range: string | null, manager: "bun" | "npm" = "bun") => ({ shape: "project" as const, manifest: "/p/package.json", range, manager });
  expect(updateCommand(project("^0.6.0"), "0.9.0")).toEqual(["bun", "add", "@voidbase-cloud/voidbase@^0.9.0"]);
  expect(updateCommand(project("~0.6.0"), "0.9.0")).toEqual(["bun", "add", "@voidbase-cloud/voidbase@~0.9.0"]);
  expect(updateCommand(project("0.6.0"), "0.9.0")).toEqual(["bun", "add", "@voidbase-cloud/voidbase@0.9.0"]);
  expect(updateCommand(project("^0.6.0", "npm"), "0.9.0")).toEqual(["npm", "install", "@voidbase-cloud/voidbase@^0.9.0"]);
  // a global install has no manifest, so there is no range to preserve
  expect(updateCommand({ shape: "global", manifest: null, range: null, manager: "bun" }, "0.9.0")).toEqual(["bun", "add", "-g", "@voidbase-cloud/voidbase@0.9.0"]);
  expect(updateCommand({ shape: "global", manifest: null, range: null, manager: "npm" }, "0.9.0")).toEqual(["npm", "install", "-g", "@voidbase-cloud/voidbase@0.9.0"]);
});

test("a project reports its own version, installed first and declared second", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-version-"));
  try {
    const manifest = join(dir, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "app", dependencies: { "@voidbase-cloud/voidbase": "^0.6.0" } }));
    const i = { shape: "project" as const, manifest, range: "^0.6.0", manager: "bun" as const };
    expect(installedVersion(i)).toBe("0.6.0"); // nothing installed: the floor of the range

    mkdirSync(join(dir, "node_modules", "@voidbase-cloud", "voidbase"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "@voidbase-cloud", "voidbase", "package.json"), JSON.stringify({ version: "0.7.1" }));
    expect(installedVersion(i)).toBe("0.7.1"); // what is actually there wins

    expect(installedVersion({ ...i, manifest: null })).toBeNull();
    expect(installedVersion({ ...i, range: "workspace:*" })).toBe("0.7.1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the notice stays quiet in CI, without a terminal, and when told to", () => {
  expect(noticeWanted({}, true)).toBe(true);
  expect(noticeWanted({}, false)).toBe(false); // a pipe or a test harness
  expect(noticeWanted({ CI: "true" }, true)).toBe(false);
  expect(noticeWanted({ VOIDBASE_NO_UPDATE_CHECK: "1" }, true)).toBe(false);
  expect(noticeWanted({ VOIDBASE_CI_INNER: "1" }, true)).toBe(false);
});

test("the notice only speaks when there is something newer", () => {
  const global = { shape: "global" as const, manifest: null, range: null, manager: "bun" as const };
  expect(noticeFor("0.8.0", "0.8.0", global)).toBeNull();
  expect(noticeFor("0.9.0", "0.8.0", global)).toBeNull(); // ahead of the registry: a local build
  expect(noticeFor("0.8.0", null, global)).toBeNull(); // no answer yet
  expect(noticeFor("0.7.0", "0.8.0", global)).toContain("voidbase update");
  // a checkout cannot install over itself, so it is told the truth instead
  expect(noticeFor("0.7.0", "0.8.0", { ...global, shape: "checkout" })).toContain("git pull");
});

test("the cache is used while it is fresh and ignored once it is not", () => {
  const home = mkdtempSync(join(tmpdir(), "vb-cache-"));
  const previous = process.env.VOIDBASE_HOME;
  process.env.VOIDBASE_HOME = home;
  try {
    expect(cachedLatest()).toBeNull(); // nothing written yet
    const at = new Date("2026-09-08T00:00:00Z");
    writeCache("0.9.0", at);
    expect(cachedLatest(24 * 60 * 60 * 1000, at.getTime() + 60_000)).toBe("0.9.0");
    expect(cachedLatest(24 * 60 * 60 * 1000, at.getTime() + 25 * 60 * 60 * 1000)).toBeNull();
    writeFileSync(join(home, "update-check.json"), "not json");
    expect(cachedLatest()).toBeNull(); // a damaged cache is a missing cache, never an error
  } finally {
    if (previous === undefined) delete process.env.VOIDBASE_HOME; else process.env.VOIDBASE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
