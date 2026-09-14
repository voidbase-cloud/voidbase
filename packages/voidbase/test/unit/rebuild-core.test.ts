// The core a local version runs on (src/node/core.ts, src/node/rebuild.ts; voidbase-stories voidbase/updating-core.feature):
// an update is a rebuild that brings a new core and lands as a version, a rebuild for any other reason keeps the core
// in place, and a rollback brings the earlier core back.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffFor, servesInstance, takeRequest, writeRequest, writeServeInfo } from "../../src/node/core";
import { createRebuilder } from "../../src/node/rebuild";
import type { Rebuilds } from "../../src/server/rebuilds";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function instance(running = "1.0.0") {
  const d = mkdtempSync(join(tmpdir(), "vb-core-")); dirs.push(d);
  const dataDir = join(d, "pb_data");
  const pin = (plugins: Record<string, string>) => {
    const entries = Object.fromEntries(Object.entries(plugins).map(([name, version]) => [name, { version, integrity: "sha256-x", marketplace: "https://m.example", source: { repository: `a/${name}`, commit: "c".repeat(40) } }]));
    writeFileSync(join(d, "voidbase.lock"), JSON.stringify({ lockfileVersion: 1, marketplaces: [], plugins: entries, disabled: [] }));
    for (const [name, version] of Object.entries(plugins)) { mkdirSync(join(d, "pb_plugins", name), { recursive: true }); writeFileSync(join(d, "pb_plugins", name, "bundle.js"), `// ${name} ${version}\n`); }
  };
  const fetched: string[] = [];
  const cores = join(dataDir, "cores");
  const rebuilds = createRebuilder({
    root: d, dataDir, delayMs: 20, verify: async () => undefined, restart: () => undefined,
    core: {
      current: running, self: { version: running, argv: [`/self/${running}/voidbase`] },
      has: (v) => existsSync(join(cores, v, "core.json")),
      fetch: async (v) => { fetched.push(v); mkdirSync(join(cores, v), { recursive: true }); writeFileSync(join(cores, v, "core.json"), JSON.stringify({ version: v, argv: [`/cores/${v}/voidbase`] })); },
    },
  });
  return { d, dataDir, pin, rebuilds, fetched };
}

async function settled(r: Rebuilds) {
  for (let i = 0; i < 300; i++) { if (!r.state().runs.some((x) => x.status === "queued" || x.status === "running")) return r.state(); await Bun.sleep(10); }
  throw new Error("the rebuild did not settle");
}
const active = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, "active", "core.json"), "utf8")).version as string;

test("an update is a rebuild that brings its core in and lands as a version running on it", async () => {
  const { dataDir, pin, rebuilds, fetched } = instance("1.0.0");
  pin({ backups: "0.1.0" }); rebuilds.queue("install backups 0.1.0");
  let s = await settled(rebuilds);
  expect(s.versions.at(-1)!.core).toBe("1.0.0");
  expect(active(dataDir)).toBe("1.0.0");
  expect(fetched).toEqual([]);
  expect(handoffFor(dataDir, "1.0.0")).toBeNull();

  rebuilds.queue("update voidbase 1.0.0 -> 2.0.0", { core: "2.0.0" });
  s = await settled(rebuilds);
  expect(s.runs.at(-1)!.steps.map((x) => `${x.name}:${x.status}`)).toEqual(["declare:done", "fetch:done", "assemble:done", "upload:done", "restart:done"]);
  expect(s.versions.at(-1)).toMatchObject({ number: 2, core: "2.0.0" });
  expect(fetched).toEqual(["2.0.0"]);
  expect(active(dataDir)).toBe("2.0.0");
  // the process that comes back is still the old voidbase until it hands over to the pinned one
  expect(handoffFor(dataDir, "1.0.0")?.argv).toEqual(["/cores/2.0.0/voidbase"]);
  expect(handoffFor(dataDir, "2.0.0")).toBeNull();
});

