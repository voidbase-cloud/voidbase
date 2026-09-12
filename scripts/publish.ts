// What a release puts on the registry (docs/releasing.md): pack the workspace, prove the tarballs, publish them in
// dependency order. The unit is the workspace, not the package, so the flow reads the same with one package in it as
// with ten.
//
//   bun scripts/publish.ts [--out dist/packs] [--version X.Y.Z] [--registry URL] [--tag latest]
//                          [--dry-run] [--provenance] [--no-smoke] [--no-github-packages]
//   bun scripts/publish.ts --pending [--registry URL]      the publishable packages that registry does not have yet
//
// `--out` is a directory of the release's own below the workspace root: the tarballs in it are deleted at the
// start of a run, and a path that is not below the root is refused rather than emptied (packDir).
//
// Four things the single-package flow did not have to say out loud:
//
//   pack     `bun pm pack`, never `npm pack`. A workspace dependency is written `workspace:*`, and npm copies that
//            string into the published manifest verbatim -- measured on npm 11.19.0 -- where nobody can install it.
//            Bun 1.3.14 resolves it while packing: `workspace:*` becomes the sibling's exact version, `workspace:^`
//            and `workspace:~` become ranges on it, across dependencies, devDependencies, peerDependencies and
//            optionalDependencies alike.
//   prove    every packed manifest is read back out of its own tarball and refused on three counts. If it still
//            carries `workspace:` anywhere -- not only in the four dependency maps: npm publishes the manifest
//            essentially verbatim, so `overrides` and `resolutions` are read too, and they nest. If what the packer
//            resolved a sibling to is not what that sibling actually is: bun resolves the protocol out of bun.lock
//            rather than out of the sibling's package.json, and `bun install` does not rewrite a workspace entry's
//            version when only that version moved, so a release that bumps the manifests and then packs names the
//            *previous* release and looks fine doing it. The lockfile's workspace versions are therefore written in
//            step before packing, and the gate is what catches it if that ever stops working. And if it depends on
//            a workspace sibling that is never published: that name is not on the registry, and if it happens to
//            exist there under someone else's account the install quietly takes theirs. All three are hard
//            failures: half a workspace on the registry, or a package naming a sibling that is not the one it was
//            built against, is worse than no release at all.
//   smoke    all of the tarballs are installed together into a scratch project -- `overrides` points each name at
//            its own tarball, because a sibling's resolved version is not on the registry yet and the install would
//            otherwise go looking for it -- and each package is then used by name: `import(name)` through its
//            exports, and every bin it declares run with `--help`.
//   publish  a loop in dependency order, each package skipped when the registry already has that name@version. A
//            retried or half-finished release finishes instead of dying on npm's 403, and a package that depends on
//            a sibling is never published before the sibling it needs.
//
// Versions are lockstep: every publishable package carries the same one (scripts/hot-release.ts bumps them together,
// release-please's extra-files glob does it on the normal path). --version states the version the release is for and
// is checked against what was packed.
//
// Tokens (NPM_TOKEN, GH_PACKAGES_TOKEN) are read from the environment and written to a temporary npmrc that is
// deleted again; they are never printed and never leave the registry they belong to.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const GITHUB_PACKAGES = "https://npm.pkg.github.com";
/** the four dependency maps npm publishes; `workspace:` is unusable in every one of them */
export const DEP_MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
export type DepMap = (typeof DEP_MAPS)[number];
/**
 * The maps that decide who has to be on the registry first -- and it is only these two.
 *
 * A devDependency edge is not one: a cycle through it is legal and says nothing about publishing. Neither is a
 * peerDependency edge, and that one is worth saying out loud. npm does not resolve peers when it publishes; a peer
 * range is a statement about the project that installs the package, not a package the registry has to be holding
 * first. So a peer edge carries no ordering information -- and reading it as one carries the wrong information.
 * Every `@voidbase-cloud/plugin-*` package peer-depends on `@voidbase-cloud/voidbase`, and the shape this
 * repository is about to take is the core depending on an extracted plugin through `dependencies` while that
 * plugin peer-depends back on the core. As an ordering edge that is a cycle, and the first real plugin package
 * would stop every release (`test/unit/publish.test.ts`, "the shape the first extracted plugin package has").
 */
