// Hot mode's release: every push to master is a release, in the same build, with nothing in the way.
//
//   bun scripts/hot-release.ts [--dry-run]      bumps the prerelease number, writes CHANGELOG.md, commits `[skip ci]`,
//                                               tags, pushes commit and tag, creates the GitHub release; prints the version
//
// The bump is the prerelease counter (0.9.0-beta.24 -> 0.9.0-beta.25); release-please's manifest is kept in step, so
// a normal run later (the one that builds the executables) sees a consistent history. The commit carries `[CI Skip]`
// so the push it makes does not start another build. GH_TOKEN pushes and creates the release; scripts/release.sh
// --hot --tag v<version> then publishes to npm in the same build (scripts/ci.sh).
import { readFileSync, writeFileSync } from "node:fs";

export function nextPrerelease(version: string): string {
  const m = /^(\d+\.\d+\.\d+)-([A-Za-z]+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`${version} is not a prerelease like 0.9.0-beta.24; hot mode releases prereleases only`);
  return `${m[1]}-${m[2]}.${Number(m[3]) + 1}`;
}

if (import.meta.main) {
  const dry = process.argv.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY ?? "voidbase-cloud/voidbase";
  const token = process.env.GH_TOKEN ?? "";
  const sh = async (cmd: string[], quiet = false) => { const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(); const err = await new Response(p.stderr).text(); if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${err.trim() || out.trim()}`); if (!quiet && out.trim()) console.log(out.trim()); return out.trim(); };
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const from = pkg.version, to = nextPrerelease(from);
  const lastTag = await sh(["git", "describe", "--tags", "--abbrev=0", "--match", "v*"], true).catch(() => "");
  const subjects = (await sh(["git", "log", "--format=%s", ...(lastTag ? [`${lastTag}..HEAD`] : ["-20"])], true)).split("\n").filter((l) => l && !/^chore\(master\): release/.test(l));
  const date = new Date().toISOString().slice(0, 10);
  const notes = `## [${to}](https://github.com/${repo}/compare/v${from}...v${to}) (${date})\n\n${subjects.map((s) => `* ${s}`).join("\n") || "* (no commits since the last release)"}\n`;
  console.log(`hot release: ${from} -> ${to} (${subjects.length} commit(s) since ${lastTag || "the start"})${dry ? " [dry run]" : ""}`);
  if (dry) { console.log(notes); process.exit(0); }
  if (!token) { console.error("GH_TOKEN is not set: the release cannot be pushed"); process.exit(1); }
  writeFileSync("package.json", readFileSync("package.json", "utf8").replace(`"version": "${from}"`, `"version": "${to}"`));
  try { const m = JSON.parse(readFileSync(".release-please-manifest.json", "utf8")) as Record<string, string>; for (const k of Object.keys(m)) if (m[k] === from) m[k] = to; writeFileSync(".release-please-manifest.json", `${JSON.stringify(m, null, 2)}\n`); } catch { /* no manifest */ }
  try { const c = readFileSync("CHANGELOG.md", "utf8"); const i = c.indexOf("\n## "); writeFileSync("CHANGELOG.md", i >= 0 ? `${c.slice(0, i + 1)}${notes}\n${c.slice(i + 1)}` : `${c.trimEnd()}\n\n${notes}`); } catch { writeFileSync("CHANGELOG.md", `# Changelog\n\n${notes}`); }
  await sh(["git", "config", "user.name", "voidbase release"]); await sh(["git", "config", "user.email", "release@voidbase.cloud"]);
  await sh(["git", "add", "package.json", ".release-please-manifest.json", "CHANGELOG.md"]);
  await sh(["git", "commit", "-q", "-m", `chore(master): release ${to} [CI Skip]`]);
  await sh(["git", "tag", `v${to}`]);
  const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
  await sh(["git", "push", "--quiet", remote, "HEAD:master"], true); await sh(["git", "push", "--quiet", remote, `v${to}`], true);
  const r = await fetch(`https://api.github.com/repos/${repo}/releases`, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "voidbase-release" }, body: JSON.stringify({ tag_name: `v${to}`, name: `v${to}`, body: notes, prerelease: true }) });
  if (!r.ok) { console.error(`GitHub release: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  console.log(`pushed chore(master): release ${to} [CI Skip], tag v${to}, GitHub release created`);
  console.log(to);
}
