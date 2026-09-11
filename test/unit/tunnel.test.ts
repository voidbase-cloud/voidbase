import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflaredAsset, findCloudflared, openTunnel, startTunnel } from "../../src/node/tunnel";

const dir = mkdtempSync(join(tmpdir(), "vb-tunnel-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// a stand-in for cloudflared: the boxed banner on stderr after a moment, then it sits there until it is killed
const FAKE_URL = "https://tiny-fake-words-here.trycloudflare.com";
function fakeCloudflared(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bun\n${body}`);
  chmodSync(path, 0o755);
  return path;
}
const banner = fakeCloudflared("cloudflared-ok.ts", `
const [, , cmd, urlFlag, target] = process.argv;
if (cmd !== "tunnel" || urlFlag !== "--url" || !process.argv.includes("--no-autoupdate")) { console.error("unexpected arguments", process.argv.slice(2)); process.exit(2); }
await Bun.sleep(150);
console.error("2026-09-11T10:00:00Z INF Thank you for trying Cloudflare Tunnel. Do not use quick tunnels in production.");
console.error("2026-09-11T10:00:00Z INF +--------------------------------------------------------------------------------------------+");
console.error("2026-09-11T10:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
console.error("2026-09-11T10:00:00Z INF |  ${FAKE_URL} (target " + target + ")  |");
console.error("2026-09-11T10:00:00Z INF +--------------------------------------------------------------------------------------------+");
await Bun.sleep(60_000);
`);
const silent = fakeCloudflared("cloudflared-silent.ts", `await Bun.sleep(60_000);\n`);
const dying = fakeCloudflared("cloudflared-dying.ts", `console.error("ERR failed to connect"); process.exit(1);\n`);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid: number) => { for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20); return !alive(pid); };

test("release asset names follow cloudflared's naming for the platforms it publishes", () => {
  expect(cloudflaredAsset("linux", "x64")).toBe("cloudflared-linux-amd64");
  expect(cloudflaredAsset("linux", "arm64")).toBe("cloudflared-linux-arm64");
  expect(cloudflaredAsset("darwin", "x64")).toBe("cloudflared-darwin-amd64");
  expect(cloudflaredAsset("darwin", "arm64")).toBe("cloudflared-darwin-arm64");
  expect(cloudflaredAsset("win32", "x64")).toBe("cloudflared-windows-amd64.exe");
  expect(cloudflaredAsset("win32", "arm64")).toBeNull();
  expect(cloudflaredAsset("freebsd", "x64")).toBeNull();
});

test("VOIDBASE_CLOUDFLARED wins, then PATH, then the cache; nothing else is consulted", async () => {
  const logs: string[] = [];
  expect(await findCloudflared({ env: { VOIDBASE_CLOUDFLARED: banner, PATH: "" }, log: (l) => logs.push(l) })).toBe(banner);
  // PATH: a directory holding a `cloudflared`
  writeFileSync(join(dir, "cloudflared"), "#!/bin/sh\n"); chmodSync(join(dir, "cloudflared"), 0o755);
  expect(await findCloudflared({ env: { PATH: dir }, log: (l) => logs.push(l) })).toBe(join(dir, "cloudflared"));
  // the cache: an earlier download is reused without any fetch
  const cacheDir = join(dir, "cache"); mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "cloudflared"), "");
  const neverFetch = (() => { throw new Error("no network in tests"); }) as unknown as typeof fetch;
  expect(await findCloudflared({ env: { PATH: "" }, cacheDir, fetch: neverFetch, platform: "linux", arch: "x64", log: (l) => logs.push(l) })).toBe(join(cacheDir, "cloudflared"));
  expect(logs).toEqual([]);
});

test("the download writes the release binary into the cache, executable, or gives up in one line", async () => {
  const logs: string[] = [];
  const cacheDir = join(dir, "download");
  let requested = "";
  const fakeFetch = (async (url: string | URL | Request) => { requested = String(url); return new Response("#!/bin/sh\necho fake\n"); }) as unknown as typeof fetch;
  const bin = await findCloudflared({ env: { PATH: "" }, cacheDir, fetch: fakeFetch, platform: "darwin", arch: "arm64", log: (l) => logs.push(l) });
  expect(requested).toBe("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64");
  expect(bin).toBe(join(cacheDir, "cloudflared"));
  expect(readFileSync(bin!, "utf8")).toContain("echo fake");
  expect(statSync(bin!).mode & 0o111).not.toBe(0);
  expect(existsSync(`${bin}.part`)).toBe(false);
  expect(logs).toEqual([`voidbase: downloading cloudflared into ${bin}`]);
  // no network: null, one line, nothing left behind
  const failing = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
  const none = await findCloudflared({ env: { PATH: "" }, cacheDir: join(dir, "download-fails"), fetch: failing, platform: "linux", arch: "arm64", log: (l) => logs.push(l) });
  expect(none).toBeNull();
  expect(logs.at(-1)).toMatch(/^voidbase: could not download cloudflared .*cloudflared-linux-arm64 \(HTTP 404\).*; serving without the tunnel$/);
  expect(existsSync(join(dir, "download-fails"))).toBe(false);
});

test("the tunnel's address is read from the banner and the process dies with stop()", async () => {
  const logs: string[] = [];
  const t = await openTunnel(8090, { env: { VOIDBASE_CLOUDFLARED: banner, PATH: "" }, log: (l) => logs.push(l) });
  expect(t).not.toBeNull();
  expect(t!.url).toBe(FAKE_URL);
  expect(alive(t!.pid)).toBe(true);
  expect(logs).toEqual([]);
  t!.stop();
  expect(await gone(t!.pid)).toBe(true);
  expect(typeof (await t!.exited)).toBe("number");
  t!.stop(); // a second stop is a no-op
});

test("a missing binary, a dying cloudflared and a silent one all degrade to serving without the tunnel", async () => {
  let logs: string[] = [];
  const missing = await openTunnel(8090, { env: { VOIDBASE_CLOUDFLARED: join(dir, "nope"), PATH: "" }, log: (l) => logs.push(l) });
  expect(missing).toBeNull();
  expect(logs).toEqual([`voidbase: VOIDBASE_CLOUDFLARED points at ${join(dir, "nope")}, which does not exist; serving without the tunnel`]);

  logs = [];
  expect(await startTunnel(dying, 8090, { log: (l) => logs.push(l) })).toBeNull();
  expect(logs).toEqual(["voidbase: cloudflared exited with 1 (ERR failed to connect); serving without the tunnel"]);

  logs = [];
  const before = Date.now();
  expect(await startTunnel(silent, 8090, { timeoutMs: 300, log: (l) => logs.push(l) })).toBeNull();
  expect(Date.now() - before).toBeLessThan(5_000);
  expect(logs).toEqual(["voidbase: cloudflared gave no address within 0.3s; serving without the tunnel"]);
});
