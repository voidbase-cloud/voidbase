// The builder behind "install a plugin" on a cloud instance, for a control plane that cannot build.
//
//   bun scripts/instance-build.ts            claims queued builds from VB_CLOUD_URL (VB_BUILD_EMAIL / VB_BUILD_PASSWORD
//                                            are a superuser there), builds each, and reports back
//   bun scripts/instance-build.ts --once     one build, then exit (the default builds until the queue is empty)
//
// A cloud instance has no filesystem its owner holds, and the control plane is a Worker with no bun and no Vite in
// it, so the set of plugins an instance runs is fixed when its Worker is built. This script is where that build
// happens: a queued instance is claimed, its plugins are installed the way `voidbase plugins add` installs them
// (verified against the hash the marketplace promised, and against the hash the control plane recorded), a release
// is built with them baked in by the instance's own released voidbase version, pushed to the control plane without
// becoming the default, and the control plane re-provisions the instance from it. Every step that fails reports the
// reason back, so the dashboard can say it.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLOUD = (process.env.VB_CLOUD_URL ?? "").replace(/\/+$/, "");
const EMAIL = process.env.VB_BUILD_EMAIL ?? ""; const PASSWORD = process.env.VB_BUILD_PASSWORD ?? "";
const REPO = resolve(import.meta.dir, "..");
const once = process.argv.includes("--once");
if (!CLOUD || !EMAIL || !PASSWORD) { console.error("VB_CLOUD_URL, VB_BUILD_EMAIL and VB_BUILD_PASSWORD are required"); process.exit(2); }

interface Job { id: string; name: string; base: string; plugins: { name: string; version: string; marketplace: string; integrity: string }[] }

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: T }> {
  const r = await fetch(`${CLOUD}${path}`, { method, headers: { "user-agent": "voidbase-instance-build", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: T; try { json = JSON.parse(text) as T; } catch { json = { raw: text } as T; }
  return { status: r.status, json };
}
const sh = async (cmd: string[], cwd: string, env: Record<string, string | undefined> = {}): Promise<string> => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}\n${(out + err).trim().slice(-2000)}`);
  return out;
};
/** 0.9.0-beta.8 is the first voidbase whose `bundle` takes --plugins-dir; a base before it cannot carry plugins */
const supports = (v: string) => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?/.exec(v); if (!m) return false; const [maj, min, pat, beta] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])]; return maj > 0 || min > 9 || (min === 9 && (pat > 0 || beta >= 8)); };

/** the base release's own voidbase, checked out at its tag, with its dependencies: the build runs from there */
async function checkoutBase(version: string): Promise<string> {
  const dir = resolve(tmpdir(), `voidbase-base-${version.replace(/[^A-Za-z0-9._-]/g, "-")}`);
  if (!existsSync(join(dir, "node_modules"))) {
    rmSync(dir, { recursive: true, force: true });
    await sh(["git", "fetch", "--tags", "--quiet"], REPO);
    await sh(["git", "worktree", "add", "--detach", dir, `v${version}`], REPO);
    await sh(["bun", "install", "--frozen-lockfile"], dir);
  }
  return dir;
}

async function build(job: Job, token: string): Promise<string> {
  const log = (l: string) => console.log(`[${job.name}] ${l}`);
  if (!supports(job.base)) throw new Error(`the base release ${job.base} predates voidbase plugins for cloud instances (0.9.0-beta.8); push a newer release first`);
  const base = await checkoutBase(job.base);
  const project = mkdtempSync(join(tmpdir(), `vb-instance-${job.name}-`));
  try {
    for (const p of job.plugins) {
      log(`installing ${p.name} ${p.version} from ${p.marketplace}`);
      await sh(["bun", "bin/voidbase.ts", "plugins", "add", `${p.name}@${p.version}`, "--marketplace", p.marketplace, "--dir", project], base);
      const lock = JSON.parse(await Bun.file(join(project, "voidbase.lock")).text()) as { plugins: Record<string, { integrity: string }> };
      const got = lock.plugins[p.name]?.integrity;
      if (got !== p.integrity) throw new Error(`${p.name} ${p.version}: the marketplace served ${got}, the instance recorded ${p.integrity}; nothing was built`);
    }
    const version = `${job.base}-${job.name}.${Date.now().toString(36)}`;
    const out = join(project, "release");
    log(`building release ${version}`);
    await sh(["bun", "bin/voidbase.ts", "bundle", "--plugins-dir", join(project, "pb_plugins"), "--version", version, "--out", out], base);
    log("pushing it to the control plane, without making it the default");
    await sh(["bun", "bin/voidbase.ts", "release", "push", out, "--url", CLOUD, "--token", token, "--no-activate"], base);
    return version;
  } finally { rmSync(project, { recursive: true, force: true }); }
}

const login = await api<{ token?: string; message?: string }>("POST", "/api/collections/_superusers/auth-with-password", { identity: EMAIL, password: PASSWORD });
if (login.status !== 200 || !login.json.token) { console.error(`login as ${EMAIL} at ${CLOUD} failed: ${login.status} ${login.json.message ?? ""}`); process.exit(1); }
const token = login.json.token;
let built = 0, failed = 0;
for (;;) {
  const next = await api<Job | { message?: string }>("GET", "/api/vbcloud/builds/next", undefined, token);
  if (next.status === 204) break;
  if (next.status !== 200) { console.error(`claiming a build failed: ${next.status} ${JSON.stringify(next.json)}`); process.exit(1); }
  const job = next.json as Job;
  console.log(`build for ${job.name} (${job.id}): base ${job.base}, plugins ${job.plugins.map((p) => `${p.name}@${p.version}`).join(", ") || "none"}`);
  try {
    const version = await build(job, token);
    const done = await api<{ message?: string }>("POST", `/api/vbcloud/builds/${job.id}/done`, { version }, token);
    if (done.status !== 200) throw new Error(`the control plane refused the release: ${done.status} ${done.json.message ?? JSON.stringify(done.json)}`);
    console.log(`[${job.name}] live on ${version}`); built++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${job.name}] failed: ${message}`); failed++;
    await api("POST", `/api/vbcloud/builds/${job.id}/failed`, { error: message.slice(0, 1000) }, token);
  }
  if (once) break;
}
console.log(`${built} built, ${failed} failed`);
process.exit(failed ? 1 : 0);
