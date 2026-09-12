// The entries resolve both ways: from inside this package, and from a package that imports voidbase by name.
//
// This is the half of 7.2 a map in package.json cannot prove on its own. A plugin file today reaches the core by
// relative import and by `#platform/*`, and neither travels: a relative path leaves the package, and `#platform/*`
// is package-private, so it resolves to nothing at all from another package. The entries exist so that one plugin
// file works in both places, which means the same name has to reach the same module either way — not a copy, or a
// plugin's `ApiError` would not be the one this instance's error handler catches, and its `logger` would write
// somewhere else.
//
// Two directions, because they resolve by different rules. Inside the repository a bare `@voidbase-cloud/voidbase/x`
// is a self-reference, matched against this package.json's own `name` and `exports`. From outside it is an ordinary
// dependency, found in node_modules and then read through the same `exports` — the path a marketplace bundle and an
// official `@voidbase-cloud/plugin-*` package both take. The scratch package below is that second path, built in a
// temporary directory with this checkout symlinked in as the dependency.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
/** every file under a directory, absolute */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
/** the module specifiers a source file imports or re-exports, which is all this needs to read out of it */
const specifiersOf = (source: string): string[] => [...source.matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm)].map((m) => m[1]!);

/** a package of its own that depends on this checkout, the way a plugin package depends on a published voidbase */
function scratchPackage(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "voidbase-plugin-pkg-"));
  mkdirSync(join(dir, "node_modules", "@voidbase-cloud"), { recursive: true });
  symlinkSync(root, join(dir, "node_modules", "@voidbase-cloud", "voidbase"), "dir");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "echo-plugin", version: "0.1.0", private: true, type: "module", dependencies: { "@voidbase-cloud/voidbase": "*" } }, null, 2));
  writeFileSync(join(dir, "plugin.ts"), source);
  scratch.push(dir);
  return join(dir, "plugin.ts");
}
const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

