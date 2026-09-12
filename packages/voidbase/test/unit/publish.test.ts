// The release flow at N packages (docs/releasing.md, scripts/publish.ts).
//
// Two halves. The first runs against this repository, whose workspace holds two published packages --
// @voidbase-cloud/voidbase and, since 7.5, @voidbase-cloud/plugin-realtime, which the core depends on and which
// peer-depends back on the core -- and packages/release-fixture, a private, never-published third package that
// depends on the core through `workspace:*`. The second builds a throwaway two-package workspace and drives the
// whole loop -- pack, prove, smoke install, publish, publish again -- against a stubbed registry on localhost, so
// the ordering and the per-package idempotence are measured rather than reasoned about. Nothing here reaches npm.
//
// The shapes that are not this repository's are still written out as the packages that would have them: a chain of
// three, a devDependency cycle, a published package that names a sibling nobody publishes, and an `--out` that
// resolves to the workspace root.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CORE,
  NEVER_MIRROR,
  NEVER_PUBLISH,
  RESOLVABLE_TIMEOUT_MS,
  ROOT,
  releaseVersion,
  assertNoPrivateSiblings,
  assertNoWorkspaceSpecs,
  assertResolvedSiblings,
  binNames,
  clearPacks,
  dependsOn,
  lockfileDrift,
  mirrorable,
  pack,
  packDir,
  packedManifest,
  publishOrder,
  publishPacked,
  publishWaves,
  publishWorkspace,
  publishable,
  readWorkspace,
  runCommand,
  smokeProject,
  specBase,
  subpathEntries,
  syncLockfile,
  until,
  workspaceSpecs,
  type IsPublished,
  type Manifest,
  type Packed,
  type Pkg,
  type Run,
} from "../../../../scripts/publish";
import { bumpVersion, lockstep, prependNotes, releaseSet } from "../../../../scripts/hot-release";

const PACKAGE = "@voidbase-cloud/voidbase";
const PLUGIN = "@voidbase-cloud/plugin-realtime";
const FIXTURE = "@voidbase-cloud/release-fixture";
const pkg = (name: string, version: string, deps: Record<string, string> = {}, extra: Partial<Pkg> = {}): Pkg => ({
  path: `packages/${name.replace(/^@[^/]+\//, "")}`,
  dir: `/nowhere/${name}`,
  name,
  version,
  private: false,
  bins: [],
  manifest: { name, version, dependencies: deps },
  ...extra,
});

/**
 * The core's own list of the extracted plugin packages, which is the second source of truth the workspace list is
 * held against: the `./plugins/<name>` entries it publishes whose file is one statement, a re-export of
 * `@voidbase-cloud/plugin-<name>`.
 *
 * Reading the workspace and then comparing it against a list derived from the same read proves nothing -- an
 * unexpected `packages/plugin-*` directory, or one whose name is a typo, is simply on both sides of the equality.
 * Until 7.6 the names were written out and that was the pin; deriving them took the pin with it. This is the pin
 * put back, and it is a better one than a list to remember, because the entry is what an extraction exists to
 * preserve: a package with no entry is unreachable by the name every marketplace bundle imports, and an entry with
 * no package behind it does not resolve at all. Two lists that are produced by different things and have to agree.
 */
