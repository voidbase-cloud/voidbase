// The testbeds follow the release: after a version is published, the demo, the marketplace and the site are moved
// onto it, and each of their pushes builds and deploys on Cloudflare through its repository connection.
//
//   bun scripts/testbeds.ts <version>        pin every testbed to that version (skips one that already is)
//
// Runs as the last step of the release flow (scripts/release.sh) with GH_TOKEN, a token that may push to the
// repositories in TESTBEDS (comma separated; default the three of voidbase-cloud), and from any machine the same
// way. The commit is what the old hourly tracker made, `chore(deps): voidbase <version>`, by voidbase-bot. The token
// is handed to git through a credential helper, never on the command line and never in a URL, and every line
// printed is scrubbed of it. A testbed that cannot be moved fails this step, so the release build shows it.
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
// git asks the helper for credentials; the helper answers from the environment
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f' };

async function sh(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(scrub(`${cmd.join(" ")} exited ${code}\n${(out + err).trim().slice(-1500)}`));
  return out;
}

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
    await sh(["git", "push", "--quiet", "origin", "HEAD"], dir);
    console.log(`${repo}: ${pinned} -> ${version}, pushed; its Cloudflare build deploys it`);
  } catch (err) {
    failed++;
    console.error(`${repo}: ${scrub(err instanceof Error ? err.message : String(err))}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (failed) { console.error(`${failed} testbed(s) not moved; run \`bun scripts/testbeds.ts ${version}\` again with a token that may push`); process.exit(1); }
