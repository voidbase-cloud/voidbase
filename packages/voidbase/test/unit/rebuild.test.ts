// A vanilla instance rebuilding itself on this machine (src/node/rebuild.ts): changes folding into one run, the steps
// recorded, a failure at the upload step and a retry that resumes from it, versions, and a rollback.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRebuilder } from "../../src/node/rebuild";
import { restartCommand } from "../../src/node/restart";
import type { Rebuilds } from "../../src/server/rebuilds";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { try { chmodSync(join(d, "pb_data/active"), 0o755); } catch { /* not made */ } rmSync(d, { recursive: true, force: true }); } });

function project() {
  const d = mkdtempSync(join(tmpdir(), "vb-rebuild-")); dirs.push(d);
  const pin = (plugins: Record<string, string>) => {
    const entries = Object.fromEntries(Object.entries(plugins).map(([name, version]) => [name, { version, integrity: "sha256-x", marketplace: "https://m.example", source: { repository: `a/${name}`, commit: `${name}-${version}` }, installedOn: "2026-09-13" }]));
    writeFileSync(join(d, "voidbase.lock"), JSON.stringify({ lockfileVersion: 1, marketplaces: [], plugins: entries, disabled: [] }));
    for (const [name, version] of Object.entries(plugins)) { mkdirSync(join(d, "pb_plugins", name), { recursive: true }); writeFileSync(join(d, "pb_plugins", name, "bundle.js"), `// ${name} ${version}\n`); }
  };
  let verified = 0, restarts = 0;
  const rebuilds = createRebuilder({ root: d, dataDir: join(d, "pb_data"), delayMs: 20, verify: async () => { verified++; }, restart: () => { restarts++; } });
  return { d, pin, rebuilds, counts: () => ({ verified, restarts }) };
}

/** until no run waits or runs */
async function settled(r: Rebuilds) {
  for (let i = 0; i < 200; i++) { if (!r.state().runs.some((x) => x.status === "queued" || x.status === "running")) return r.state(); await Bun.sleep(10); }
  throw new Error("the rebuild did not settle");
}

test("three changes in a row are one rebuild, which builds what is declared when it runs, lands as a version and restarts", async () => {
  const { d, pin, rebuilds, counts } = project();
  pin({ backups: "0.1.0" }); rebuilds.queue("install backups 0.1.0");
  pin({ backups: "0.1.0", mail: "0.1.0" }); rebuilds.queue("install mail 0.1.0");
  pin({ backups: "0.1.0", mail: "0.1.0", hardening: "0.1.0" }); rebuilds.queue("install hardening 0.1.0");
  const s = await settled(rebuilds);
  expect(s.runs).toHaveLength(1);
  expect(s.runs[0]!.reasons).toEqual(["install backups 0.1.0", "install mail 0.1.0", "install hardening 0.1.0"]);
  expect(s.runs[0]!.steps.map((x) => `${x.name}:${x.status}`)).toEqual(["declare:done", "fetch:done", "assemble:done", "upload:done", "restart:done"]);
  expect(Object.keys(s.runs[0]!.declared!).sort()).toEqual(["backups", "hardening", "mail"]);
  expect(s.versions.map((v) => v.number)).toEqual([1]);
  expect(s.current).toBe(1);
  expect(readFileSync(join(d, "pb_data/active/pb_plugins/hardening/bundle.js"), "utf8")).toBe("// hardening 0.1.0\n");
  expect(counts()).toEqual({ verified: 1, restarts: 1 });
});