function reexportedPlugins(): string[] {
  const core = JSON.parse(readFileSync(join(ROOT, "packages/voidbase/package.json"), "utf8")) as { exports: Record<string, string | { default?: string }> };
  const out: string[] = [];
  for (const [entry, target] of Object.entries(core.exports)) {
    if (!entry.startsWith("./plugins/")) continue;
    const file = typeof target === "string" ? target : target.default;
    if (!file) continue;
    const name = `@voidbase-cloud/plugin-${entry.slice("./plugins/".length)}`;
    const code = readFileSync(join(ROOT, "packages/voidbase", file), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    if (code.length === 1 && code[0]!.includes(`from "${name}"`)) out.push(name);
  }
  return out.sort();
}

describe("the workspace the release packs", () => {
  const workspace = readWorkspace(ROOT);
  /** every extracted plugin package, in the order a release publishes them: one at 7.5, ten by the end of 7.6 */
  const PLUGINS = workspace.map((p) => p.name).filter((n) => n.startsWith("@voidbase-cloud/plugin-")).sort();

  test("holds the core, a package per extracted plugin, and the fixture that keeps the private path exercised", () => {
    // the pin, and the reason this equality can fail at all: the directories the workspace globs reach have to be
    // exactly the packages the core re-exports through the entries it keeps (reexportedPlugins, above)
    expect(PLUGINS).toEqual(reexportedPlugins());
    expect(workspace.map((p) => p.name).sort()).toEqual([...PLUGINS, FIXTURE, PACKAGE].sort());
    expect(PLUGINS).toContain(PLUGIN);
    expect(workspace.find((p) => p.name === FIXTURE)!.private).toBe(true);
    expect(workspace.find((p) => p.name === PACKAGE)!.private).toBe(false);
    expect(workspace.find((p) => p.name === FIXTURE)!.manifest.dependencies).toEqual({ [PACKAGE]: "workspace:*" });
    for (const name of PLUGINS) {
      const plugin = workspace.find((p) => p.name === name)!;
      expect(plugin.private, name).toBe(false);
      // 7.5's pair, in the real workspace: the core depends on the plugin, the plugin peer-depends back on the core
      expect(workspace.find((p) => p.name === PACKAGE)!.manifest.dependencies![name]).toBe("workspace:*");
      // The peers, and only two things are true of all ten. The core is one of them, at `workspace:*`. hono is
      // not: it is declared by the packages that name it and by no others (two of the ten -- observability, whose
      // `hono/route` is a value import, and previews, whose `Context` and `Hono` are types its own `bun run check`
      // has to resolve out of the tarball), because npm 7+ and bun auto-install peers, so a peer a package does
      // not import is both a constraint the manifest claims falsely and a package every standalone install pulls
      // for nothing. Where it *is* declared the range is the core's own: a plugin's routes go on the core's Hono
      // app and the two have to be holding one copy. `test/unit/plugin-extraction.test.ts` holds both halves per
      // specifier -- every name a file imports is declared, and every peer beside the core is a name it imports.
      const peers = plugin.manifest.peerDependencies ?? {};
      expect(peers[PACKAGE], name).toBe("workspace:^");
      expect(Object.keys(peers).filter((n) => n !== PACKAGE && n !== "hono"), name).toEqual([]);
      if ("hono" in peers) expect(peers.hono, name).toBe(workspace.find((p) => p.name === PACKAGE)!.manifest.dependencies!.hono!);
      // Dependencies: none at all for a leaf, and for the chain 7.7 extracts, the sibling package it is written
      // from -- mcp from openapi's document, ai from mcp's tools. Never the core, which is the peer above: a
      // plugin that depended on the core would pin a second copy of it into every install.
      for (const dep of Object.keys(plugin.manifest.dependencies ?? {})) {
        expect(PLUGINS, `${name} depends on ${dep}`).toContain(dep);
      }
      expect(plugin.manifest.dependencies?.[PACKAGE], name).toBeUndefined();
    }
  });

  test("publishes only what is not private", () => {
    expect(publishable(workspace).map((p) => p.name).sort()).toEqual([...PLUGINS, PACKAGE].sort());
    expect(publishable(workspace).map((p) => p.name)).not.toContain(FIXTURE);
  });

  test("visits the dependent after what it depends on, whatever order it is handed", () => {
    // The plugin packages first, because the core depends on each; the fixture last, because it depends on the core.
    // Path order gets neither end right on its own -- packages/plugin-* < packages/release-fixture <
    // packages/voidbase -- so the topological sort has to do the work in both directions.
    // The property, not a list: since 7.7 the plugin packages are no longer all leaves -- mcp is written from
    // openapi's document -- so the order is only fixed up to the edges, and the edges are what has to hold.
    const after = (order: string[]) => {
      const at = new Map(order.map((n, i) => [n, i]));
      const names = new Set(order);
      for (const p of workspace) {
        if (!at.has(p.name)) continue;
        for (const dep of dependsOn(p, names)) {
          expect(at.get(dep)!, `${p.name} is published before ${dep}, which it depends on`).toBeLessThan(at.get(p.name)!);
        }
      }
    };
    after(publishOrder(workspace).map((p) => p.name));
    after(publishOrder([...workspace].reverse()).map((p) => p.name));
    // the same list either way round: a sort that depended on the order it was handed would be a sort by luck
    expect(publishOrder(workspace).map((p) => p.name)).toEqual(publishOrder([...workspace].reverse()).map((p) => p.name));
    // the core last of what ships, and the private fixture behind it
    const shipped = publishable(publishOrder(workspace)).map((p) => p.name);
    expect(shipped.sort()).toEqual([...PLUGINS, PACKAGE].sort());
    expect(publishable(publishOrder(workspace)).at(-1)!.name).toBe(PACKAGE);
  });

  test("orders a chain, ignores devDependency edges, and refuses a real cycle", () => {
    const chain = [pkg("@x/c", "1.0.0", { "@x/b": "workspace:*" }), pkg("@x/a", "1.0.0"), pkg("@x/b", "1.0.0", { "@x/a": "workspace:*" })];
    expect(publishOrder(chain).map((p) => p.name)).toEqual(["@x/a", "@x/b", "@x/c"]);
    const a = pkg("@x/a", "1.0.0");
    a.manifest.devDependencies = { "@x/b": "workspace:*" };   // a dev edge back the other way is not a publish edge
    expect(publishOrder([a, pkg("@x/b", "1.0.0", { "@x/a": "workspace:*" })]).map((p) => p.name)).toEqual(["@x/a", "@x/b"]);
    const cycle = [pkg("@x/a", "1.0.0", { "@x/b": "workspace:*" }), pkg("@x/b", "1.0.0", { "@x/a": "workspace:*" })];
    expect(() => publishOrder(cycle)).toThrow(/cycle/);
  });

  test("the shape the first extracted plugin package has: a peer edge back to the core is not an ordering edge", () => {
    // The workspace above is now exactly this, and it is what 7.4 fixed the ordering for: read a peer edge as
    // "this has to be on the registry first" and the core/plugin pair is a cycle, and every release stops on the
    // first real plugin package. npm does not resolve peers when it publishes, so the edge is not there to read.
    // Kept as a constructed pair as well, so the rule is pinned by something other than the workspace of the day.
    const real = readWorkspace(ROOT);
    const names = new Set(real.map((p) => p.name));
    expect(dependsOn(real.find((p) => p.name === PACKAGE)!, names)).toEqual(PLUGINS);
    // every plugin package depends on siblings only, and on none through the core: the leaves on nothing, the
    // chain on the package it is written from
    for (const name of PLUGINS) {
      for (const dep of dependsOn(real.find((p) => p.name === name)!, names)) {
        expect(PLUGINS, `${name} depends on ${dep}`).toContain(dep);
        expect(dep, `${name} depends on the core`).not.toBe(PACKAGE);
      }
    }
    const core = pkg("@voidbase-cloud/voidbase", "0.9.0-beta.52", { "@voidbase-cloud/plugin-auth": "workspace:*" }, { path: "packages/voidbase" });
    const plugin = pkg("@voidbase-cloud/plugin-auth", "0.9.0-beta.52", {}, { path: "packages/plugin-auth" });
    plugin.manifest.peerDependencies = { "@voidbase-cloud/voidbase": ">=0.9.0-beta.14" };
    expect(publishOrder([core, plugin]).map((p) => p.name)).toEqual(["@voidbase-cloud/plugin-auth", "@voidbase-cloud/voidbase"]);
    expect(publishOrder([plugin, core]).map((p) => p.name)).toEqual(["@voidbase-cloud/plugin-auth", "@voidbase-cloud/voidbase"]);
    // and a peer edge on its own orders nothing: the dependent sorts first by path and stays first, which it
    // could not do if the peer were read as "that one has to be on the registry before this one"
    const peerOnly = pkg("@x/first", "1.0.0", {}, { path: "packages/a-first" });
    peerOnly.manifest.peerDependencies = { "@x/last": "workspace:*" };
    expect(publishOrder([peerOnly, pkg("@x/last", "1.0.0", {}, { path: "packages/z-last" })]).map((p) => p.name)).toEqual(["@x/first", "@x/last"]);
    // an optionalDependency is a real edge, though: npm installs it when it can find it
    const opt = pkg("@x/y", "1.0.0", {}, { path: "packages/a-first" });
    opt.manifest.optionalDependencies = { "@x/z": "workspace:*" };
    expect(publishOrder([opt, pkg("@x/z", "1.0.0", {}, { path: "packages/z-last" })]).map((p) => p.name)).toEqual(["@x/z", "@x/y"]);
  });

  test("every publishable package on one version, and on the one the release is for", () => {
    const one = publishable(workspace);
    expect(releaseVersion(one, one[0]!.version)).toBe(one[0]!.version);
    // versions may now differ across the workspace -- a package nobody touched keeps the one it has -- so what is
    // refused is a package ahead of the release, which is a version no tag names
    expect(releaseVersion([pkg("@x/a", "1.0.0"), pkg("@x/b", "1.0.1")], "1.0.1")).toBe("1.0.1");
    expect(() => releaseVersion([pkg("@x/a", "1.0.2")], "1.0.1")).toThrow(/ahead of it/);
  });

  test("bin names: the map's keys, or the package's own unscoped name", () => {
    expect(binNames({ name: PACKAGE, version: "0", bin: { voidbase: "bin/voidbase.ts" } })).toEqual(["voidbase"]);
    expect(binNames({ name: PACKAGE, version: "0", bin: "bin/voidbase.ts" })).toEqual(["voidbase"]);
    expect(binNames({ name: PACKAGE, version: "0" })).toEqual([]);
  });
});

describe("the workspace protocol, on the way into a tarball", () => {
  const out = mkdtempSync(join(tmpdir(), "voidbase-pack-"));
  const fixture = readWorkspace(ROOT).find((p) => p.name === FIXTURE)!;
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("`bun pm pack` resolves it to the sibling's exact version", async () => {
    const tarball = await pack(fixture, out);
    const manifest = await packedManifest(tarball);
    expect(manifest.dependencies).toEqual({ [PACKAGE]: fixture.version });
    expect(workspaceSpecs(manifest)).toEqual([]);
    expect(() => assertNoWorkspaceSpecs(manifest, "bun pm pack")).not.toThrow();
  }, 60_000);

  test("`npm pack` copies it verbatim, and the gate refuses what it produced", async () => {
    const r = await runCommand(["npm", "pack", "--ignore-scripts", "--pack-destination", out], { cwd: fixture.dir });
    expect(r.code).toBe(0);
    const manifest = await packedManifest(join(out, `voidbase-cloud-release-fixture-${fixture.version}.tgz`));
    expect(manifest.dependencies).toEqual({ [PACKAGE]: "workspace:*" });
    expect(() => assertNoWorkspaceSpecs(manifest, "npm pack")).toThrow(/nobody can install/);
  }, 60_000);

  test("the gate reads every map npm publishes, not only dependencies", () => {
    const m: Manifest = { name: "@x/a", version: "1.0.0", dependencies: { hono: "^4" }, devDependencies: { "@x/b": "workspace:^" }, peerDependencies: { "@x/c": "workspace:*" }, optionalDependencies: { "@x/d": "workspace:~" } };
    expect(workspaceSpecs(m).map((s) => `${s.map}.${s.dependency}`)).toEqual(["devDependencies.@x/b", "peerDependencies.@x/c", "optionalDependencies.@x/d"]);
    expect(() => assertNoWorkspaceSpecs(m, "somewhere")).toThrow(/3 unresolved workspace dependencies/);
  });

  test("and the maps that are not dependency maps: overrides and resolutions, however deep", () => {
    // npm publishes the manifest essentially verbatim, so a spec in `overrides` ships exactly like one in
    // `dependencies` -- and overrides nest. `smokeProject` in scripts/publish.ts writes an overrides map itself,
    // which is the shape a package here would copy from.
    const m: Manifest = { name: "@x/a", version: "1.0.0", overrides: { "@x/b": "workspace:*", hono: { "@x/c": "workspace:^" } }, resolutions: { "@x/d": "workspace:~" } };
    expect(workspaceSpecs(m).map((s) => `${s.map}.${s.dependency}`)).toEqual(["overrides.@x/b", "overrides.hono.@x/c", "resolutions.@x/d"]);
    expect(() => assertNoWorkspaceSpecs(m, "somewhere")).toThrow(/3 unresolved workspace dependencies/);
    // bundleDependencies is deliberately not read: it holds names, not specs, so it cannot carry the protocol
    expect(workspaceSpecs({ name: "@x/a", version: "1.0.0", overrides: { "@x/b": "^1.0.0" } })).toEqual([]);
  });

  test("a published package may not depend on a sibling that is never published", () => {
    const never = new Set(["@voidbase-cloud/release-fixture"]);
    const m: Manifest = { name: PACKAGE, version: "1.0.0", dependencies: { "@voidbase-cloud/release-fixture": "1.0.0" } };
    expect(() => assertNoPrivateSiblings(m, never, "here")).toThrow(/never publishes: dependencies\.@voidbase-cloud\/release-fixture/);
    expect(() => assertNoPrivateSiblings({ name: PACKAGE, version: "1.0.0", peerDependencies: { "@voidbase-cloud/release-fixture": "*" } }, never, "here")).toThrow(/peerDependencies/);
    // devDependencies are not read: nobody installing a tarball resolves them
    expect(() => assertNoPrivateSiblings({ name: PACKAGE, version: "1.0.0", devDependencies: { "@voidbase-cloud/release-fixture": "1.0.0" } }, never, "here")).not.toThrow();
    expect(() => assertNoPrivateSiblings({ name: PACKAGE, version: "1.0.0", dependencies: { hono: "^4" } }, never, "here")).not.toThrow();
  });

  test("the fixture is kept off the registry by its name as well as by its flag", () => {
    // `"private": true` is the rule, and it is one edit from being dropped by someone who reads it as boilerplate.
    // npm is not the backstop it looks like either: `npm publish --dry-run` does not check `private` at all
    // (measured, npm 11.19.0: it prints `+ name@version` for a package the real publish refuses with EPRIVATE),
    // and a rehearsal is where this would be noticed.
    expect(NEVER_PUBLISH).toContain(FIXTURE);
    const asIfTheFlagWereDropped = pkg(FIXTURE, "1.0.0");
    expect(asIfTheFlagWereDropped.private).toBe(false);
    expect(publishable([asIfTheFlagWereDropped, pkg(PACKAGE, "1.0.0")]).map((p) => p.name)).toEqual([PACKAGE]);
  });

  test("an extracted plugin is published to npm and kept off the GitHub Packages mirror, which is not ours", () => {
    // Not a private path: these packages *are* published, to npmjs, where the names are free and this repository
    // owns them. On GitHub Packages the same names belong to the four standalone `voidbase-cloud/voidbase-plugin-*`
    // repositories, each publishing its own `@voidbase-cloud/plugin-<name>` there at its own version and export
    // shape, and the marketplace lists those until 7.11 moves the listings and archives the repositories. A release
    // that mirrored ours over them would leave npm's version rules to pick between two unrelated packages.
    const packed = (name: string) => ({ pkg: pkg(name, "1.0.0"), tarball: `/tmp/${name}.tgz`, manifest: { name, version: "1.0.0" } });
    expect(mirrorable([packed(PLUGIN), packed(PACKAGE), packed("@voidbase-cloud/plugin-auth")]).map((p) => p.pkg.name)).toEqual([PACKAGE]);
    // by prefix and not by a list of four, because 7.6 to 7.10 add six more and a list would have to be remembered
    expect(NEVER_MIRROR.some((re) => re.test("@voidbase-cloud/plugin-anything-at-all"))).toBe(true);
    expect(NEVER_MIRROR.some((re) => re.test(PACKAGE) || re.test(FIXTURE))).toBe(false);
  });

  test("the smoke imports the entry an extraction exists to preserve, and only when the core is in the release", () => {
    // `@voidbase-cloud/voidbase/plugins/<name>` is what marketplace bundles import, and bundles are immutable. The
    // smoke otherwise only imports each package's root entry, so a broken re-export would pass every gate.
    const packed = (name: string) => ({ pkg: pkg(name, "1.0.0"), tarball: `/tmp/${name}.tgz`, manifest: { name, version: "1.0.0" } });
    expect(subpathEntries([packed(PLUGIN), packed(PACKAGE)])).toEqual([{ entry: `${PACKAGE}/plugins/realtime`, pkg: PLUGIN }]);
    // the subpath lives in the core's tarball: with no core in the release there is nothing to import it out of
    expect(subpathEntries([packed(PLUGIN)])).toEqual([]);
    expect(subpathEntries([packed(PACKAGE)])).toEqual([]);
  });

  test("the resolved sibling has to be the sibling that is actually there", () => {
    const dependent = pkg("@x/b", "1.2.4", { "@x/a": "workspace:*" });
    const right = { pkg: dependent, tarball: "/tmp/b.tgz", manifest: { name: "@x/b", version: "1.2.4", dependencies: { "@x/a": "1.2.4" } } };
    const stale = { ...right, manifest: { name: "@x/b", version: "1.2.4", dependencies: { "@x/a": "1.2.3" } } };
    const versions = new Map([["@x/a", "1.2.4"]]);
    expect(() => assertResolvedSiblings(right, versions, "here")).not.toThrow();
    expect(() => assertResolvedSiblings(stale, versions, "here")).toThrow(/resolved a sibling to the wrong version/);
    // a range is built on a version too, and it is that version the gate compares
    expect(specBase("^1.2.4")).toBe("1.2.4");
    expect(specBase("~1.2.4")).toBe("1.2.4");
    const ranged = { ...right, pkg: pkg("@x/b", "1.2.4", { "@x/a": "workspace:^" }), manifest: { name: "@x/b", version: "1.2.4", dependencies: { "@x/a": "^1.2.4" } } };
    expect(() => assertResolvedSiblings(ranged, versions, "here")).not.toThrow();
  });

  test("the committed lockfile says what the manifests say", () => {
    // A release repairs this at pack time, so nothing else ever notices it: `bun install --frozen-lockfile` checks
    // clean and exits 0 with the manifests at 1.0.1 and the lockfile at 1.0.0 (measured, bun 1.3.14), and
    // release-please cannot write a JSONC lockfile at all. Left alone, master sits in exactly the state the
    // resolved-sibling gate exists to catch. The fix when this fails is `bun install` and a commit of bun.lock.
    expect(lockfileDrift(ROOT)).toEqual([]);
  });

  test("the lockfile's workspace versions are written in step, and only those", () => {
    const lock = `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "root",\n    },\n    "packages/a": {\n      "name": "@x/a",\n      "version": "1.2.3",\n      "dependencies": {\n        "hono": "^4",\n      },\n    },\n  },\n  "packages": {\n    "hono": ["hono@4.0.0", "", {}, "sha512-x"],\n  },\n}\n`;
    const one = syncLockfile(lock, [pkg("@x/a", "1.2.4")]);
    expect(one.changed).toEqual(["packages/a 1.2.3 -> 1.2.4"]);
    expect(one.text).toBe(lock.replace('"version": "1.2.3"', '"version": "1.2.4"'));
    // idempotent, and a package the lockfile does not carry is simply not there to rewrite
    expect(syncLockfile(one.text, [pkg("@x/a", "1.2.4"), pkg("@x/gone", "1.2.4")]).changed).toEqual([]);
  });

  test("the pack directory has to be below the workspace root, and only its tarballs are deleted", async () => {
    // `--out` is an operator-supplied path and the directory is emptied at the start of a release. `.`, "", ".."
    // and "/" all resolve to somewhere that is not the release's to empty -- `--out .` is the repository, `.git`
    // and all. Refused before anything is deleted; measured against a throwaway copy of this tree below.
    const root = mkdtempSync(join(tmpdir(), "voidbase-out-"));
    expect(packDir(root, undefined)).toBe(join(root, "dist/packs"));
    expect(packDir(root, "dist/packs")).toBe(join(root, "dist/packs"));
    expect(packDir(root, "")).toBe(join(root, "dist/packs"));   // `||`, not `??`: "" resolves to the root
    for (const bad of [".", "..", "/", "dist/../..", root, tmpdir()]) expect(() => packDir(root, bad)).toThrow(/not a directory below/);
    // and emptying it is the tarballs in it, never the directory: whatever else is there is not the release's
    const packs = join(root, "dist/packs");
    mkdirSync(packs, { recursive: true });
    for (const f of ["old-1.0.0.tgz", "older-0.9.0.tgz", "notes.txt"]) writeFileSync(join(packs, f), "x");
    expect(clearPacks(packs).sort()).toEqual(["old-1.0.0.tgz", "older-0.9.0.tgz"]);
    expect(readdirSync(packs)).toEqual(["notes.txt"]);
    expect(clearPacks(join(root, "never-made"))).toEqual([]);

    // and the whole way through: a workspace shaped like this repository's, with `--out .`. Before the guard this
    // emptied it -- measured on a `git archive` copy of this tree, which went from 19 entries to none, `.git`
    // included -- and the throw came later, from a `bun pm pack` with no directory left to run in.
    const repo = mkdtempSync(join(tmpdir(), "voidbase-repo-"));
    mkdirSync(join(repo, "packages/thing"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "r", private: true, workspaces: ["packages/*"] }));
    writeFileSync(join(repo, "packages/thing/package.json"), JSON.stringify({ name: "@r/thing", version: "1.0.0" }));
    writeFileSync(join(repo, "bun.lock"), "{}\n");
    const before = readdirSync(repo).sort();
    await expect(publishWorkspace({ root: repo, out: ".", registry: "http://127.0.0.1:1", githubPackages: false, smoke: false, log: () => {} })).rejects.toThrow(/not a directory below/);
    expect(readdirSync(repo).sort()).toEqual(before);
    expect(existsSync(join(repo, ".git"))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test("the smoke project points every name at its own tarball, so a sibling is never looked up on the registry", () => {
    const project = smokeProject([
      { pkg: pkg("@x/a", "1.0.0"), tarball: "/tmp/a.tgz", manifest: { name: "@x/a", version: "1.0.0" } },
      { pkg: pkg("@x/b", "1.0.0", { "@x/a": "workspace:*" }), tarball: "/tmp/b.tgz", manifest: { name: "@x/b", version: "1.0.0", dependencies: { "@x/a": "1.0.0" } } },
    ]);
    expect(project.dependencies).toEqual({ "@x/a": "file:/tmp/a.tgz", "@x/b": "file:/tmp/b.tgz" });
    expect(project.overrides).toEqual(project.dependencies);
  });
});

describe("the hot release bump, in lockstep", () => {
  test("moves every workspace package to one version", () => {
    const { from, to, packages } = lockstep(readWorkspace(ROOT));
    const plugins = readWorkspace(ROOT).map((p) => p.name).filter((n) => n.startsWith("@voidbase-cloud/plugin-"));
    expect(packages.map((p) => p.name).sort()).toEqual([...plugins, FIXTURE, PACKAGE].sort());
    expect(to).not.toBe(from);
    expect(`${from.split(".").slice(0, -1).join(".")}.${Number(from.split(".").pop()) + 1}`).toBe(to);
  });
  test("the version a release is for is the core's, whatever the rest are on", () => {
    // Packages drift apart now: one nobody touched keeps the version it has while the core moves on. The release
    // is named after the core, because `@voidbase-cloud/voidbase` is what the repository is.
    const { from, to, packages } = lockstep([
      pkg(CORE, "0.9.0-beta.10", {}, { path: "packages/voidbase" }),
      pkg("@voidbase-cloud/plugin-x", "0.9.0-beta.3", {}, { path: "packages/plugin-x" }),
    ]);
    expect(from).toBe("0.9.0-beta.10");
    expect(to).toBe("0.9.0-beta.11");
    expect(packages.length).toBe(2);
    expect(() => lockstep([pkg("@x/a", "0.9.0-beta.1", {}, { private: true })])).toThrow(/no publishable package/);
    expect(() => lockstep([pkg("@x/a", "0.9.0-beta.1")])).toThrow(/no @voidbase-cloud\/voidbase/);
  });

  // What a release moves, now that it does not move everything. Each case is a reason a package has to be
  // republished even though the release is not about it.
  describe("the release set", () => {
    const core = () => pkg(CORE, "0.9.0-beta.10", { "@voidbase-cloud/plugin-a": "workspace:*", "@voidbase-cloud/plugin-b": "workspace:*" }, { path: "packages/voidbase" });
    const a = () => pkg("@voidbase-cloud/plugin-a", "0.9.0-beta.10", {}, { path: "packages/plugin-a" });
    const b = () => pkg("@voidbase-cloud/plugin-b", "0.9.0-beta.10", { "@voidbase-cloud/plugin-a": "workspace:*" }, { path: "packages/plugin-b" });

    test("nothing changed: the core alone, and the plugins keep the versions they have", () => {
      const set = releaseSet([core(), a(), b()], ["packages/voidbase/src/server/app.ts"], "0.9.0-beta.11");
      expect([...set]).toEqual([CORE]);
    });

    test("a package with a changed file is in it", () => {
      const set = releaseSet([core(), a(), b()], ["packages/plugin-a/src/index.ts"], "0.9.0-beta.11");
      expect([...set].sort()).toEqual([CORE, "@voidbase-cloud/plugin-a", "@voidbase-cloud/plugin-b"].sort());
    });

    test("and so is whatever depends on it, transitively, or the install would hold two copies of it", () => {
      // b names a exactly (`workspace:*` packs as a version). Bump a and leave b behind and the core names the new
      // a while b names the old one, which is two copies of a package that provides a service.
      const set = releaseSet([core(), a(), b()], ["packages/plugin-a/README.md"], "0.9.0-beta.11");
      expect(set.has("@voidbase-cloud/plugin-b")).toBe(true);
      // the other way round is not true: a does not depend on b, so touching b leaves a where it is
      const other = releaseSet([core(), a(), b()], ["packages/plugin-b/src/index.ts"], "0.9.0-beta.11");
      expect(other.has("@voidbase-cloud/plugin-a")).toBe(false);
    });

    test("a package whose peer range would no longer admit the core is in it, however untouched", () => {
      // the peer packs as `^<the core it was packed beside>`, which is the plugin's own version. Measured, not
      // assumed: `^0.9.0-beta.10` admits every later 0.9 -- the prereleases after it, 0.9.0 itself, and 0.9.9 --
      // and stops at 0.10.0. So a plugin rides out prereleases and patches untouched, and a minor pulls all of
      // them back in, which is the release that has to rebuild every package whether or not anything changed.
      for (const stays of ["0.9.0-beta.11", "0.9.1", "0.9.9"]) {
        expect([...releaseSet([core(), a()], [], stays)], stays).toEqual([CORE]);
      }
      for (const moves of ["0.10.0", "1.0.0"]) {
        expect([...releaseSet([core(), a()], [], moves)].sort(), moves).toEqual([CORE, "@voidbase-cloud/plugin-a"].sort());
      }
    });
  });
  test("the version field is rewritten in place, whatever it was", () => {
    const text = '{\n  "name": "@x/a",\n  "version": "0.0.0",\n  "dependencies": { "b": "1" }\n}\n';
    expect(bumpVersion(text, "0.0.0", "9.9.9")).toBe('{\n  "name": "@x/a",\n  "version": "9.9.9",\n  "dependencies": { "b": "1" }\n}\n');
    expect(bumpVersion(text, "not-what-it-says", "9.9.9")).toContain('"version": "9.9.9"');
    expect(() => bumpVersion('{ "name": "@x/a" }', "0.0.0", "9.9.9")).toThrow(/version/);
  });
  test("the notes go above the newest release a changelog already has", () => {
    expect(prependNotes("# Changelog\n\n## [1] (x)\n\n* old\n", "## [2] (y)\n\n* new\n")).toBe("# Changelog\n\n## [2] (y)\n\n* new\n\n## [1] (x)\n\n* old\n");
    expect(prependNotes(null, "## [2] (y)\n")).toBe("# Changelog\n\n## [2] (y)\n");
  });
});

describe("the publish loop, over a workspace of two, against a stubbed registry", () => {
  // a registry that answers the three things the loop asks of one: does this version exist, take this tarball, move
  // this dist-tag. Nothing in this block can reach npm: every command is given this origin.
  const published = new Map<string, Set<string>>();
  const puts: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (req.method === "PUT" && name.startsWith("-/package/")) return new Response(null, { status: 204 });
      if (req.method === "PUT") {
        const body = (await req.json()) as { name: string; versions: Record<string, unknown> };
        const have = published.get(body.name) ?? new Set<string>();
        for (const v of Object.keys(body.versions)) have.add(v);
        published.set(body.name, have);
        puts.push(`${body.name}@${Object.keys(body.versions).join(",")}`);
        return Response.json({ ok: true }, { status: 201 });
      }
      const have = published.get(name);
      if (!have) return Response.json({ error: "Not found" }, { status: 404 });
      const versions: Record<string, unknown> = {};
      for (const v of have) versions[v] = { name, version: v, dist: { tarball: `${url.origin}/${name}/-/x.tgz`, shasum: "0".repeat(40) } };
      return Response.json({ name, "dist-tags": { latest: [...have].at(-1) }, versions });
    },
  });
  const registry = `http://127.0.0.1:${server.port}`;
  const root = mkdtempSync(join(tmpdir(), "voidbase-ws-"));
  let token: string | undefined;

  beforeAll(async () => {
    token = process.env.NPM_TOKEN;
    process.env.NPM_TOKEN = "stub-registry-token";
    const write = (p: string, body: unknown) => writeFileSync(join(root, p), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
    mkdirSync(join(root, "packages/base"), { recursive: true });
    mkdirSync(join(root, "packages/dependent"), { recursive: true });
    mkdirSync(join(root, "packages/private-one"), { recursive: true });
    write("package.json", { name: "stub-workspace", private: true, workspaces: ["packages/*"] });
    write("packages/base/package.json", { name: "@vbtest/base", version: "1.2.3", type: "module", exports: { ".": "./index.js" }, bin: { "vbtest-base": "./cli.js" }, files: ["index.js", "cli.js"] });
    write("packages/base/index.js", 'export const who = "base";\n');
    write("packages/base/cli.js", '#!/usr/bin/env node\nconsole.log("vbtest-base " + process.argv.slice(2).join(" "));\n');
    write("packages/dependent/package.json", { name: "@vbtest/dependent", version: "1.2.3", type: "module", exports: { ".": "./index.js" }, files: ["index.js"], dependencies: { "@vbtest/base": "workspace:*" } });
    write("packages/dependent/index.js", 'export { who } from "@vbtest/base";\n');
    write("packages/private-one/package.json", { name: "@vbtest/private-one", version: "1.2.3", private: true });
    // `bun pm pack` resolves `workspace:*` out of the lockfile, so the workspace has to be installed before a
    // release packs it. CI installs first (scripts/ci.sh); here the test does.
    const install = await runCommand(["bun", "install"], { cwd: root });
    expect(install.code).toBe(0);
  }, 120_000);

  afterAll(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    if (token === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = token;
  });

  test("packs, proves, smoke-installs and publishes both, in dependency order", async () => {
    const log: string[] = [];
    const results = await publishWorkspace({ root, out: join(root, "out"), version: "1.2.3", registry, githubPackages: false, log: (l) => log.push(l) });
    expect(results.map((r) => `${r.name} ${r.action}`)).toEqual(["@vbtest/base published", "@vbtest/dependent published"]);
    expect(puts).toEqual(["@vbtest/base@1.2.3", "@vbtest/dependent@1.2.3"]);
    // the private package was never packed, let alone published
    expect(log.join("\n")).not.toContain("private-one");
    // the protocol was resolved on the way in, and the smoke install used both packages by name
    expect(log.join("\n")).toContain("@vbtest/base workspace:* -> 1.2.3");
    expect(log.join("\n")).toContain('@vbtest/dependent@1.2.3: import("@vbtest/dependent") -> 1 export(s)');
    expect(log.join("\n")).toContain("vbtest-base --help");
    const packed = await packedManifest(join(root, "out", "vbtest-dependent-1.2.3.tgz"));
    expect(packed.dependencies).toEqual({ "@vbtest/base": "1.2.3" });
  }, 300_000);

  test("a second run skips both instead of dying on the registry's refusal", async () => {
    const before = puts.length;
    const results = await publishWorkspace({ root, out: join(root, "out"), version: "1.2.3", registry, githubPackages: false, smoke: false, log: () => {} });
    expect(results.map((r) => `${r.name} ${r.action}`)).toEqual(["@vbtest/base skipped", "@vbtest/dependent skipped"]);
    expect(puts.length).toBe(before);
  }, 300_000);

  test("a half-finished release finishes: the sibling that never made it is the only one published", async () => {
    published.delete("@vbtest/dependent");
    const before = puts.length;
    const results = await publishWorkspace({ root, out: join(root, "out"), version: "1.2.3", registry, githubPackages: false, smoke: false, log: () => {} });
    expect(results.map((r) => `${r.name} ${r.action}`)).toEqual(["@vbtest/base skipped", "@vbtest/dependent published"]);
    expect(puts.slice(before)).toEqual(["@vbtest/dependent@1.2.3"]);
  }, 300_000);

  test("a manifest the packer did not rewrite never reaches the registry", async () => {
    // the same workspace, packed the way npm would have packed it: the loop must stop at the gate
    const out = join(root, "npm-out");
    mkdirSync(out, { recursive: true });
    const npm = await runCommand(["npm", "pack", "--ignore-scripts", "--pack-destination", out], { cwd: join(root, "packages/dependent") });
    expect(npm.code).toBe(0);
    const before = puts.length;
    await expect(
      publishWorkspace({
        root,
        out: join(root, "out2"),
        version: "1.2.3",
        registry,
        githubPackages: false,
        smoke: false,
        log: () => {},
        // the seam: pack exactly as npm packs, and watch the gate refuse the result
        run: async (cmd, opts) => (cmd[1] === "pm" && cmd[2] === "pack" ? runCommand(["npm", "pack", "--ignore-scripts", "--pack-destination", resolve(String(cmd[5]))], opts) : runCommand(cmd, opts)),
      }),
    ).rejects.toThrow(/unresolved workspace dependenc/);
    expect(puts.length).toBe(before);
  }, 300_000);

  test("a bump after the install would pack the release before it, and the gate stops that", async () => {
    // exactly the order hot mode produces: install, bump the manifests, pack. bun resolves `workspace:*` out of
    // bun.lock, and the lockfile still says 1.2.3.
    for (const f of ["packages/base/package.json", "packages/dependent/package.json", "packages/private-one/package.json"]) {
      writeFileSync(join(root, f), readFileSync(join(root, f), "utf8").replace('"version": "1.2.3"', '"version": "1.2.4"'));
    }
    const before = puts.length;
    await expect(publishWorkspace({ root, out: join(root, "out3"), version: "1.2.4", registry, githubPackages: false, smoke: false, syncLockfile: false, log: () => {} })).rejects.toThrow(/resolved a sibling to the wrong version/);
    expect(await packedManifest(join(root, "out3", "vbtest-dependent-1.2.4.tgz"))).toMatchObject({ dependencies: { "@vbtest/base": "1.2.3" } });
    expect(puts.length).toBe(before);
  }, 300_000);

  test("with the lockfile written in step it packs the version it is releasing", async () => {
    const log: string[] = [];
    const results = await publishWorkspace({ root, out: join(root, "out4"), version: "1.2.4", registry, githubPackages: false, smoke: false, log: (l) => log.push(l) });
    expect(log.join("\n")).toContain("bun.lock: packages/base 1.2.3 -> 1.2.4");
    expect(results.map((r) => `${r.name} ${r.action}`)).toEqual(["@vbtest/base published", "@vbtest/dependent published"]);
    expect(await packedManifest(join(root, "out4", "vbtest-dependent-1.2.4.tgz"))).toMatchObject({ dependencies: { "@vbtest/base": "1.2.4" } });
  }, 300_000);

  test("a package that names the private sibling is refused, tarball in hand, before anything is published", async () => {
    // the smoke install would find this only as a 404 that says nothing about why, --no-smoke skips it, and if
    // that name happens to exist on npm the install succeeds and ships a dependency on someone else's package
    const file = join(root, "packages/dependent/package.json");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace('"dependencies": {', '"dependencies": {\n    "@vbtest/private-one": "1.2.4",'));
    const before = puts.length;
    try {
      await expect(publishWorkspace({ root, out: join(root, "out5"), version: "1.2.4", registry, githubPackages: false, smoke: false, log: () => {} })).rejects.toThrow(/never publishes: dependencies\.@vbtest\/private-one/);
      expect(puts.length).toBe(before);
    } finally {
      writeFileSync(file, original);
    }
  }, 300_000);

  test("a dry run publishes nothing and writes nothing, the lockfile included", async () => {
    const lock = join(root, "bun.lock");
    const asCommitted = readFileSync(lock, "utf8");
    // first the honest case: everything at 1.2.4 is already on the registry, so the whole loop skips
    const log: string[] = [];
    const results = await publishWorkspace({ root, out: join(root, "out6"), version: "1.2.4", registry, githubPackages: false, smoke: false, dryRun: true, log: (l) => log.push(l) });
    expect(results.map((r) => `${r.name} ${r.action}`)).toEqual(["@vbtest/base skipped", "@vbtest/dependent skipped"]);
    expect(log.join("\n")).toContain("(dry run)");
    expect(readFileSync(lock, "utf8")).toBe(asCommitted);
    // and the case that used to leave a developer with a modified bun.lock: the manifests move, the lockfile is
    // behind, and a rehearsal says so instead of quietly repairing the working tree it was asked to rehearse
    const files = ["packages/base/package.json", "packages/dependent/package.json", "packages/private-one/package.json"];
    const originals = files.map((f) => readFileSync(join(root, f), "utf8"));
    for (const f of files) writeFileSync(join(root, f), readFileSync(join(root, f), "utf8").replace('"version": "1.2.4"', '"version": "1.2.5"'));
    const behind: string[] = [];
    const before = puts.length;
    try {
      await expect(publishWorkspace({ root, out: join(root, "out7"), version: "1.2.5", registry, githubPackages: false, smoke: false, dryRun: true, log: (l) => behind.push(l) })).rejects.toThrow(/resolved a sibling to the wrong version/);
      expect(behind.join("\n")).toContain("bun.lock: packages/base 1.2.4 -> 1.2.5 (dry run: not written)");
      expect(readFileSync(lock, "utf8")).toBe(asCommitted);
      expect(puts.length).toBe(before);
    } finally {
      files.forEach((f, i) => writeFileSync(join(root, f), originals[i]!));
    }
  }, 300_000);
});

