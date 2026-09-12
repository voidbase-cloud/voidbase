// Hot mode's release: every push to master is a release, in the same build, with nothing in the way.
//
//   bun scripts/hot-release.ts [--dry-run]      bumps the prerelease number, writes CHANGELOG.md, commits `[skip ci]`,
//                                               tags, pushes commit and tag, creates the GitHub release; prints the version
//
// The bump is the prerelease counter (0.9.0-beta.24 -> 0.9.0-beta.25) and it is lockstep: every package in the
// workspace moves to the same version, so a tarball that names a sibling always names one that exists. The
// publishable packages have to agree on the version they are leaving -- a drift there is a release bug and is
// refused rather than papered over. release-please does the same thing on the normal path through the extra-files
// glob in release-please-config.json, whose manifest is kept in step here so a later normal run (the one that
// builds the executables) sees a consistent history. The commit carries `[CI Skip]` so the push it makes does not
// start another build. GH_TOKEN pushes and creates the release; scripts/release.sh --hot --tag v<version> then
// publishes every package to npm in the same build (scripts/ci.sh).
import { readFileSync, writeFileSync } from "node:fs";
import { CORE, dependsOn, ROOT, publishable, readWorkspace, syncLockfileFile, type Pkg } from "./publish";

export function nextPrerelease(version: string): string {
  const m = /^(\d+\.\d+\.\d+)-([A-Za-z]+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`${version} is not a prerelease like 0.9.0-beta.24; hot mode releases prereleases only`);
  return `${m[1]}-${m[2]}.${Number(m[3]) + 1}`;
}

export interface Lockstep {
  from: string;
  to: string;
  /** every workspace package, the private ones included: one version across the workspace, not just across npm */
  packages: Pkg[];
}

/** the version the repository is on -- the core's, which is what `voidbase` means -- and the one it moves to */
export function lockstep(pkgs: Pkg[]): Lockstep {
  const shipping = publishable(pkgs);
  if (shipping.length === 0) throw new Error("the workspace has no publishable package: there is nothing to release");
  const core = shipping.find((p) => p.name === CORE);
  if (!core) throw new Error(`the workspace has no ${CORE}: there is nothing to name the release after`);
  const from = core.version;
  return { from, to: nextPrerelease(from), packages: pkgs };
}

/**
 * What a release moves, which is no longer everything.
 *
 * Under one version for the whole workspace, a plugin nobody touched was republished on every push to master --
 * hot mode releases on each one -- so a package that had not changed in weeks collected a byte-identical version a
 * day on npm. What a release actually has to move is the core, whatever changed, and whatever would otherwise be
 * left naming a version that no longer exists:
 *
 *  - the core, always: the repository's version is the core's, and the release is named after it;
 *  - any package with a changed file since the last release tag;
 *  - any package that depends on one of those, transitively. `workspace:*` packs as the sibling's exact version, so
 *    a dependent left behind would keep naming the sibling's old version while the core names the new one, and an
 *    install would hold two copies of a package that provides a service -- the failure the exact pin exists to make
 *    impossible. Publishing the dependent too is what keeps the tree at one copy.
 *
 * Everything else keeps the version it has, stays on the registry as it is, and is skipped by the publish loop,
 * which already asks the registry before it publishes anything.
 */
export function releaseSet(pkgs: Pkg[], changedPaths: string[], to: string): Set<string> {
  const touched = (p: Pkg) => changedPaths.some((f) => f === p.path || f.startsWith(`${p.path}/`));
  const out = new Set<string>([CORE]);
  for (const p of pkgs) if (touched(p)) out.add(p.name);
  // A plugin declares its peer on the core as `workspace:^`, which packs as a caret on the core's version at the
  // time it was packed -- and because the core always releases, that is the plugin's own version. `^0.9.0-beta.56`
  // admits every later 0.9, so an unchanged plugin goes on being installable as the core moves. It stops admitting
  // it the moment the minor turns: `^0.9.0-beta.56` does not admit `0.10.0`. So a package whose range would no
  // longer name the core it ships beside is released too, however untouched it is.
  for (const p of pkgs) if (p.name !== CORE && !Bun.semver.satisfies(to, `^${p.version}`)) out.add(p.name);
  const names = new Set(pkgs.map((p) => p.name));
  // a dependent of anything in the set joins it, until nothing new joins: the edges are the same ones publishOrder
  // reads, so the order a release publishes in is the order these were added in
  for (let added = true; added; ) {
    added = false;
    for (const p of pkgs) {
      if (out.has(p.name)) continue;
      if (dependsOn(p, names).some((d) => out.has(d))) { out.add(p.name); added = true; }
    }
  }
  return out;
}

/** the version field, rewritten in place: the file keeps its formatting and everything else it says */
export function bumpVersion(text: string, from: string, to: string): string {
  const exact = `"version": "${from}"`;
  if (text.includes(exact)) return text.replace(exact, `"version": "${to}"`);
  const m = /"version"\s*:\s*"[^"]*"/.exec(text);
  if (!m) throw new Error(`no "version" field to bump to ${to}`);
  return `${text.slice(0, m.index)}"version": "${to}"${text.slice(m.index + m[0].length)}`;
}

