// An extended project's own entry point: which file a deploy composes into the Worker, how it is composed, and what
// `@voidbase-cloud/voidbase` is inside the Worker.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCloudProject } from "../../src/node/cloud-init";
import { projectEntry } from "../../src/node/deploy-cf";
import { voidbase } from "../../src/server/library";
import { hookGlobals } from "../../src/server/hooks";

const dirs: string[] = [];
const project = (files: Record<string, string>) => { const d = mkdtempSync(join(tmpdir(), "vb-entry-")); dirs.push(d); for (const [f, s] of Object.entries(files)) writeFileSync(join(d, f), s); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("an index.ts that loads voidbase itself is the project's entry point", () => {
  const d = project({ "index.ts": `import { voidbase } from "@voidbase-cloud/voidbase"\nconst app = await voidbase({ hooksDir: "pb_hooks" })\nawait app.start()\n` });
  expect(projectEntry(d)).toEqual({ entry: join(d, "index.ts"), entryRegisters: false });
});

test("a main.ts that exports register is still called with the app", () => {
  const d = project({ "main.ts": `export function register(app) {}\n`, "index.ts": `import { serve } from "@voidbase-cloud/voidbase"\n` });
  expect(projectEntry(d)).toEqual({ entry: join(d, "main.ts"), entryRegisters: true });
});

test("a project with no entry of its own composes nothing", () => {
  expect(projectEntry(project({ "index.ts": `console.log("not voidbase")\n` }))).toEqual({});
});

test("the Worker imports an entry that loads voidbase as it is", () => {
  const d = project({});
  writeCloudProject(join(d, "cloud"), "package", { entry: "/p/index.ts", entryRegisters: false, queue: false });
  const route = readFileSync(join(d, "cloud/routes/api/[...path].ts"), "utf8");
  expect(route).toContain(`import "/p/index.ts";`);
  expect(route).not.toContain("register(");
});

test("inside the Worker, voidbase() is the Worker's app: a route it adds is registered and start() starts nothing", async () => {
  const before = (hookGlobals() as unknown as { routerAdd: unknown }).routerAdd;
  expect(typeof before).toBe("function");
  const app = await voidbase({ dir: "pb_data" });
  expect(typeof app.router.get).toBe("function");
  expect(app.hooks).toBe(hookGlobals() as never);
  const started = await app.start();
  expect(started.server).toBeUndefined();
});
