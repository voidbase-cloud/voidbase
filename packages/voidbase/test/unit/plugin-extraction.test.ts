// A shipped plugin as a package of its own (7.5), measured on the first one out: realtime.
//
// The entry point `@voidbase-cloud/voidbase/plugins/realtime` does not move and never will -- a marketplace bundle
// is audited, bundled and hashed against the names it imports, and those bundles are immutable -- so what has to be
// true after an extraction is that the name still reaches the plugin, that it reaches the *same* plugin the core
// loads, and that the package behind it is built out of the published surface rather than out of the core's
// insides. Each of those is a rule and not a fact about realtime, so each is written against every
// `@voidbase-cloud/plugin-*` package the workspace holds: 7.6 to 7.10 add a directory and inherit the suite.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pbHooksPlugin } from "../../hooks-plugin";
import corePkg from "../../package.json" with { type: "json" };
import { providedImport } from "../../src/node/installed";
import { PROVIDED, refusalFor } from "../../src/node/provided";
import { loadInstalled } from "../../src/platform/node/plugins";
import { integrityOf } from "../../src/node/registry";
import { createKernel, load, using, whatLoaded } from "../../src/server/kernel";
import { SHIPPED } from "../../src/server/plugins/shipped";
import { NEVER_MIRROR, readWorkspace } from "../../../../scripts/publish";
import { Tree } from "../../../../scripts/ci-plan";

const ROOT = resolve(import.meta.dir, "../../../..");
const CORE = "@voidbase-cloud/voidbase";
/** the extracted plugin packages of this workspace, by name: one today, nine more by the end of 7.10 */
const packages = readWorkspace(ROOT).filter((p) => p.name.startsWith("@voidbase-cloud/plugin-"));
/** the module specifiers a source file imports or re-exports */
const specifiersOf = (source: string): string[] => [...source.matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm)].map((m) => m[1]!);
const filesOf = (dir: string): string[] => [...new Bun.Glob("**/*.ts").scanSync({ cwd: dir })].map((f) => join(dir, f));
/** the package a specifier belongs to: `hono/streaming` is `hono`, `@voidbase-cloud/voidbase/kernel` is the core */
const packageOf = (spec: string): string => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
/** the repository's own import graph, built once: `git ls-files` is not free and every package below asks it */
const tree = new Tree();