describe("the GitHub Packages mirror, over a workspace shaped like this one", () => {
  // The mirror is where the release is not the only publisher of these names, so it is the one loop that has to
  // leave a package out. Two stub registries on localhost, so which package reached which one is a measurement and
  // not an argument: the npm stub is the registry of record and takes both packages, the mirror stub takes the core
  // and never sees the plugin. Nothing here can reach npmjs or npm.pkg.github.com -- every command is given an
  // origin, and `githubPackagesRegistry` is the only reason that option exists.
  const stub = (puts: string[]) => {
    const published = new Map<string, Set<string>>();
    return Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
        if (req.method === "PUT" && name.startsWith("-/package/")) return new Response(null, { status: 204 });
        if (req.method === "PUT") {
          const body = (await req.json()) as { name: string; versions: Record<string, unknown> };
          published.set(body.name, new Set(Object.keys(body.versions)));
          puts.push(`${body.name}@${Object.keys(body.versions).join(",")}`);
          return Response.json({ ok: true }, { status: 201 });
        }
        const have = published.get(name);
        if (!have) return Response.json({ error: "Not found" }, { status: 404 });
        const versions: Record<string, unknown> = {};
        for (const v of have) versions[v] = { name, version: v, dist: { tarball: `${url.origin}/${name}/-/x.tgz`, shasum: "0".repeat(40) } };
        return Response.json({ name, "dist-tags": { latest: [...have].at(-1) }, versions });
      },
    });
  };
  const npmPuts: string[] = [];
  const mirrorPuts: string[] = [];
  const npmStub = stub(npmPuts);
  const mirrorStub = stub(mirrorPuts);
  const registry = `http://127.0.0.1:${npmStub.port}`;
  const mirror = `http://127.0.0.1:${mirrorStub.port}`;
  const root = mkdtempSync(join(tmpdir(), "voidbase-mirror-"));
  const PLUGIN_STUB = "@voidbase-cloud/plugin-stub";
  let npmToken: string | undefined;
  let ghToken: string | undefined;

  beforeAll(async () => {
    npmToken = process.env.NPM_TOKEN; ghToken = process.env.GH_PACKAGES_TOKEN;
    process.env.NPM_TOKEN = "stub-registry-token"; process.env.GH_PACKAGES_TOKEN = "stub-mirror-token";
    const write = (p: string, body: unknown) => writeFileSync(join(root, p), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
    mkdirSync(join(root, "packages/voidbase"), { recursive: true });
    mkdirSync(join(root, "packages/plugin-stub"), { recursive: true });
    write("package.json", { name: "mirror-workspace", private: true, workspaces: ["packages/*"] });
    // the real shape: the core depends on the plugin, the plugin peer-depends back on the core
    write("packages/voidbase/package.json", { name: PACKAGE, version: "1.2.3", type: "module", exports: { ".": "./index.js" }, files: ["index.js"], dependencies: { [PLUGIN_STUB]: "workspace:*" } });
    write("packages/voidbase/index.js", 'export { plugin } from "@voidbase-cloud/plugin-stub";\n');
    write("packages/plugin-stub/package.json", { name: PLUGIN_STUB, version: "1.2.3", type: "module", exports: { ".": "./index.js" }, files: ["index.js"], peerDependencies: { [PACKAGE]: "workspace:*" } });
    write("packages/plugin-stub/index.js", 'export const plugin = { manifest: { name: "stub" } };\n');
    const install = await runCommand(["bun", "install"], { cwd: root });
    expect(install.code).toBe(0);
  }, 120_000);

  afterAll(() => {
    npmStub.stop(true); mirrorStub.stop(true);
    rmSync(root, { recursive: true, force: true });
    if (npmToken === undefined) delete process.env.NPM_TOKEN; else process.env.NPM_TOKEN = npmToken;
    if (ghToken === undefined) delete process.env.GH_PACKAGES_TOKEN; else process.env.GH_PACKAGES_TOKEN = ghToken;
  });

  test("publishes both to npm, mirrors the core, and says by name what it left off the mirror", async () => {
    const log: string[] = [];
    const results = await publishWorkspace({ root, out: join(root, "out"), version: "1.2.3", registry, githubPackagesRegistry: mirror, smoke: false, log: (l) => log.push(l) });
    // npm is the registry of record and takes the whole workspace, plugin first because the core depends on it
    expect(results.map((r) => `${r.name} ${r.action}`)).toEqual([`${PLUGIN_STUB} published`, `${PACKAGE} published`]);
    expect(npmPuts).toEqual([`${PLUGIN_STUB}@1.2.3`, `${PACKAGE}@1.2.3`]);
    // the mirror takes the core and nothing else
    expect(mirrorPuts).toEqual([`${PACKAGE}@1.2.3`]);
    expect(log).toContain(`  GitHub Packages: ${PLUGIN_STUB} is not mirrored (NEVER_MIRROR: that name is another repository's there)`);
    expect(log).toContain(`  GitHub Packages: ${PACKAGE}@1.2.3`);
  }, 300_000);

  test("a second run mirrors nothing again: the mirror loop is idempotent like the publish loop", async () => {
    const log: string[] = [];
    await publishWorkspace({ root, out: join(root, "out2"), version: "1.2.3", registry, githubPackagesRegistry: mirror, smoke: false, log: (l) => log.push(l) });
    expect(mirrorPuts).toEqual([`${PACKAGE}@1.2.3`]);
    expect(log).toContain(`  GitHub Packages: ${PACKAGE}@1.2.3 is already there`);
    expect(log).toContain(`  GitHub Packages: ${PLUGIN_STUB} is not mirrored (NEVER_MIRROR: that name is another repository's there)`);
  }, 300_000);

  test("--no-github-packages still leaves the npm publish alone, and the refusal is not a publish gate", async () => {
    // the plugin is off the mirror and on npm; nothing about `NEVER_MIRROR` belongs in `publishable()`
    expect(publishable(readWorkspace(root)).map((p) => p.name)).toEqual([PLUGIN_STUB, PACKAGE]);
    const log: string[] = [];
    await publishWorkspace({ root, out: join(root, "out3"), version: "1.2.3", registry, githubPackages: false, smoke: false, log: (l) => log.push(l) });
    expect(log.some((l) => l.includes("GitHub Packages"))).toBe(false);
  }, 300_000);
});

