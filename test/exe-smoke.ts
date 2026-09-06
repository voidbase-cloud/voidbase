// The prebuilt executable end to end: build it for this machine, serve from a temporary directory with the starter's
// pb_hooks (panel unpacked from the embedded zip, migrations and typings embedded, a thumbnail through the wasm),
// then `voidbase update` against a mock GitHub API (asset for this platform, checksums.txt, executable replaced).
//   bun test/exe-smoke.ts
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { buildExecutables, TARGETS, hostTarget } from "../scripts/build-exe";
import { sha256 } from "../src/node/update";

const PKG = resolve(import.meta.dir, "..");
const STARTER = process.env.STARTER_VB_DIR ?? resolve(PKG, "../voidbase-sveltekit-starter/vb");
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const freePort = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };
const tmp = mkdtempSync(join(tmpdir(), "vb-exe-")); const home = `${tmp}/home`; mkdirSync(home);
const built = await buildExecutables({ targets: ["host"], out: `${tmp}/release`, log: () => undefined });
const T = TARGETS[hostTarget()]!; const exe = `${tmp}/${T.exe}`; copyFileSync(`${PKG}/dist/exe/${hostTarget()}/${T.exe}`, exe); chmodSync(exe, 0o755);
check("release archive and checksums built for the host", built.archives.length === 1 && /^voidbase_\d+\.\d+\.\d+_/.test(built.archives[0]!.file) && readFileSync(`${tmp}/release/checksums.txt`, "utf8").includes(built.archives[0]!.file), JSON.stringify(built.archives));
const run = (args: string[], env: Record<string, string> = {}) => { const p = Bun.spawnSync([exe, ...args], { cwd: tmp, env: { ...process.env, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) }; };
// the update talks to the mock server running in this process: spawn without blocking the event loop
const runAsync = async (args: string[], env: Record<string, string> = {}) => { const p = Bun.spawn([exe, ...args], { cwd: tmp, env: { ...process.env, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { code, out: out + err }; };
check("version prints the embedded version", run(["version"]).out.trim() === built.version, run(["version"]).out);
check("toolchain commands point at the npm package", run(["deploy"]).code === 1 && /npm package/.test(run(["deploy"]).out));

// ---- serve
const port = freePort(); const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([exe, "serve", "--http", `127.0.0.1:${port}`, "--dir", `${tmp}/pb_data`, "--hooksDir", `${STARTER}/pb_hooks`, "--migrationsDir", `${STARTER}/pb_migrations`], { cwd: tmp, env: { ...process.env, HOME: home, VOIDBASE_SUPERUSER_EMAIL: "admin@example.com", VOIDBASE_SUPERUSER_PASSWORD: "changeme123", VOIDBASE_LOG_MIN_LEVEL: "8" }, stdout: "pipe", stderr: "pipe" });
const serverLog: string[] = []; (async () => { for await (const c of server.stdout) serverLog.push(new TextDecoder().decode(c)); })(); (async () => { for await (const c of server.stderr) serverLog.push(new TextDecoder().decode(c)); })();
try {
  let health = 0; for (let i = 0; i < 60 && health !== 200; i++) { await Bun.sleep(500); health = await fetch(`${base}/api/health`).then((r) => r.status).catch(() => 0); }
  check("serves from the single file (migrations embedded)", health === 200, serverLog.join("").slice(-400));
  const panel = await fetch(`${base}/_/`); const panelHtml = await panel.text();
  check("admin panel unpacked from the embedded zip", panel.status === 200 && panelHtml.includes("<html") && !!readFileSync(`${home}/.cache/voidbase/panel-0.40.2/index.html`), String(panel.status));
  const config = await fetch(`${base}/api/config`);
  check("pb_hooks compiled and mounted (the starter's /api/config)", config.status === 200 && (await config.text()).includes("Acme"), String(config.status));
  check("pb_data/types.d.ts written from the embedded typings", readFileSync(`${tmp}/pb_data/types.d.ts`, "utf8").includes("declare"), "");
  const su = (await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.com", password: "changeme123" }) }).then((r) => r.json())) as { token: string };
  const H = { authorization: su.token, "content-type": "application/json" };
  await fetch(`${base}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: "ks_exe", type: "base", listRule: "", viewRule: "", fields: [{ name: "pic", type: "file", maxSelect: 1, maxSize: 5242880, mimeTypes: [], thumbs: ["2x2"] }] }) });
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8AAQv8ZYAwAQ84H+VjtZqAAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
  const fd = new FormData(); fd.append("pic", new Blob([png], { type: "image/png" }), "dot.png");
  const rec = (await fetch(`${base}/api/collections/ks_exe/records`, { method: "POST", headers: { authorization: su.token }, body: fd }).then((r) => r.json())) as { id: string; pic: string };
  const thumb = await fetch(`${base}/api/files/ks_exe/${rec.id}/${rec.pic}?thumb=2x2`);
  check("thumbnail rendered by the embedded wasm", thumb.status === 200 && (thumb.headers.get("content-type") ?? "").startsWith("image/"), `${thumb.status} ${thumb.headers.get("content-type")}`);
} finally { server.kill(); }

// ---- update against a mock GitHub API
const api = freePort(); const zipPort = api;
const newExe = new TextEncoder().encode("#!/bin/sh\necho updated-executable\n");
const goodZip = zipSync({ [T.exe]: [newExe, { level: 6, os: 3, attrs: 0o100755 << 16 }], "CHANGELOG.md": [new TextEncoder().encode("## 99.0.0\n"), { level: 6 }] });
const assetName = `voidbase_99.0.0_${T.os}_${T.arch}.zip`;
let checksumLine = `${await sha256(goodZip)}  ${assetName}\n`;
const mock = Bun.serve({ port: api, hostname: "127.0.0.1", fetch: (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/repos/voidbase-cloud/voidbase/releases/latest") return Response.json({ tag_name: u.searchParams.get("tag") ?? mockTag, body: "> _To update the prebuilt executable you can run `./voidbase update`._\n\n* something new", assets: [{ name: assetName, browser_download_url: `http://127.0.0.1:${zipPort}/dl/${assetName}` }, { name: "checksums.txt", browser_download_url: `http://127.0.0.1:${zipPort}/dl/checksums.txt` }] });
  if (u.pathname === `/dl/${assetName}`) return new Response(goodZip);
  if (u.pathname === "/dl/checksums.txt") return new Response(checksumLine);
  return new Response("nope", { status: 404 });
} });
let mockTag = `v${built.version}`;
try {
  const same = await runAsync(["update", "--dir", `${tmp}/pb_data`], { VOIDBASE_UPDATE_API: `http://127.0.0.1:${api}` });
  check("already on the latest version: nothing replaced", same.code === 0 && /already have the latest version/.test(same.out), same.out.slice(-200));
  mockTag = "v99.0.0"; const saved = checksumLine; checksumLine = `${"0".repeat(64)}  ${assetName}\n`;
  const bad = await runAsync(["update", "--dir", `${tmp}/pb_data`], { VOIDBASE_UPDATE_API: `http://127.0.0.1:${api}` });
  check("checksum mismatch refuses the update and keeps the executable", bad.code !== 0 && /checksum mismatch/.test(bad.out) && run(["version"]).out.trim() === built.version, bad.out.slice(-200));
  checksumLine = saved;
  const ok = await runAsync(["update", "--dir", `${tmp}/pb_data`], { VOIDBASE_UPDATE_API: `http://127.0.0.1:${api}` });
  const after = Bun.spawnSync([exe], { cwd: tmp, stdout: "pipe" });
  check("update: asset for this platform verified, extracted and swapped in, notes printed without the update hint", ok.code === 0 && /Checksum verified/.test(ok.out) && /Update completed successfully/.test(ok.out) && /something new/.test(ok.out) && !/To update the prebuilt/.test(ok.out) && new TextDecoder().decode(after.stdout).trim() === "updated-executable", ok.out.slice(-300));
} finally { mock.stop(true); rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