test("a rebuild that fails at the upload step names it, and the retry resumes from there without doing the rest again", async () => {
  const { d, pin, rebuilds, counts } = project();
  pin({ backups: "0.1.0" }); rebuilds.queue("install backups 0.1.0");
  await settled(rebuilds);
  // the version in place cannot be replaced: the next upload fails for real
  chmodSync(join(d, "pb_data/active"), 0o555);
  pin({ backups: "0.2.0" }); rebuilds.queue("update backups");
  const failed = (await settled(rebuilds)).runs.at(-1)!;
  expect(failed.status).toBe("failed");
  expect(failed.steps.find((x) => x.status === "failed")?.name).toBe("upload");
  expect(failed.steps.find((x) => x.name === "upload")?.detail).toMatch(/EACCES|permission denied/i);
  const before = counts();
  chmodSync(join(d, "pb_data/active"), 0o755);
  expect(rebuilds.retry()?.id).toBe(failed.id);
  const s = await settled(rebuilds);
  const retried = s.runs.at(-1)!;
  expect(retried.status).toBe("done");
  expect(retried.steps.map((x) => `${x.name}:${x.status}`)).toEqual(["declare:done", "fetch:done", "assemble:done", "upload:done", "restart:done"]);
  // the declare, fetch and assemble of the first attempt stand: no second verification, no second version
  expect(counts().verified).toBe(before.verified);
  expect(s.versions.map((v) => v.number)).toEqual([1, 2]);
  expect(s.current).toBe(2);
  expect(readFileSync(join(d, "pb_data/active/pb_plugins/backups/bundle.js"), "utf8")).toBe("// backups 0.2.0\n");
  expect(rebuilds.retry()).toBeNull();
});

test("rolling back puts the instance and the declaration back onto a version it already assembled", async () => {
  const { d, pin, rebuilds, counts } = project();
  pin({ backups: "0.1.0" }); rebuilds.queue("install backups 0.1.0"); await settled(rebuilds);
  pin({ backups: "0.2.0" }); rebuilds.queue("update backups"); await settled(rebuilds);
  const run = rebuilds.rollback(1);
  const s = await settled(rebuilds);
  expect(s.runs.at(-1)!.id).toBe(run.id);
  expect(s.runs.at(-1)!.steps.map((x) => `${x.name}:${x.status}`)).toEqual(["declare:skipped", "fetch:skipped", "assemble:skipped", "upload:done", "restart:done"]);
  expect(s.current).toBe(1);
  expect(readFileSync(join(d, "pb_data/active/pb_plugins/backups/bundle.js"), "utf8")).toBe("// backups 0.1.0\n");
  expect(JSON.parse(readFileSync(join(d, "voidbase.lock"), "utf8")).plugins.backups.version).toBe("0.1.0");
  expect(counts().restarts).toBe(3);
  expect(() => rebuilds.rollback(9)).toThrow("there is no version 9 to roll back to");
});

test("a restart starts the same command with the paths serve derives put back as they were", () => {
  const env = { VOIDBASE_RESTART_ARGV: JSON.stringify(["/usr/bin/bun", "/app/bin/voidbase.ts", "serve", "--http", "127.0.0.1:8395"]), VOIDBASE_RESTART_ENV: JSON.stringify({ VOIDBASE_PLUGINS_DIR: null, VOIDBASE_HOOKS_DIR: "custom_hooks" }), VOIDBASE_PLUGINS_DIR: "/data/pb_data/active/pb_plugins", VOIDBASE_HOOKS_DIR: "/abs/pb_hooks", KEEP: "1" };
  expect(restartCommand(env)).toEqual({ cmd: ["/usr/bin/bun", "/app/bin/voidbase.ts", "serve", "--http", "127.0.0.1:8395"], env: { ...env, VOIDBASE_PLUGINS_DIR: undefined, VOIDBASE_HOOKS_DIR: "custom_hooks" } });
  const compiled = restartCommand({ VOIDBASE_RESTART_ARGV: JSON.stringify(["/usr/local/bin/voidbase", "/$bunfs/root/voidbase", "serve"]) });
  expect(compiled?.cmd).toEqual(["/usr/local/bin/voidbase", "serve"]);
  expect(restartCommand({})).toBeNull();
});

test("while a change is still being made the rebuild waits, so installs slower than the wait still fold into one", async () => {
  const { pin, rebuilds } = project();
  let release = rebuilds.hold(); await Bun.sleep(60); pin({ backups: "0.1.0" }); rebuilds.queue("install backups"); release();
  // the next install starts before the wait is over and takes longer than it: nothing runs meanwhile
  release = rebuilds.hold(); await Bun.sleep(60);
  expect(rebuilds.state().runs.map((r) => r.status)).toEqual(["queued"]);
  pin({ backups: "0.1.0", mail: "0.1.0" }); rebuilds.queue("install mail"); release();
  const s = await settled(rebuilds);
  expect(s.runs).toHaveLength(1);
  expect(s.runs[0]!.reasons).toEqual(["install backups", "install mail"]);
  expect(Object.keys(s.runs[0]!.declared!).sort()).toEqual(["backups", "mail"]);
});