const ORDER_MAPS = ["dependencies", "optionalDependencies"] as const;
/** the maps whoever installs a published package resolves: a name in one of them has to be on the registry */
const INSTALLED_MAPS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  bin?: string | Record<string, string>;
  main?: string;
  exports?: Record<string, unknown> | string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** npm's override map and yarn's: specs like a dependency map, but nested arbitrarily deep */
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, unknown>;
}

export interface Pkg {
  /** repository-relative, e.g. `packages/voidbase` */
  path: string;
  dir: string;
  name: string;
  version: string;
  private: boolean;
  bins: string[];
  manifest: Manifest;
}

export interface Packed {
  pkg: Pkg;
  tarball: string;
  manifest: Manifest;
}

export type Run = (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runCommand: Run = async (cmd, opts = {}) => {
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
};

export function readManifest(file: string): Manifest {
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

/** the names a package installs into node_modules/.bin: `"bin": "./cli.ts"` means the package's own unscoped name */
export function binNames(m: Manifest): string[] {
  if (!m.bin) return [];
  return typeof m.bin === "string" ? [m.name.replace(/^@[^/]+\//, "")] : Object.keys(m.bin);
}

/** every package the root manifest's `workspaces` globs reach, sorted by path so two runs agree */
export function readWorkspace(root: string = ROOT): Pkg[] {
  const patterns = readManifest(join(root, "package.json")).workspaces ?? [];
  const files = new Set<string>();
  for (const pattern of patterns) for (const f of new Bun.Glob(`${pattern.replace(/\/+$/, "")}/package.json`).scanSync({ cwd: root })) files.add(f.replaceAll("\\", "/"));
  return [...files].sort().map((f) => {
    const m = readManifest(join(root, f));
    return { path: dirname(f), dir: dirname(join(root, f)), name: m.name, version: m.version, private: m.private === true, bins: binNames(m), manifest: m };
  });
}

/** the siblings a package needs on the registry before it can be installed */
export function dependsOn(pkg: Pkg, siblings: Set<string>): string[] {
  const out = new Set<string>();
  for (const map of ORDER_MAPS) for (const name of Object.keys(pkg.manifest[map] ?? {})) if (name !== pkg.name && siblings.has(name)) out.add(name);
  return [...out].sort();
}

/** dependency order: a package comes after every sibling it depends on. A real cycle is a failure, not a guess. */
export function publishOrder(pkgs: Pkg[]): Pkg[] {
  const siblings = new Set(pkgs.map((p) => p.name));
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const state = new Map<string, "visiting" | "done">();
  const out: Pkg[] = [];
  const visit = (p: Pkg, trail: string[]): void => {
    const seen = state.get(p.name);
    if (seen === "done") return;
    if (seen === "visiting") throw new Error(`the workspace packages depend on each other in a cycle: ${[...trail, p.name].join(" -> ")}`);
    state.set(p.name, "visiting");
    for (const name of dependsOn(p, siblings)) visit(byName.get(name)!, [...trail, p.name]);
    state.set(p.name, "done");
    out.push(p);
  };
  for (const p of [...pkgs].sort((a, b) => a.path.localeCompare(b.path))) visit(p, []);
  return out;
}

/**
 * Packages this repository never publishes, whatever their manifest says. `packages/release-fixture` exists only
 * to make the release flow N > 1 and ships nothing; `"private": true` is what keeps it off the registry, and that
 * is one edit away from being dropped by someone who reads the flag as boilerplate. What npm does with it,
 * measured on npm 11.19.0 against a private package and a stub registry: `npm publish` refuses with EPRIVATE from
 * a directory *and* from a tarball, and nothing reaches the registry -- but `npm publish --dry-run` does not check
 * at all, and prints `+ name@version` for a package the real publish would refuse. The rehearsal is the one place
 * npm is silent about it, and a rehearsal is where this would be noticed. So the name is refused here too:
 * `publishable()` drops it, and `publishWorkspace` asserts it again once the tarballs exist.
 */
export const NEVER_PUBLISH = ["@voidbase-cloud/release-fixture"];

/** what a release is allowed to put on the registry: not private, and not named above */
export function publishable(pkgs: Pkg[]): Pkg[] {
  return pkgs.filter((p) => !p.private && !NEVER_PUBLISH.includes(p.name));
}

/**
 * Where the tarballs go -- and the one argument that has to be checked before anything is deleted. The pack
 * directory is emptied at the start of a release and `--out` is whatever the operator typed: `.` resolves to the
 * workspace root, and so do `""`, `..` and `/`. Emptying that is the repository, `.git` and all -- measured on a
 * throwaway copy of this tree, which went from 19 entries to none. So the path is refused unless it is strictly
 * below the root -- and the default is taken with `||` rather than `??`, because `--out ""` resolves to the root
 * as surely as `--out .` does and `??` would hand it straight through.
 */
/** the path with every symlink followed, resolving the nearest ancestor that exists and keeping the rest */
const real = (path: string): string => {
  let dir = path; const tail: string[] = [];
  while (!existsSync(dir)) { const up = dirname(dir); if (up === dir) return path; tail.unshift(basename(dir)); dir = up; }
  return resolve(realpathSync.native(dir), ...tail);
};

export function packDir(root: string, out?: string): string {
  // real paths on both sides: `resolve` is lexical, so a symlink inside the root pointing out of it reads as below it
  const dir = real(resolve(root, out || "dist/packs"));
  const rel = relative(real(root), dir);
  // "" is the root itself, a leading ".." is above it, and an absolute answer means another volume entirely
  if (rel === "" || rel.split(/[\\/]/)[0] === ".." || isAbsolute(rel)) {
    throw new Error(`--out ${JSON.stringify(out)} is ${dir}, which is not a directory below ${root}: the pack directory is emptied before packing, so it has to be one of its own.`);
  }
  return dir;
}

/** emptying the pack directory means the tarball files in it: never the directory, and never a directory inside it */
export function clearPacks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isFile() && e.name.endsWith(".tgz")) { rmSync(join(dir, e.name), { force: true }); removed.push(e.name); }
  return removed;
}

/**
 * Everywhere in a published manifest a `workspace:` spec can hide. npm publishes the manifest essentially
 * verbatim, so it is not only the four dependency maps: `overrides` (npm) and `resolutions` (yarn, and bun reads
 * both) hold specs too, and both nest -- `{"overrides": {"foo": {"@x/a": "workspace:*"}}}` is a spec two levels
 * down, and `smokeProject` in this very file writes an overrides map, which is the shape a package here would
 * copy. So the scan recurses. `bundleDependencies` is deliberately not read: it holds names, not specs, and cannot
 * carry the protocol.
 */
export const SPEC_MAPS = [...DEP_MAPS, "overrides", "resolutions"] as const;
export type SpecMap = (typeof SPEC_MAPS)[number];

export interface WorkspaceSpec {
  /** where it was found: a dependency map, or the path into a nested one (`overrides.foo`) */
  map: string;
  dependency: string;
  spec: string;
}

function scanSpecs(value: unknown, trail: string[], out: WorkspaceSpec[]): void {
  if (typeof value === "string") {
    if (value.startsWith("workspace:")) out.push({ map: trail.slice(0, -1).join("."), dependency: trail.at(-1)!, spec: value });
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) scanSpecs(nested, [...trail, key], out);
}

export function workspaceSpecs(m: Manifest): WorkspaceSpec[] {
  const out: WorkspaceSpec[] = [];
  for (const map of SPEC_MAPS) scanSpecs(m[map], [map], out);
  return out;
}

/** the version a packed range was built on: `^1.2.3` and `~1.2.3` both come from the sibling being at 1.2.3 */
export function specBase(spec: string): string {
  return spec.replace(/^[\^~]/, "");
}

/**
 * The second gate, and the one that catches a mistake the first one cannot see. `bun pm pack` resolves
 * `workspace:*` out of bun.lock, not out of the sibling's package.json, and `bun install` does not rewrite a
 * workspace entry's version when only that version moved -- measured on bun 1.3.14: with the manifests bumped and
 * the lockfile left alone, `--force` and `--lockfile-only` both leave the old number and the dependent packs
 * naming the *previous* release. Nothing about that tarball looks wrong. So what the packer resolved is checked
 * against what the sibling actually is.
 */
export function assertResolvedSiblings(packed: Packed, versions: Map<string, string>, where: string): void {
  const wrong: string[] = [];
  for (const map of DEP_MAPS) {
    for (const [dependency, spec] of Object.entries(packed.pkg.manifest[map] ?? {})) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      const actual = versions.get(dependency);
      const resolved = (packed.manifest[map] ?? {})[dependency];
      if (!actual || resolved === undefined) continue;
      if (specBase(resolved) !== actual) wrong.push(`${map}.${dependency} = "${resolved}" but ${dependency} is ${actual}`);
    }
  }
  if (wrong.length === 0) return;
  throw new Error(`${where}: ${packed.pkg.name}@${packed.pkg.version} resolved a sibling to the wrong version: ${wrong.join(", ")}. bun resolves \`workspace:\` out of bun.lock, so the lockfile's workspace versions have to move with the manifests.`);
}

/** the gate: a manifest that still names a sibling by protocol is unusable to everyone who installs it */
export function assertNoWorkspaceSpecs(m: Manifest, where: string): void {
  const found = workspaceSpecs(m);
  if (found.length === 0) return;
  const list = found.map((f) => `${f.map}.${f.dependency} = "${f.spec}"`).join(", ");
  // what to do about it depends on where it is: bun resolves the protocol in the dependency maps as it packs, and
  // nowhere else, so a spec in `overrides` or `resolutions` is one no packer will ever rewrite
  const how = found.some((f) => !(DEP_MAPS as readonly string[]).includes(f.map))
    ? "Outside the dependency maps no packer resolves `workspace:` at all: write the version there instead."
    : "Pack with `bun pm pack`: npm pack copies the protocol into the manifest verbatim.";
  throw new Error(`${where}: ${m.name}@${m.version} carries ${found.length === 1 ? "an unresolved workspace dependency" : `${found.length} unresolved workspace dependencies`}, which nobody can install: ${list}. ${how}`);
}

/**
 * The third gate, and the one the other two cannot see. A published package that names a sibling this release
 * never publishes is broken on arrival: the registry does not have that name and nothing here will put it there.
 * The smoke install catches it only as a 404 that says nothing about why, `--no-smoke` skips it altogether, and if
 * the name does exist on npm -- someone else's package under a scope we do not own -- the install succeeds and
 * ships a dependency on a stranger's code. So it is named here, before anything is published. devDependencies are
 * not read: nobody installing a tarball resolves them.
 */
export function assertNoPrivateSiblings(m: Manifest, unpublished: Set<string>, where: string): void {
  const found: string[] = [];
  for (const map of INSTALLED_MAPS) for (const dependency of Object.keys(m[map] ?? {})) if (unpublished.has(dependency)) found.push(`${map}.${dependency}`);
  if (found.length === 0) return;
  throw new Error(`${where}: ${m.name}@${m.version} depends on ${found.length === 1 ? "a workspace package this release never publishes" : "workspace packages this release never publishes"}: ${found.join(", ")}. Publish the sibling (drop its \`"private": true\`) or stop depending on it: the registry does not have that name, and if someone else does, installing this package takes theirs.`);
}

/** every publishable package on one version, and on the one the release says it is for */
export function assertLockstep(pkgs: Pkg[], version?: string): string {
  const versions = [...new Set(pkgs.map((p) => p.version))];
  if (versions.length > 1) throw new Error(`the publishable packages are not in lockstep: ${pkgs.map((p) => `${p.name}@${p.version}`).join(", ")}`);
  const found = versions[0] ?? version ?? "";
  if (version && found !== version) throw new Error(`the release is for ${version} but the workspace packs ${pkgs.map((p) => `${p.name}@${p.version}`).join(", ") || "nothing"}`);
  return found;
}

/**
 * The lockfile's own record of where each workspace package is, written in step with the manifests. bun writes
 * these entries itself and rewrites them whenever it rewrites the lockfile, so this only ever does what bun would
 * have done had the version change been reason enough for it to bother. It is the other half of
 * `assertResolvedSiblings`: this keeps the release from packing the wrong number, that one keeps it from shipping
 * the wrong number if this ever stops working.
 */
export function syncLockfile(text: string, pkgs: Pkg[]): { text: string; changed: string[] } {
  const changed: string[] = [];
  let out = text;
  for (const p of pkgs) {
    const re = new RegExp(`("${p.path.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*\\{\\s*"name":\\s*"[^"]*",\\s*"version":\\s*)"([^"]*)"`);
    const m = re.exec(out);
    if (!m || m[2] === p.version) continue;
    out = `${out.slice(0, m.index)}${m[1]}"${p.version}"${out.slice(m.index + m[0].length)}`;
    changed.push(`${p.path} ${m[2]} -> ${p.version}`);
  }
  return { text: out, changed };
}

export function syncLockfileFile(root: string, pkgs: Pkg[], write = true): string[] {
  const file = join(root, "bun.lock");
  if (!existsSync(file)) return [];
  const { text, changed } = syncLockfile(readFileSync(file, "utf8"), pkgs);
  if (changed.length && write) writeFileSync(file, text);
  return changed;
}

/**
 * What the lockfile would have to be told for it to agree with the manifests -- empty when it already does.
 * Nothing else notices when it does not: `bun install --frozen-lockfile` checks clean and exits 0 with the
 * manifests at 1.0.1 and the lockfile at 1.0.0 (measured, bun 1.3.14), and a release repairs it at pack time
 * rather than complaining. So the repository can sit indefinitely in exactly the state `assertResolvedSiblings`
 * exists to catch, which is where release-please leaves it: it bumps the manifests in the release pull request and
 * cannot write a JSONC lockfile. `test/unit/publish.test.ts` fails on a non-empty answer, which is the whole point
 * of it -- the fix is one `bun install` and a commit of bun.lock.
 */
export function lockfileDrift(root: string = ROOT): string[] {
  return syncLockfileFile(root, readWorkspace(root), false);
}

export async function pack(pkg: Pkg, outDir: string, run: Run = runCommand): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const r = await run(["bun", "pm", "pack", "--quiet", "--destination", outDir], { cwd: pkg.dir });
  if (r.code !== 0) throw new Error(`bun pm pack failed for ${pkg.name}: ${(r.stderr || r.stdout).trim()}`);
  const printed = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const tarball = printed.startsWith("/") ? printed : join(outDir, printed);
  if (!printed || !existsSync(tarball)) throw new Error(`bun pm pack printed ${printed || "nothing"} for ${pkg.name} but there is no tarball at ${tarball}`);
  return tarball;
}