/** the notes at the top of a package's changelog, or a changelog if it has none yet */
export function prependNotes(changelog: string | null, notes: string): string {
  if (changelog === null) return `# Changelog\n\n${notes}`;
  const i = changelog.indexOf("\n## ");
  return i >= 0 ? `${changelog.slice(0, i + 1)}${notes}\n${changelog.slice(i + 1)}` : `${changelog.trimEnd()}\n\n${notes}`;
}

if (import.meta.main) {
  const dry = process.argv.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY ?? "voidbase-cloud/voidbase";
  const token = process.env.GH_TOKEN ?? "";
  const sh = async (cmd: string[], quiet = false) => { const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(); const err = await new Response(p.stderr).text(); if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${err.trim() || out.trim()}`); if (!quiet && out.trim()) console.log(out.trim()); return out.trim(); };
  const { from, to, packages } = lockstep(readWorkspace(ROOT));
  const lastTag = await sh(["git", "describe", "--tags", "--abbrev=0", "--match", "v*"], true).catch(() => "");
  // what this release moves: the core, what changed since the last tag, and whatever depends on those. With no tag
  // to compare against, everything moves -- the first release of a workspace has nothing to leave behind.
  const changedPaths = lastTag ? (await sh(["git", "diff", "--name-only", `${lastTag}..HEAD`], true)).split("\n").filter(Boolean) : packages.map((p) => p.path);
  const moving = releaseSet(packages, changedPaths, to);
  const releasing = packages.filter((p) => moving.has(p.name));
  const staying = packages.filter((p) => !moving.has(p.name));
  const subjects = (await sh(["git", "log", "--format=%s", ...(lastTag ? [`${lastTag}..HEAD`] : ["-20"])], true)).split("\n").filter((l) => l && !/^chore\(master\): release/.test(l));
  const date = new Date().toISOString().slice(0, 10);
  const notes = `## [${to}](https://github.com/${repo}/compare/v${from}...v${to}) (${date})\n\n${subjects.map((s) => `* ${s}`).join("\n") || "* (no commits since the last release)"}\n`;
  console.log(`hot release: ${from} -> ${to} across ${releasing.length} of ${packages.length} workspace package(s) (${releasing.map((p) => p.path).join(", ")}), ${subjects.length} commit(s) since ${lastTag || "the start"}`);
  if (staying.length) console.log(`  unchanged, and left on the version they have: ${staying.map((p) => `${p.name}@${p.version}`).join(", ")}`);
  if (dry) { console.log(notes); process.exit(0); }
  if (!token) { console.error("GH_TOKEN is not set: the release cannot be pushed"); process.exit(1); }
  const staged: string[] = [];
  for (const p of releasing) { const file = `${p.path}/package.json`; writeFileSync(`${ROOT}/${file}`, bumpVersion(readFileSync(`${ROOT}/${file}`, "utf8"), p.version, to)); staged.push(file); }
  // bun.lock records where each workspace package is, and `bun pm pack` resolves `workspace:` specs out of it: the
  // release commit carries the new versions there too, or the next pack names the release this one replaces
  const moved = syncLockfileFile(ROOT, releasing.map((p) => ({ ...p, version: to })));
  if (moved.length) { console.log(`bun.lock: ${moved.join(", ")}`); staged.push("bun.lock"); }
  try { const m = JSON.parse(readFileSync(`${ROOT}/.release-please-manifest.json`, "utf8")) as Record<string, string>; for (const k of Object.keys(m)) if (m[k] === from) m[k] = to; writeFileSync(`${ROOT}/.release-please-manifest.json`, `${JSON.stringify(m, null, 2)}\n`); staged.push(".release-please-manifest.json"); } catch { /* no manifest */ }
  // a private package ships nothing, so it has no changelog to write
  for (const p of publishable(releasing)) {
    const file = `${p.path}/CHANGELOG.md`;
    let current: string | null = null; try { current = readFileSync(`${ROOT}/${file}`, "utf8"); } catch { current = null; }
    writeFileSync(`${ROOT}/${file}`, prependNotes(current, notes)); staged.push(file);
  }
  await sh(["git", "config", "user.name", "voidbase release"]); await sh(["git", "config", "user.email", "release@voidbase.cloud"]);
  await sh(["git", "add", ...staged]);
  // --no-verify: this commit is a version bump written by CI, not an edit anyone made, and what a build runs is
  // scripts/ci.sh's decision. Without it the repository's pre-commit hook runs the whole check and suite here, in
  // the middle of the release -- which is what hot mode says it does not do ("No typecheck, no tests", ci.sh), and
  // whose output arrives as one enormous stderr blob that the Builds log API truncates, so a failure in it cannot
  // even be read. The gate for a hot release is the push: run `bun run check && bun test` before pushing to master.
  await sh(["git", "commit", "-q", "--no-verify", "-m", `chore(master): release ${to} [CI Skip]`]);
  await sh(["git", "tag", `v${to}`]);
  const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
  await sh(["git", "push", "--quiet", remote, "HEAD:master"], true); await sh(["git", "push", "--quiet", remote, `v${to}`], true);
  const r = await fetch(`https://api.github.com/repos/${repo}/releases`, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "voidbase-release" }, body: JSON.stringify({ tag_name: `v${to}`, name: `v${to}`, body: notes, prerelease: true }) });
  if (!r.ok) { console.error(`GitHub release: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  console.log(`pushed chore(master): release ${to} [CI Skip], tag v${to}, GitHub release created`);
  console.log(to);
}
