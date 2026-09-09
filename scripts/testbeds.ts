// The testbeds follow the release: after a version is published, the demo, the marketplace and the site are moved
// onto it, and each of their pushes builds and deploys on Cloudflare through its repository connection.
//
//   bun scripts/testbeds.ts <version>        pin every testbed to that version (skips one that already is)
//
// Runs as the last step of the release flow (scripts/release.sh) with GH_TOKEN, a token that may push to the
// repositories in TESTBEDS (comma separated; default the three of voidbase-cloud), and from any machine the same
// way. The commit is what the old hourly tracker made, `chore(deps): voidbase <version>`, by voidbase-bot. The push
// names the token in the URL it pushes to: a build image carries git credentials of its own (Cloudflare's pushes
// as its GitHub App, which may not push here) and they win over a credential helper, and every line printed is
// scrubbed of the token. A testbed that cannot be moved fails this step, so the release build shows it.
// npm serves a version a little after `npm publish` returns (the first run found it three seconds too early), so
// this waits until the registry answers for it before asking bun to install it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) { console.error("usage: bun scripts/testbeds.ts <version>"); process.exit(2); }
const token = process.env.GH_TOKEN ?? "";
if (!token) { console.error("GH_TOKEN is not set: nothing can be pushed"); process.exit(2); }
const repos = (process.env.TESTBEDS ?? "voidbase-cloud/voidbase-demo,voidbase-cloud/voidbase-marketplace,voidbase-cloud/voidbase-site").split(",").map((r) => r.trim()).filter(Boolean);
const PKG = "@voidbase-cloud/voidbase";
const scrub = (s: string) => s.split(token).join("***");
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

async function sh(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(scrub(`${cmd.join(" ")} exited ${code}\n${(out + err).trim().slice(-1500)}`));
  return out;
}

/** the registry answers for the version: publish returns before every replica serves it */
async function served(): Promise<boolean> {
  for (let i = 0; i < 24; i++) {
    const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PKG).replace("%40", "@")}/${version}`, { headers: { "user-agent": "voidbase-testbeds" } }).catch(() => null);
    if (r?.ok) { const j = (await r.json().catch(() => ({}))) as { version?: string }; if (j.version === version) return true; }
    if (i === 0) console.log(`waiting for the registry to serve ${PKG}@${version}`);
    await Bun.sleep(10000);
  }
  return false;
}
if (!(await served())) { console.error(`${PKG}@${version} is not served by the registry after four minutes; run \`bun scripts/testbeds.ts ${version}\` once it is`); process.exit(1); }

let failed = 0;
for (const repo of repos) {
  const dir = mkdtempSync(join(tmpdir(), "vb-testbed-"));
  try {
    await sh(["git", "clone", "--quiet", "--depth", "1", `https://github.com/${repo}.git`, dir], tmpdir());
    const pkg = JSON.parse(await Bun.file(join(dir, "package.json")).text()) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const pinned = pkg.dependencies?.[PKG] ?? pkg.devDependencies?.[PKG] ?? "";
    if (!pinned) { console.log(`${repo}: does not depend on ${PKG}; skipped`); continue; }
    if (pinned === version) { console.log(`${repo}: already on ${version}`); continue; }
    await sh(["bun", "add", "--exact", `${PKG}@${version}`], dir);
    await sh(["git", "-c", "user.name=voidbase-bot", "-c", "user.email=noreply@voidbase.cloud", "commit", "--quiet", "-am", `chore(deps): voidbase ${version}`], dir);
    const branch = (await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], dir)).trim() || "master";
    await sh(["git", "push", "--quiet", `https://x-access-token:${token}@github.com/${repo}.git`, `HEAD:${branch}`], dir);
    console.log(`${repo}: ${pinned} -> ${version}, pushed; its Cloudflare build deploys it`);
  } catch (err) {
    failed++;
    console.error(`${repo}: ${scrub(err instanceof Error ? err.message : String(err))}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (failed) { console.error(`${failed} testbed(s) not moved; run \`bun scripts/testbeds.ts ${version}\` again with a token that may push`); process.exit(1); }