describe("a plugin package reaches the core by name", () => {
  test("the repository resolves every new entry against its own exports", async () => {
    for (const entry of ["sdk", "platform", "platform/email", "platform/raster", "auth-routes", "backups-api", "hardening-middleware", "realtime-client", "mail", "records-preview", "records-files", "project-sync"]) {
      const mod = (await import(`@voidbase-cloud/voidbase/${entry}`)) as Record<string, unknown>;
      expect(Object.keys(mod).length, entry).toBeGreaterThan(0);
    }
  });

  test("a package outside the repository resolves the same names to the same modules", async () => {
    const file = scratchPackage(`
import { badRequest, VERSION, loadSettings } from "@voidbase-cloud/voidbase/sdk";
import { logger, env } from "@voidbase-cloud/voidbase/platform";
import { EmailMessage } from "@voidbase-cloud/voidbase/platform/email";
import { mountBackupsApi } from "@voidbase-cloud/voidbase/backups-api";
import { realtimeFor } from "@voidbase-cloud/voidbase/realtime-client";
import { PREVIEW_FIELD } from "@voidbase-cloud/voidbase/records-preview";
import { LOCKFILE } from "@voidbase-cloud/voidbase/project-sync";
import type { Bindings, Collection, RecordContext } from "@voidbase-cloud/voidbase/types";

// what a plugin package adds to the request env: an interface merged into the module that declares Bindings
declare module "@voidbase-cloud/voidbase/types" {
  interface Bindings { ECHO_API_KEY?: string }
}
export const knob = (e: Bindings): string => e.ECHO_API_KEY ?? "";
export type Probe = { c: Collection; ctx: RecordContext };
export const surface = { badRequest, VERSION, loadSettings, logger, env, EmailMessage, mountBackupsApi, realtimeFor, PREVIEW_FIELD, LOCKFILE };
`);
    const { surface } = (await import(file)) as { surface: Record<string, unknown> };

    // the same module instance, not a second copy resolved through node_modules
    const errors = await import("../../src/server/errors");
    const version = await import("../../src/server/version");
    const preview = await import("../../src/server/records/preview");
    const projectSync = await import("../../src/server/project-sync");
    expect(surface.badRequest).toBe(errors.badRequest as unknown as typeof surface.badRequest);
    expect(surface.VERSION).toBe(version.VERSION);
    expect(surface.PREVIEW_FIELD).toBe(preview.PREVIEW_FIELD);
    expect(surface.LOCKFILE).toBe(projectSync.LOCKFILE);
    for (const n of ["loadSettings", "logger", "env", "EmailMessage", "mountBackupsApi", "realtimeFor"]) expect(surface[n], n).toBeDefined();
  });

  test("the published platform names are the package-private picks, so one plugin file works in both places", async () => {
    const [platform, log, envPick, email, raster] = await Promise.all([
      import("@voidbase-cloud/voidbase/platform"),
      import("#platform/log"),
      import("#platform/env"),
      import("#platform/email"),
      import("#platform/raster"),
    ]);
    expect(platform.logger).toBe(log.logger);
    expect(platform.env).toBe(envPick.env);
    expect((await import("@voidbase-cloud/voidbase/platform/email")).EmailMessage).toBe(email.EmailMessage);
    expect((await import("@voidbase-cloud/voidbase/platform/raster")).rasterize).toBe(raster.rasterize);
  });

  // A plugin package typed under the workerd condition resolves into the workers half of every pick it reaches, and
  // some of those import a module no resolver can find a declaration for: a virtual module the build defines, the
  // `.wasm` the rasteriser embeds, workerd's `node:async_hooks`. The declaration for each is a .d.ts in this
  // package, reached through this package's own tsconfig `include` and through nothing else, so a plugin package
  // type-checks on Bun and fails on Workers with "Cannot find module". The fix is a `/// <reference path>` in the
  // module that does the importing, which travels with it.
  //
  // Naming the files was how the first three were fixed and how the fourth (`@resvg/resvg-wasm`'s wasm, reached
  // through `./platform/raster`) was missed. So the rule is derived instead: whatever this package declares for
  // itself, every file of this package that imports it says where the declaration is. A new pick, a new ambient
  // module, or an old one imported from a second file is caught by the same line.
  test("every file that imports a module this package declares for itself carries that declaration", () => {
    const files = walk(resolve(root, "src"));
    /** the modules this package declares, and the .d.ts that declares each: "*.wasm" is a pattern, the rest exact */
    const declared = new Map<string, string[]>();
    for (const f of files.filter((f) => f.endsWith(".d.ts"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/declare module "([^"]+)"/g)) declared.set(m[1]!, [...(declared.get(m[1]!) ?? []), f]);
    }
    expect([...declared.keys()].sort()).toEqual(["*.wasm", "node:async_hooks", "virtual:voidbase-hooks", "virtual:voidbase-migrations", "virtual:voidbase-plugins"]);

    const missing: string[] = [];
    const carried: string[] = [];
    for (const f of files.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))) {
      const source = readFileSync(f, "utf8");
      const refs = [...source.matchAll(/\/\/\/ <reference path="([^"]+)"\s*\/>/g)].map((m) => resolve(dirname(f), m[1]!));
      for (const spec of specifiersOf(source)) {
        const owners = [...declared].filter(([pattern]) => (pattern.startsWith("*") ? spec.endsWith(pattern.slice(1)) : pattern === spec)).flatMap(([, owner]) => owner);
        if (!owners.length) continue;
        (owners.some((o) => refs.includes(o)) ? carried : missing).push(`${relative(root, f)} imports ${spec}`);
      }
    }
    expect(missing).toEqual([]);
    // and the rule has something to bite on: the three virtual modules, the wasm and node:async_hooks, all present
    expect(carried.sort()).toEqual([
      "src/platform/workers/hooks.ts imports virtual:voidbase-hooks",
      "src/platform/workers/migrations.ts imports virtual:voidbase-migrations",
      "src/platform/workers/plugins.ts imports virtual:voidbase-plugins",
      "src/platform/workers/raster.ts imports @resvg/resvg-wasm/index_bg.wasm",
      "src/server/hooks/runtime.ts imports node:async_hooks",
    ]);
  });

  test("both halves of a platform entry exist, so the workerd condition has somewhere to land", async () => {
    const workers = await import("../../src/platform/workers/index");
    // the workerd half is the same shape as the one Bun takes; it is void/env and void/log behind it
    expect(Object.keys(workers).sort()).toEqual(["defaultLogMinLevel", "env", "logger"]);
  });
});