describe("the workspace's extracted plugin packages", () => {
  test("there is at least one, and realtime is the first", () => {
    expect(packages.map((p) => p.name)).toContain("@voidbase-cloud/plugin-realtime");
  });

  for (const pkg of packages) {
    const shipped = pkg.name.slice("@voidbase-cloud/plugin-".length);
    const entry = `./plugins/${shipped}`;

    // The one rule that makes a package a package. Inside the core a plugin reached the rest of it by relative path
    // and by `#platform/*`, and neither travels: a relative path out of the package lands in the consumer's
    // node_modules, and `#platform/*` is package-private and resolves to nothing at all from here. So every import
    // that is not the package's own has to be a name the core publishes -- and, since the same file is bundled into
    // a Worker and loaded on Bun, a name an *instance* hands over rather than one it refuses.
    //
    // `hono` is the one other name a bundle may import (src/node/provided.ts), and a plugin package with routes will
    // -- ten of the shipped plugin files already do. Being allowed to import it is not the same as being allowed to
    // leave it undeclared: an install resolves what the manifest names and nothing else, so the rule here is that
    // every specifier outside the package is a package this one's own manifest declares.
    //
    // And the rule the other way round, because the template carried `hono` into all ten manifests while two of
    // them import it: a peer a package never names is a constraint it does not have, and npm 7+ and bun both
    // auto-install peers, so it is also a package every standalone install of it pulls down for nothing. A
    // type-only import counts as importing it -- `tsconfig.json` and `scripts.check` are in the tarball, so an
    // installed copy is expected to be able to type-check itself, and the types are in the package's own
    // signatures either way. The core is the exception: it is peer-depended on by every plugin package and
    // imported by name by nearly all of them, and a package that happens to need nothing of it still has to say
    // which instances it loads into.
    test(`${pkg.name} reaches the core only through entries an instance provides, and declares what else it imports`, () => {
      const names = new Set(packages.map((q) => q.name));
      const files = filesOf(join(pkg.dir, "src"));
      expect(files.length).toBeGreaterThan(0);
      const declared = { ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies, ...pkg.manifest.optionalDependencies };
      const outside: string[] = [];
      for (const f of files) {
        for (const spec of specifiersOf(readFileSync(f, "utf8"))) {
          if (spec.startsWith(".")) continue;   // the package's own files
          if (spec.startsWith("node:")) continue;   // a builtin, which both flavours answer: nothing declares it
          if (spec === CORE || spec.startsWith(`${CORE}/`)) {
            expect(refusalFor(spec), `${f} imports ${spec}`).toBeNull();
            expect(PROVIDED[spec], `${f} imports ${spec}, which no instance hands a plugin`).toBeDefined();
            continue;
          }
          if (spec === "hono" || spec.startsWith("hono/")) {   // the one other specifier a plugin may have
            expect(declared["hono"], `${f} imports ${spec}, which ${pkg.path}/package.json declares no source for`).toBeDefined();
            continue;
          }
          // A sibling plugin package, which the chain 7.7 extracts needs: mcp is written from openapi's document
          // and ai answers with mcp's tools. It names the package it uses rather than the core's re-export of it,
          // because the re-export would put a module of the core in its closure to reach a package beside it. The
          // sibling has to be declared as a dependency, and the release publishes it first: `publishOrder` reads
          // exactly these edges, so openapi is on the registry and resolvable before mcp, and mcp before ai.
          if (/^@voidbase-cloud\/plugin-[^/]+$/.test(spec)) {
            expect(names.has(spec), `${f} imports ${spec}, which is not a package of this workspace`).toBe(true);
            expect(declared[spec], `${f} imports ${spec}, which ${pkg.path}/package.json declares no source for`).toBeDefined();
            continue;
          }
          outside.push(`${f} imports ${spec}`);
        }
      }
      expect(outside).toEqual([]);
      // and nothing package-private travelled with the file
      for (const f of files) expect(specifiersOf(readFileSync(f, "utf8")).filter((s) => s.startsWith("#")), f).toEqual([]);
      // said once more the other way round, so a package that reaches for something new has to name it: the rule is
      // not a list of two blessed prefixes, it is "declared in this manifest"
      const imported = new Set<string>();
      for (const f of files) for (const spec of specifiersOf(readFileSync(f, "utf8"))) {
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        expect(declared[packageOf(spec)], `${f} imports ${spec}; ${pkg.path}/package.json declares no ${packageOf(spec)}`).toBeDefined();
        imported.add(packageOf(spec));
      }
      // ...and nothing it does not import, the core aside
      expect(Object.keys(declared).filter((n) => n !== CORE && !imported.has(n)), `${pkg.path}/package.json declares what it never imports`).toEqual([]);
    });

    // A plugin package is loaded by the core, and the core loads it from `src/server/plugins/<name>.ts`, which is
    // one line of re-export imported by app.ts at module scope. If the package's own closure came back through any
    // of those, the two modules would be in a cycle at load: on Bun the plugin's module body would run against a
    // half-initialised core, and the Workers bundle would have to break the cycle itself. Nothing forbids it today
    // except the shape of the imports, so the shape is what is measured -- while realtime is the only package and
    // the closure is 43 files under both conditions, this costs nothing to keep true.
    for (const flavour of ["workerd", "bun"] as const) {
      test(`${pkg.name} does not import its way back into the core's loading modules (${flavour})`, () => {
        const entry = tree.workspaceFile(pkg.name, flavour);
        expect(entry, `${pkg.name} does not resolve to a tracked file`).toBe(`${pkg.path}/src/index.ts`);
        const closure = tree.closure([entry!], flavour);
        // it really did resolve into the core rather than stopping at the package boundary
        expect([...closure].some((f) => f.startsWith("packages/voidbase/src/")), "the closure never reached the core").toBe(true);
        for (const back of ["packages/voidbase/src/server/app.ts", `packages/voidbase/src/server/plugins/${shipped}.ts`, "packages/voidbase/src/server/plugins/shipped.ts"]) {
          expect([...closure], `${pkg.name} reaches ${back}, which loads it`).not.toContain(back);
        }
      });
    }

    test(`${pkg.name} and the core name each other, in lockstep`, () => {
      const core = readWorkspace(ROOT).find((p) => p.name === CORE)!;
      // the core depends on the package: that is what keeps the plugin shipped and on by default, and the
      // dependency is named by the entry the core publishes rather than by the application
      expect(core.manifest.dependencies?.[pkg.name]).toBe("workspace:*");
      expect(readFileSync(resolve(ROOT, "packages/voidbase/src/server/plugins", `${shipped}.ts`), "utf8")).toContain(`from "${pkg.name}"`);
      expect(readFileSync(resolve(ROOT, "packages/voidbase/src/server/app.ts"), "utf8")).toContain(`from "./plugins/${shipped}"`);
      // the package peer-depends back, which is a statement about the instance it is loaded into and not an
      // ordering edge (scripts/publish.ts, ORDER_MAPS); it declares no dependency on the core, or the pair would
      // be a real cycle.
      //
      // `workspace:*` on a peer edge packs as the sibling's *exact* version, not a range -- narrower than the
      // `>=0.9.0-beta.5` the standalone plugin repositories use. That is the shape on purpose and is the decision
      // recorded in docs/plugins.md: the versions are lockstep and the core hard-pins the plugin at its own
      // version through `dependencies`, so an install that has the core has exactly one plugin version available
      // to satisfy the peer anyway, and a range would only widen the set of pairs the manifest *claims* work
      // beyond the one pair that was ever built or tested.
      // `workspace:^`, not `workspace:*`: it packs as a caret on the core's version, and a release no longer moves
      // every package, so an unchanged plugin has to go on admitting the cores that come after it. An exact pin
      // would make a plugin uninstallable beside the next core, which is how it was until the release stopped
      // republishing what had not changed.
      expect(pkg.manifest.peerDependencies?.[CORE]).toBe("workspace:^");
      expect(pkg.manifest.dependencies?.[CORE]).toBeUndefined();
      // the package is at the core's version or behind it, never ahead: it was last released with some core, and
      // the core has released since without it
      expect(Bun.semver.order(pkg.version, core.version)).toBeLessThanOrEqual(0);
      // and whatever it is on, the core it ships beside satisfies the range it declares
      expect(Bun.semver.satisfies(core.version, `^${pkg.version}`), `${pkg.name}@${pkg.version} does not admit the core at ${core.version}`).toBe(true);
      expect(pkg.private).toBe(false);
    });

    // Two places run a plugin package's own tsc, and they must not disagree about which packages there are: CI
    // globs `packages/plugin-*/tsconfig.json`, so a new package is covered there the moment it has one, while the
    // root `check` script names each package and is the half a new extraction has to remember.
    test(`${pkg.name} is type-checked on its own, by \`bun run check\` and by scripts/ci.sh`, () => {
      expect(existsSync(resolve(ROOT, pkg.path, "tsconfig.json"))).toBe(true);
      expect(readFileSync(resolve(ROOT, "scripts/ci.sh"), "utf8")).toContain("packages/plugin-*/tsconfig.json");
      const root = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
      expect(root.scripts.check, `the root check script does not reach ${pkg.path}`).toContain(pkg.path.slice("packages/".length));
    });

    // What the manifest says about itself has to be true of the tarball, because the manifest is all a consumer
    // has: `files` is what is in it, and a `scripts` entry naming a file that is not is a command that fails in
    // every installed copy (`tsc -p tsconfig.json` with no tsconfig.json is TS5058). One entry of `files` is
    // allowed not to exist in the checkout -- CHANGELOG.md, which `scripts/hot-release.ts` writes for every
    // publishable package as part of the release commit, so the tarball has it and the working tree need not.
    test(`${pkg.name}'s published manifest describes the tarball it packs`, () => {
      const m = JSON.parse(readFileSync(resolve(ROOT, pkg.path, "package.json"), "utf8")) as { files: string[]; scripts?: Record<string, string> };
      expect(m.files.length).toBeGreaterThan(0);
      const packs = (path: string) => m.files.some((f) => f === path || path.startsWith(`${f}/`));
      for (const [name, cmd] of Object.entries(m.scripts ?? {})) {
        for (const word of cmd.split(/\s+/)) {
          if (!/^[\w./-]+\.(json|ts|tsx|js|sh)$/.test(word)) continue;
          expect(packs(word), `scripts.${name} runs \`${cmd}\`, and ${word} is not in "files"`).toBe(true);
        }
      }
      for (const f of m.files) {
        if (f === "CHANGELOG.md") { expect(readFileSync(resolve(ROOT, "scripts/hot-release.ts"), "utf8")).toContain("CHANGELOG.md"); continue; }
        expect(existsSync(resolve(ROOT, pkg.path, f)), `"files" names ${f}, which ${pkg.path} does not have`).toBe(true);
      }
    });

    // The mirror, and the reason this package is not on it. `@voidbase-cloud/plugin-realtime` already exists on
    // GitHub Packages, published by voidbase-cloud/voidbase-plugin-realtime at its own version and export shape,
    // and the marketplace lists that one until 7.11 archives it. A release mirrors what it publishes to npm, so
    // without this refusal the monorepo would publish over it. npmjs is the registry of record and takes them all.
    test(`${pkg.name} is published to npm and never mirrored to GitHub Packages`, () => {
      expect(NEVER_MIRROR.some((re) => re.test(pkg.name))).toBe(true);
      expect(NEVER_MIRROR.some((re) => re.test(CORE))).toBe(false);
    });

    test(`${CORE}${entry.slice(1)} is the package, re-exported`, async () => {
      const target = (corePkg.exports as Record<string, string>)[entry];
      expect(target, `${entry} is published`).toBeDefined();
      expect(existsSync(resolve(ROOT, "packages/voidbase", target!))).toBe(true);
      const viaCore = (await import(`${CORE}${entry.slice(1)}`)) as Record<string, unknown>;
      const viaPackage = (await import(pkg.name)) as Record<string, unknown>;
      // the same object, not a copy with the same shape: one plugin, one `realtime@1` registration
      expect(Object.keys(viaCore).sort()).toEqual(Object.keys(viaPackage).sort());
      for (const k of Object.keys(viaPackage)) expect(viaCore[k], k).toBe(viaPackage[k]);
      // exactly one of the package's exports is the plugin, and its manifest carries the name the entry promises.
      // realtime exported nothing else, so the first export was the plugin; a package with knobs, an `info()` or a
      // `<name>With()` beside it exports several, and an ES namespace orders its keys alphabetically, so "the first
      // one" would have been whichever constant sorts first.
      const isPlugin = (v: unknown): v is { manifest: { name: string } } =>
        typeof v === "object" && v !== null && typeof (v as { manifest?: { name?: unknown } }).manifest?.name === "string";
      const plugins = Object.values(viaPackage).filter(isPlugin);
      expect(plugins.map((p) => p.manifest.name)).toEqual([shipped]);
      expect(SHIPPED).toContain(shipped);
    });

    // The Worker half of the same name. A bundle's bare import is resolved at build time by `providedImport`, which
    // reads the core's `exports`: the answer is the re-export file, and Vite follows it into the package from
    // there. What matters here is that the entry is still provided rather than refused -- an extraction that
    // dropped it would fail a Worker build with a refusal that names a plugin the instance still ships.
    test(`a Worker build resolves ${CORE}${entry.slice(1)} to the core's re-export`, () => {
      const spec = `${CORE}${entry.slice(1)}`;
      expect(refusalFor(spec)).toBeNull();
      expect(providedImport(spec, "/pkg", corePkg.exports as Record<string, string>)).toEqual({ file: `/pkg/src/server/plugins/${shipped}.ts` });
    });
  }
});

