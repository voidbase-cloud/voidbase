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
import { ROOT, publishable, readWorkspace, syncLockfileFile, type Pkg } from "./publish";

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

/** the one version the workspace is on, and the one it moves to */
export function lockstep(pkgs: Pkg[]): Lockstep {
  const shipping = publishable(pkgs);
  if (shipping.length === 0) throw new Error("the workspace has no publishable package: there is nothing to release");
  const versions = [...new Set(shipping.map((p) => p.version))];
  if (versions.length > 1) throw new Error(`the publishable packages are not in lockstep: ${shipping.map((p) => `${p.name}@${p.version}`).join(", ")}`);
  const from = versions[0]!;
  return { from, to: nextPrerelease(from), packages: pkgs };
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
  const subjects = (await sh(["git", "log", "--format=%s", ...(lastTag ? [`${lastTag}..HEAD`] : ["-20"])], true)).split("\n").filter((l) => l && !/^chore\(master\): release/.test(l));
  const date = new Date().toISOString().slice(0, 10);
  const notes = `## [${to}](https://github.com/${repo}/compare/v${from}...v${to}) (${date})\n\n${subjects.map((s) => `* ${s}`).join("\n") || "* (no commits since the last release)"}\n`;
  console.log(`hot release: ${from} -> ${to} across ${packages.length} workspace package(s) (${packages.map((p) => p.path).join(", ")}), ${subjects.length} commit(s) since ${lastTag || "the start"}${dry ? " [dry run]" : ""}`);
  if (dry) { console.log(notes); process.exit(0); }
  if (!token) { console.error("GH_TOKEN is not set: the release cannot be pushed"); process.exit(1); }
  const staged: string[] = [];
  for (const p of packages) { const file = `${p.path}/package.json`; writeFileSync(`${ROOT}/${file}`, bumpVersion(readFileSync(`${ROOT}/${file}`, "utf8"), p.version, to)); staged.push(file); }
  // bun.lock records where each workspace package is, and `bun pm pack` resolves `workspace:` specs out of it: the
  // release commit carries the new versions there too, or the next pack names the release this one replaces
  const moved = syncLockfileFile(ROOT, packages.map((p) => ({ ...p, version: to })));
  if (moved.length) { console.log(`bun.lock: ${moved.join(", ")}`); staged.push("bun.lock"); }
  try { const m = JSON.parse(readFileSync(`${ROOT}/.release-please-manifest.json`, "utf8")) as Record<string, string>; for (const k of Object.keys(m)) if (m[k] === from) m[k] = to; writeFileSync(`${ROOT}/.release-please-manifest.json`, `${JSON.stringify(m, null, 2)}\n`); staged.push(".release-please-manifest.json"); } catch { /* no manifest */ }
  // a private package ships nothing, so it has no changelog to write
  for (const p of publishable(packages)) {
    const file = `${p.path}/CHANGELOG.md`;
    let current: string | null = null; try { current = readFileSync(`${ROOT}/${file}`, "utf8"); } catch { current = null; }
    writeFileSync(`${ROOT}/${file}`, prependNotes(current, notes)); staged.push(file);
  }
  await sh(["git", "config", "user.name", "voidbase release"]); await sh(["git", "config", "user.email", "release@voidbase.cloud"]);
  await sh(["git", "add", ...staged]);
  await sh(["git", "commit", "-q", "-m", `chore(master): release ${to} [CI Skip]`]);
  await sh(["git", "tag", `v${to}`]);
  const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
  await sh(["git", "push", "--quiet", remote, "HEAD:master"], true); await sh(["git", "push", "--quiet", remote, `v${to}`], true);
  const r = await fetch(`https://api.github.com/repos/${repo}/releases`, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "voidbase-release" }, body: JSON.stringify({ tag_name: `v${to}`, name: `v${to}`, body: notes, prerelease: true }) });
  if (!r.ok) { console.error(`GitHub release: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  console.log(`pushed chore(master): release ${to} [CI Skip], tag v${to}, GitHub release created`);
  console.log(to);
}