test("a rebuild for any other reason keeps the core the instance runs on, and fetches nothing", async () => {
  const { dataDir, pin, rebuilds, fetched } = instance("1.0.0");
  pin({ backups: "0.1.0" }); rebuilds.queue("install backups"); await settled(rebuilds);
  rebuilds.queue("update voidbase", { core: "2.0.0" }); await settled(rebuilds);
  pin({ backups: "0.1.0", mail: "0.1.0" }); rebuilds.queue("install mail");
  const s = await settled(rebuilds);
  expect(s.versions.at(-1)).toMatchObject({ number: 3, core: "2.0.0" });
  expect(active(dataDir)).toBe("2.0.0");
  expect(fetched).toEqual(["2.0.0"]);
});

test("rolling an update back brings the earlier core back, and puts nothing about cores in the project root", async () => {
  const { d, dataDir, pin, rebuilds } = instance("1.0.0");
  pin({ backups: "0.1.0" }); rebuilds.queue("install backups"); await settled(rebuilds);
  rebuilds.queue("update voidbase", { core: "2.0.0" }); await settled(rebuilds);
  rebuilds.rollback(1);
  const s = await settled(rebuilds);
  expect(s.current).toBe(1);
  expect(active(dataDir)).toBe("1.0.0");
  expect(existsSync(join(d, "core.json"))).toBe(false);
  // the voidbase that served version 1 was recorded when it was pinned, so the one now running can hand back to it
  expect(handoffFor(dataDir, "2.0.0")?.argv).toEqual(["/self/1.0.0/voidbase"]);
});

test("a pinned core that is missing is named, with the way out", async () => {
  const { dataDir, pin, rebuilds } = instance("1.0.0");
  pin({ backups: "0.1.0" }); rebuilds.queue("install backups"); await settled(rebuilds);
  rebuilds.queue("update voidbase", { core: "2.0.0" }); await settled(rebuilds);
  rmSync(join(dataDir, "cores", "2.0.0"), { recursive: true, force: true });
  expect(() => handoffFor(dataDir, "1.0.0")).toThrow("voidbase rollback");
});

test("a request left for a running instance is read once", () => {
  const d = mkdtempSync(join(tmpdir(), "vb-core-req-")); dirs.push(d);
  writeRequest(d, { update: "2.0.0" });
  expect(takeRequest(d)).toEqual({ update: "2.0.0" });
  expect(takeRequest(d)).toBeNull();
  writeRequest(d, { rollback: 3 });
  expect(takeRequest(d)).toEqual({ rollback: 3 });
});

test("the first update of an instance that never pinned a version makes what it runs a version first, so the update can be rolled back", async () => {
  const { dataDir, pin, rebuilds } = instance("1.0.0");
  pin({ backups: "0.1.0" });
  rebuilds.queue("update voidbase 1.0.0 -> 2.0.0", { core: "2.0.0" });
  let s = await settled(rebuilds);
  expect(s.versions.map((v) => ({ number: v.number, core: v.core, from: v.from }))).toEqual([{ number: 1, core: "1.0.0", from: null }, { number: 2, core: "2.0.0", from: 1 }]);
  expect(active(dataDir)).toBe("2.0.0");
  rebuilds.rollback(1);
  s = await settled(rebuilds);
  expect(s.current).toBe(1);
  expect(active(dataDir)).toBe("1.0.0");
});

test("a second server on the same pb_data does not take the running instance's record", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-serves-"));
  try {
    // nobody recorded: this process may record itself
    expect(servesInstance(dir, process.pid)).toBe(true);
    // the running instance (a live process that is not this one) is recorded: a second server leaves it
    writeServeInfo(dir, { pid: process.ppid, http: "http://127.0.0.1:8392", version: "1.0.0", requests: true });
    expect(servesInstance(dir, process.pid)).toBe(false);
    expect(servesInstance(dir, process.ppid)).toBe(true);
    // a record of a process that is gone counts as nobody
    writeServeInfo(dir, { pid: 2 ** 22 + 12345, http: "http://127.0.0.1:35625", version: "1.0.0", requests: true });
    expect(servesInstance(dir, process.pid)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