describe("a marketplace bundle that imports an extracted plugin by its published name", () => {
  const shipped = "realtime";
  const spec = `${CORE}/plugins/${shipped}`;
  const code = `import { ${shipped} } from ${JSON.stringify(spec)};\nexport default { manifest: { name: "uses-${shipped}", version: "1.0.0", tier: "community", voidbase: "*" }, apply(ctx) { ctx.app.get("/api/uses-${shipped}", (c) => c.text(\`\${${shipped}.manifest.name} \${${shipped}.manifest.provides.join(",")}\`)); } };\n`;

  /** a project with one installed bundle, pinned in voidbase.lock the way `voidbase plugins add` leaves it */
  async function project(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "voidbase-extracted-"));
    mkdirSync(join(root, `pb_plugins/uses-${shipped}`), { recursive: true });
    writeFileSync(join(root, `pb_plugins/uses-${shipped}/bundle.js`), code);
    writeFileSync(join(root, "voidbase.lock"), JSON.stringify({
      lockfileVersion: 1, marketplaces: [], disabled: [],
      plugins: { [`uses-${shipped}`]: { version: "1.0.0", integrity: await integrityOf(new TextEncoder().encode(code)), marketplace: "http://m", source: { repository: "x/y", commit: "0123456" }, installedOn: "2026-09-12" } },
    }));
    return root;
  }

  // The Bun half: the loader registers the specifier as a virtual module holding the module this process already
  // ran (src/platform/node/plugins.ts), so the bundle's `realtime` is the instance's own -- and since 7.5 that
  // module is a re-export of the package, which is one more hop the loader never sees.
  test("loads on Bun, through the loader's virtual module, and gets the instance's own plugin", async () => {
    const root = await project();
    const { installed } = await loadInstalled(join(root, "pb_plugins"));
    expect(installed.map((p) => p.name)).toEqual([`uses-${shipped}`]);
    const app = new Hono();
    const kernel = createKernel(app as never);
    const { realtime } = (await import(`${CORE}/plugins/${shipped}`)) as { realtime: { manifest: { name: string } } };
    await load(kernel, [realtime, ...installed.map((p) => p.plugin)], "0.9.0");
    expect(await (await app.request(`/api/uses-${shipped}`)).text()).toBe("realtime realtime@1");
    // the extracted plugin is what serves the interface the core asks for, loaded from the package
    expect(whatLoaded(kernel).plugins.map((p) => p.name)).toContain(shipped);
    expect(typeof (using(kernel, "realtime@1") as { for?: unknown } | undefined)?.for).toBe("function");
  });

  // The Workers half: the build plugin resolves the bundle's bare import itself, because the builder builds from
  // the core's checkout where a bare self-import has nothing to resolve to. It answers with the re-export file, and
  // Vite carries on from there into the package the ordinary way.
  test("resolves in the Workers build, to the file the core still publishes", async () => {
    const hook = pbHooksPlugin().resolveId as unknown as (this: { resolve: () => Promise<null> }, id: string, importer?: string) => Promise<string | null>;
    const resolved = await hook.call({ resolve: async () => null }, spec, `/proj/pb_plugins/uses-${shipped}/bundle.js`);
    expect(resolved).toContain(`src/server/plugins/${shipped}.ts`);
    expect(readFileSync(resolved!, "utf8")).toContain(`from "@voidbase-cloud/plugin-${shipped}"`);
  });
});