// A first publish is accepted by the registry before an install can resolve it: npm writes the version document
// first and the packument installers read a little later. Measured at 210 seconds on
// @voidbase-cloud/plugin-realtime@0.9.0-beta.53, during which `bun add @voidbase-cloud/voidbase@0.9.0-beta.53`
// failed on the sibling the core names exactly. So the loop waits, and gives up rather than shipping a dependent
// into that window.
describe("a package a later one depends on has to be resolvable, not merely accepted", () => {
  test("the loop waits for the registry to answer before publishing the dependent", async () => {
    let resolvable = false;
    const order: string[] = [];
    const seen: string[] = [];
    const ready = await until(async () => { seen.push("ask"); return resolvable; }, 120, () => {}, 20);
    expect(ready).toBe(false);                       // it gives up rather than answering true
    expect(seen.length).toBeGreaterThan(1);          // and it asked more than once
    resolvable = true;
    expect(await until(async () => resolvable, 1_000, () => {}, 20)).toBe(true);
    expect(order).toEqual([]);
  });

  test("RESOLVABLE_TIMEOUT_MS is longer than the gap that was measured", () => {
    expect(RESOLVABLE_TIMEOUT_MS).toBeGreaterThan(210_000);
  });
});

// ...and the shape of the waiting, which is what decides whether the release this repository is about to make can
// finish at all. One wait is 210 seconds. After 7.6 the core depends on ten plugin packages, nine of them names npm
// has never seen, so a loop that waits once per name owes about 31 minutes of waiting inside a Cloudflare Workers
// build that is killed at 20 (docs/ci.md). `publishWaves` cuts the run into levels and `publishPacked` publishes a
// whole level before it asks about any of it, so the waits a level owes the next one overlap and the release pays
// about one of them. The ordering guarantee is unchanged: a level does not start until the previous one answers.
describe("the resolvable waits overlap, because a release with nine first publishes cannot afford them one at a time", () => {
  test("the waves are the levels of the dependency graph, and the core is alone in the last one", () => {
    const real = publishable(readWorkspace(ROOT));
    const waves = publishWaves(real);
    const names = new Set(real.map((p) => p.name));
    // every package sits strictly after every sibling it depends on, which is the whole guarantee: a wave is
    // published together, so nothing in one may need anything else in it
    const waveOf = new Map(waves.flatMap((w, i) => w.map((p) => [p.name, i] as const)));
    for (const p of real) for (const dep of dependsOn(p, names)) {
      expect(waveOf.get(dep)!, `${p.name} shares a wave with ${dep}, which it depends on`).toBeLessThan(waveOf.get(p.name)!);
    }
    expect(waves.at(-1)!.map((p) => p.name)).toEqual([PACKAGE]);   // the core depends on all of them, so it is last
    expect(waves[0]!.length).toBeGreaterThan(1);                   // and the leaves go out together, not one by one
    // a chain cannot be overlapped and is not: each link is its own wave, which is the serial shape and correct
    const chain = [pkg("@x/c", "1.0.0", { "@x/b": "workspace:*" }), pkg("@x/a", "1.0.0"), pkg("@x/b", "1.0.0", { "@x/a": "workspace:*" })];
    expect(publishWaves(chain).map((w) => w.map((p) => p.name))).toEqual([["@x/a"], ["@x/b"], ["@x/c"]]);
    // a leaf that sorts after a dependent still joins the first wave: levels, not the order the sort produced
    const mixed = [pkg("@x/b", "1.0.0", { "@x/a": "workspace:*" }, { path: "packages/b" }), pkg("@x/a", "1.0.0", {}, { path: "packages/a" }), pkg("@x/c", "1.0.0", {}, { path: "packages/c" })];
    expect(publishOrder(mixed).map((p) => p.name)).toEqual(["@x/a", "@x/b", "@x/c"]);
    expect(publishWaves(mixed).map((w) => w.map((p) => p.name))).toEqual([["@x/a", "@x/c"], ["@x/b"]]);
    expect(() => publishWaves([pkg("@x/a", "1.0.0", { "@x/b": "workspace:*" }), pkg("@x/b", "1.0.0", { "@x/a": "workspace:*" })])).toThrow(/cycle/);
  });

  // The measurement. A stub registry on localhost behaves the way npm's did on a first publish: the PUT is
  // accepted at once, and the packument a resolvability check reads answers 404 for a fixed lag afterwards. 210
  // seconds is that lag in production; here it is LAG_MS, so the measurement is a test and not a coffee break.
  // Nothing in this block can reach npm: every request goes to this origin, and `npm publish` is never run.
  const LAG_MS = 500;
  const N = 9;                                      // the nine names 7.6 publishes for the first time
  const CORE_NAME = "@vbwave/core";
  const acceptedAt = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
      if (req.method === "PUT") { acceptedAt.set(key, Date.now()); return new Response(null, { status: 201 }); }
      const at = acceptedAt.get(key);
      if (at === undefined) return new Response("no such version", { status: 404 });
      // the version document is there the instant it is taken; the packument an install reads is not, for LAG_MS
      return Date.now() - at >= LAG_MS ? new Response("1.0.0") : new Response("no packument yet", { status: 404 });
    },
  });
  const registry = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));

  const version = "1.0.0";
  const asPacked = (p: Pkg): Packed => ({ pkg: p, tarball: `/nowhere/${p.name.replace(/[@/]/g, "-")}.tgz`, manifest: { name: p.name, version: p.version } });
  const leaves = [...Array(N)].map((_, i) => pkg(`@vbwave/leaf-${i}`, version, {}, { path: `packages/leaf-${i}` }));
  const core = pkg(CORE_NAME, version, Object.fromEntries(leaves.map((l) => [l.name, "workspace:*"])), { path: "packages/core" });
  const packed = [...leaves, core].map(asPacked);
  const byTarball = new Map(packed.map((p) => [p.tarball, p.pkg]));
  const key = (name: string) => encodeURIComponent(`${name}@${version}`);
  /** the publish, as far as this registry is concerned: the PUT that takes the version */
  const put = (name: string) => fetch(`${registry}/${key(name)}`, { method: "PUT" });
  const isResolvable: IsPublished = async (name, v) => (await fetch(`${registry}/${encodeURIComponent(`${name}@${v}`)}`)).ok;
  const publishedOrder: string[] = [];
  const run: Run = async (cmd) => {
    if (cmd[1] === "publish") { const p = byTarball.get(cmd[2]!)!; publishedOrder.push(p.name); await put(p.name); }
    return { code: 0, stdout: "", stderr: "" };
  };

  test(`${N} first publishes and a core that names them all: serial costs ${N} lags, the loop costs one`, async () => {
    // the shape the loop had before this was closed, written out because it is the baseline being beaten -- and
    // written with the same `until` the loop uses, so the two numbers are measured the same way
    acceptedAt.clear();
    const serialStarted = Date.now();
    for (const p of packed) {
      await put(p.pkg.name);
      if (p.pkg.name !== CORE_NAME) expect(await until(() => isResolvable(p.pkg.name, version, registry), 30_000, () => {}, 25), p.pkg.name).toBe(true);
    }
    const serialMs = Date.now() - serialStarted;

    // and the loop as it is now
    acceptedAt.clear();
    publishedOrder.length = 0;
    const log: string[] = [];
    const overlappedStarted = Date.now();
    const results = await publishPacked(packed, { registry, tag: "latest", log: (l) => log.push(l), run, isPublished: isResolvable, pollMs: 25, timeoutMs: 30_000 });
    const overlappedMs = Date.now() - overlappedStarted;

    // every package published, the core last, and the whole run in wave order
    expect(results.map((r) => r.action)).toEqual([...Array(N + 1)].map(() => "published"));
    expect(results.map((r) => r.name)).toEqual([...leaves.map((l) => l.name), CORE_NAME]);
    expect(publishedOrder).toEqual(results.map((r) => r.name));

    // the ordering guarantee, measured rather than reasoned about: the core's own publish is at least one lag
    // after the last leaf was accepted, which is the only way every leaf can have been resolvable before it
    const coreAt = acceptedAt.get(decodeURIComponent(key(CORE_NAME)))!;
    const lastLeafAt = Math.max(...leaves.map((l) => acceptedAt.get(decodeURIComponent(key(l.name)))!));
    expect(coreAt - lastLeafAt).toBeGreaterThanOrEqual(LAG_MS);

    // and the cost: N lags against one. The bound is deliberately loose -- what is being pinned is the shape, not
    // the machine -- but the real numbers are printed, because those are the evidence.
    console.log(`  resolvable wait, ${N} first publishes at a ${LAG_MS}ms packument lag: serial ${serialMs}ms (~${(serialMs / LAG_MS).toFixed(1)} lags), overlapped ${overlappedMs}ms (~${(overlappedMs / LAG_MS).toFixed(1)} lags)`);
    expect(overlappedMs).toBeGreaterThanOrEqual(LAG_MS);          // it really did wait: the guarantee is not skipped
    expect(serialMs).toBeGreaterThanOrEqual(N * LAG_MS);          // and the baseline really is N of them
    expect(overlappedMs).toBeLessThan(serialMs / 3);              // 9x in principle; a third of it is the pin

    // the log says so as well, which is what an operator watching a release sees
    expect(log.join("\n")).toContain(`waiting for ${N} package(s) to become resolvable, together, before wave 2 (${CORE_NAME})`);
    expect(log.filter((l) => l.includes("resolvable after")).length).toBe(1);
  }, 120_000);

  test("a package nothing else in the run names is never waited for at all", async () => {
    acceptedAt.clear();
    const log: string[] = [];
    const alone = [asPacked(pkg("@vbwave/only", version, {}, { path: "packages/only" }))];
    const started = Date.now();
    const results = await publishPacked(alone, { registry, tag: "latest", log: (l) => log.push(l), run: async () => { await put("@vbwave/only"); return { code: 0, stdout: "", stderr: "" }; }, isPublished: isResolvable, pollMs: 25, timeoutMs: 30_000 });
    expect(results.map((r) => r.action)).toEqual(["published"]);
    expect(Date.now() - started).toBeLessThan(LAG_MS);            // it did not wait for a packument nobody reads
    expect(log.join("\n")).not.toContain("resolvable");
  }, 60_000);

  test("a wave that never becomes resolvable fails, and names every package the run is still waiting on", async () => {
    acceptedAt.clear();
    publishedOrder.length = 0;
    const never: IsPublished = async () => false;
    await expect(publishPacked(packed, { registry, tag: "latest", log: () => {}, run, isPublished: never, pollMs: 25, timeoutMs: 300 }))
      .rejects.toThrow(/were published but the registry still does not answer for them after 0.3s, and @vbwave\/core name them/);
    // and the dependent was never published into that window
    expect(publishedOrder).not.toContain(CORE_NAME);
  }, 60_000);
});