/** the manifest as the registry will see it: read back out of the tarball, not off disk */
export async function packedManifest(tarball: string, run: Run = runCommand): Promise<Manifest> {
  const r = await run(["tar", "-xzOf", tarball, "package/package.json"]);
  if (r.code !== 0) throw new Error(`cannot read package/package.json out of ${tarball}: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout) as Manifest;
}

/** pack every publishable package and refuse anything the registry could not install */
export async function packWorkspace(pkgs: Pkg[], outDir: string, version?: string, run: Run = runCommand, siblings: Map<string, string> = new Map(pkgs.map((p) => [p.name, p.version])), unpublished: Set<string> = new Set()): Promise<Packed[]> {
  assertLockstep(pkgs, version);
  const packed: Packed[] = [];
  for (const pkg of pkgs) {
    const tarball = await pack(pkg, outDir, run);
    const manifest = await packedManifest(tarball, run);
    const where = `${pkg.path} (${tarball.split("/").pop()})`;
    assertNoWorkspaceSpecs(manifest, where);
    assertNoPrivateSiblings(manifest, unpublished, where);
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error(`${tarball} holds ${manifest.name}@${manifest.version}, not ${pkg.name}@${pkg.version}`);
    const entry = { pkg, tarball, manifest };
    assertResolvedSiblings(entry, siblings, where);
    packed.push(entry);
  }
  return packed;
}

/** the smoke project: every tarball installed together, each name pointed at its own tarball by `overrides` */
export function smokeProject(packed: Packed[]): { name: string; version: string; private: true; type: "module"; dependencies: Record<string, string>; overrides: Record<string, string> } {
  const map: Record<string, string> = {};
  for (const p of packed) map[p.pkg.name] = `file:${p.tarball}`;
  return { name: "voidbase-release-smoke", version: "0.0.0", private: true, type: "module", dependencies: { ...map }, overrides: { ...map } };
}

/** install the tarballs and use each package by name: the import goes through its exports, the bins actually run */
export async function smokeInstall(packed: Packed[], log: (line: string) => void, run: Run = runCommand): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "voidbase-smoke-"));
  try {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(smokeProject(packed), null, 2)}\n`);
    const install = await run(["bun", "install", "--no-summary"], { cwd: dir });
    if (install.code !== 0) throw new Error(`the smoke install failed: ${(install.stderr || install.stdout).trim()}`);
    const expected = packed.map((p) => ({ name: p.pkg.name, version: p.pkg.version, entry: !!(p.manifest.exports ?? p.manifest.main) }));
    writeFileSync(join(dir, "smoke.ts"), SMOKE);
    const used = await run(["bun", "smoke.ts", JSON.stringify(expected)], { cwd: dir });
    if (used.code !== 0) throw new Error(`the smoke install resolved but the packages do not work: ${(used.stderr || used.stdout).trim()}`);
    for (const line of used.stdout.split("\n").filter(Boolean)) log(`  ${line}`);
    for (const p of packed) {
      for (const bin of p.pkg.bins) {
        const r = await run([join(dir, "node_modules", ".bin", bin), "--help"], { cwd: dir });
        if (r.code !== 0) throw new Error(`${p.pkg.name}: the installed \`${bin} --help\` exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
        if (!r.stdout.trim()) throw new Error(`${p.pkg.name}: the installed \`${bin} --help\` printed nothing`);
        log(`  ${p.pkg.name}: ${bin} --help -> ${r.stdout.trim().split("\n")[0]!.slice(0, 60)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SMOKE = `// written by scripts/publish.ts: proves the installed packages work by name, not that the files are there
import { readFileSync } from "node:fs";
for (const want of JSON.parse(process.argv[2]) as { name: string; version: string; entry: boolean }[]) {
  const got = JSON.parse(readFileSync(\`node_modules/\${want.name}/package.json\`, "utf8")) as { version: string };
  if (got.version !== want.version) throw new Error(\`\${want.name} installed as \${got.version}, not \${want.version}\`);
  if (!want.entry) { console.log(\`\${want.name}@\${got.version}: installed (no entry point to import)\`); continue; }
  const mod = await import(want.name) as Record<string, unknown>;
  console.log(\`\${want.name}@\${got.version}: import("\${want.name}") -> \${Object.keys(mod).length} export(s)\`);
}
`;

/** the npmrc a publish runs under: one registry, one token, deleted again by the caller */
export function npmrcLines(registry: string, token: string, scope?: string): string {
  const u = new URL(registry);
  const key = `//${u.host}${u.pathname.replace(/\/+$/, "")}/`;
  return `${scope ? `${scope}:registry=${registry}\n` : ""}${key}:_authToken=${token}\n`;
}

function withNpmrc<T>(registry: string, token: string, scope: string | undefined, body: (npmrc: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "voidbase-npmrc-"));
  const npmrc = join(dir, ".npmrc");
  writeFileSync(npmrc, npmrcLines(registry, token, scope), { mode: 0o600 });
  return body(npmrc).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export type IsPublished = (name: string, version: string, registry: string, npmrc?: string) => Promise<boolean>;

export const npmView: IsPublished = async (name, version, registry, npmrc) => {
  const r = await runCommand(["npm", "view", `${name}@${version}`, "version", "--registry", registry], { env: npmrc ? { NPM_CONFIG_USERCONFIG: npmrc } : {} });
  return r.code === 0 && r.stdout.trim() !== "";
};

export interface PublishOptions {
  root?: string;
  out?: string;
  version?: string;
  registry?: string;
  tag?: string;
  dryRun?: boolean;
  provenance?: boolean;
  smoke?: boolean;
  githubPackages?: boolean;
  /** write the lockfile's workspace versions before packing; only a test turns this off, to watch the gate fire */
  syncLockfile?: boolean;
  log?: (line: string) => void;
  run?: Run;
  isPublished?: IsPublished;
}

export interface PublishResult {
  name: string;
  version: string;
  tarball: string;
  action: "published" | "skipped" | "dry-run";
}

/** the publishable packages the registry does not have at this version yet, in the order they would be published */
export async function pending(opts: PublishOptions = {}): Promise<Pkg[]> {
  const registry = opts.registry ?? NPM_REGISTRY;
  const isPublished = opts.isPublished ?? npmView;
  const pkgs = publishable(publishOrder(readWorkspace(opts.root ?? ROOT)));
  const out: Pkg[] = [];
  for (const p of pkgs) if (!(await isPublished(p.name, p.version, registry))) out.push(p);
  return out;
}

/**
 * Pack, prove, smoke and publish the whole workspace. Returns one result per publishable package, in the order
 * they were visited.
 */
export async function publishWorkspace(opts: PublishOptions = {}): Promise<PublishResult[]> {
  const root = opts.root ?? ROOT;
  const out = packDir(root, opts.out);
  const registry = opts.registry ?? NPM_REGISTRY;
  const tag = opts.tag ?? "latest";
  const log = opts.log ?? ((l: string) => console.log(l));
  const run = opts.run ?? runCommand;
  const isPublished = opts.isPublished ?? npmView;

  const all = readWorkspace(root);
  const pkgs = publishable(publishOrder(all));
  if (pkgs.length === 0) throw new Error(`${root} has no publishable package: every workspace package is private`);
  const version = assertLockstep(pkgs, opts.version);
  log(`publish ${version} to ${registry}: ${pkgs.length} package(s) in dependency order: ${pkgs.map((p) => p.name).join(", ")}${opts.dryRun ? " (dry run)" : ""}`);

  // the lockfile first: bun packs the sibling version it records, and a bump leaves it behind (syncLockfile). A
  // dry run is a rehearsal and writes nothing, so it says what it would have written instead and packs against the
  // lockfile as committed -- where the second gate refuses a tarball that names the release before this one, which
  // is the honest answer for a tree in that state rather than a repaired working copy nobody asked for.
  if (opts.syncLockfile ?? true) {
    const behind = syncLockfileFile(root, all, !opts.dryRun);
    for (const line of behind) log(`  bun.lock: ${line}${opts.dryRun ? " (dry run: not written)" : ""}`);
    if (behind.length && opts.dryRun) log("  bun.lock is behind the manifests and a dry run does not write it: `bun install` and commit it");
  }
  clearPacks(out);
  const shipping = new Set(pkgs.map((p) => p.name));
  const packed = await packWorkspace(pkgs, out, version, run, new Map(all.map((p) => [p.name, p.version])), new Set(all.map((p) => p.name).filter((n) => !shipping.has(n))));
  for (const p of packed) log(`  packed ${p.pkg.path} -> ${p.tarball.split("/").pop()}${workspaceLine(p)}`);
  // an assertion, not a third gate: `publishable()` filtered this list on these same two predicates, so this can
  // only fire if that filter is ever changed to let one through. npm's own EPRIVATE is silent under --dry-run,
  // which is why the refusal lives in `publishable()` rather than being left to the registry.
  for (const p of packed) if (p.pkg.private || NEVER_PUBLISH.includes(p.pkg.name)) throw new Error(`${p.pkg.path} (${p.pkg.name}@${p.pkg.version}) is never published and was about to be: ${p.pkg.private ? 'it is marked `"private": true`' : "it is named in NEVER_PUBLISH"}.`);

  if (opts.smoke ?? true) {
    log(`smoke install: ${packed.length} tarball(s) into a scratch project`);
    await smokeInstall(packed, log, run);
  }

  const token = process.env.NPM_TOKEN ?? "";
  if (!token) throw new Error("NPM_TOKEN is not set: nothing can be published");
  const results = await withNpmrc(registry, token, undefined, async (npmrc) => {
    const acc: PublishResult[] = [];
    for (const p of packed) {
      if (await isPublished(p.pkg.name, p.pkg.version, registry, npmrc)) {
        log(`  ${p.pkg.name}@${p.pkg.version} is already on the registry: skipped`);
        acc.push({ name: p.pkg.name, version: p.pkg.version, tarball: p.tarball, action: "skipped" });
        continue;
      }
      const cmd = ["npm", "publish", p.tarball, "--access", "public", "--registry", registry, "--tag", tag];
      if (opts.provenance) cmd.push("--provenance");
      if (opts.dryRun) cmd.push("--dry-run");
      log(`  ${p.pkg.name}@${p.pkg.version}: npm publish --tag ${tag}${opts.provenance ? " --provenance" : ""}${opts.dryRun ? " --dry-run" : ""}`);
      const r = await run(cmd, { env: { NPM_CONFIG_USERCONFIG: npmrc } });
      if (r.code !== 0) throw new Error(`npm publish ${p.pkg.name}@${p.pkg.version} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
      // npm refuses to publish a prerelease unless --tag is explicit, because the default would quietly move
      // `latest` onto it. Here that is the intent: while voidbase is in public beta the beta is what we ask people
      // to run. The channel tag is added afterwards, so `@beta` works for anyone who would rather pin to it.
      if (!opts.dryRun && p.pkg.version.includes("-")) {
        const t = await run(["npm", "dist-tag", "add", `${p.pkg.name}@${p.pkg.version}`, "beta", "--registry", registry], { env: { NPM_CONFIG_USERCONFIG: npmrc } });
        if (t.code !== 0) log(`  dist-tag beta failed for ${p.pkg.name} (${tag} is the tag of record; continuing)`);
      }
      acc.push({ name: p.pkg.name, version: p.pkg.version, tarball: p.tarball, action: opts.dryRun ? "dry-run" : "published" });
    }
    return acc;
  });

  // GitHub Packages is a mirror, never the registry of record: a failure there is reported and the release goes on
  if (opts.githubPackages ?? true) {
    const ghToken = process.env.GH_PACKAGES_TOKEN ?? "";
    if (!ghToken) log("GitHub Packages: skipped (no GH_PACKAGES_TOKEN)");
    else
      await withNpmrc(GITHUB_PACKAGES, ghToken, "@voidbase-cloud", async (npmrc) => {
        for (const p of packed) {
          if (await isPublished(p.pkg.name, p.pkg.version, GITHUB_PACKAGES, npmrc)) { log(`  GitHub Packages: ${p.pkg.name}@${p.pkg.version} is already there`); continue; }
          const cmd = ["npm", "publish", p.tarball, "--registry", GITHUB_PACKAGES, "--tag", tag];
          if (opts.dryRun) cmd.push("--dry-run");
          const r = await run(cmd, { env: { NPM_CONFIG_USERCONFIG: npmrc } });
          log(r.code === 0 ? `  GitHub Packages: ${p.pkg.name}@${p.pkg.version}` : `  GitHub Packages: ${p.pkg.name} failed (npm is the registry of record; continuing)`);
        }
      });
  }
  return results;
}

function workspaceLine(p: Packed): string {
  const resolved: string[] = [];
  for (const map of DEP_MAPS) for (const [dep, spec] of Object.entries(p.pkg.manifest[map] ?? {})) if (typeof spec === "string" && spec.startsWith("workspace:")) resolved.push(`${dep} ${spec} -> ${String((p.manifest[map] ?? {})[dep])}`);
  return resolved.length ? ` (${resolved.join(", ")})` : "";
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(`--${name}`);
  const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const registry = opt("registry") ?? NPM_REGISTRY;
  try {
    if (flag("pending")) {
      const missing = await pending({ registry, root: opt("root") });
      for (const p of missing) console.log(p.name);
      process.exit(0);
    }
    const results = await publishWorkspace({
      root: opt("root"),
      out: opt("out"),
      version: opt("version"),
      registry,
      tag: opt("tag"),
      dryRun: flag("dry-run"),
      provenance: flag("provenance"),
      smoke: !flag("no-smoke"),
      githubPackages: !flag("no-github-packages"),
    });
    console.log(`publish: ${results.map((r) => `${r.name} ${r.action}`).join(", ")}`);
  } catch (e) {
    console.error(`publish failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
