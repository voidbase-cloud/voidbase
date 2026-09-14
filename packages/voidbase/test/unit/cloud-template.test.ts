// A cloud instance from a template (src/node/cloud-template.ts): the template's files deployed under the name given,
// with none of its author's deploy target and a superuser of its own; nothing is left on this machine.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFromTemplate, TARGET_KNOBS } from "../../src/node/cloud-template";
import type { SyncOptions } from "../../src/node/sync";

function fakes(files: Record<string, string>) {
  const seen: { dir?: string; sync?: SyncOptions; env?: Record<string, string | undefined>; installed?: string } = {};
  return {
    seen,
    fetchTemplate: async (_input: string, dir: string) => {
      for (const [path, body] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), body); }
      seen.dir = dir;
      return { repository: "voidbase-cloud/voidbase-demo", ref: "master", dir, files: Object.keys(files).length, next: [] };
    },
    install: (dir: string) => { seen.installed = dir; },
    sync: async (o: SyncOptions) => {
      seen.sync = o;
      seen.env = Object.fromEntries([...TARGET_KNOBS, "VOIDBASE_SUPERUSER_EMAIL", "VOIDBASE_SUPERUSER_PASSWORD"].map((k) => [k, process.env[k]]));
      expect(existsSync(join(o.dir!, "pb_hooks/demo.pb.js"))).toBe(true);
    },
  };
}

describe("creating a cloud instance from a template", () => {
  test("the template deploys under the given name, with no deploy target of its author's or this shell's, and a superuser of its own", async () => {
    const f = fakes({ "pb_hooks/demo.pb.js": "cronAdd('demo-reset', '0 * * * *', () => {})", "package.json": "{}" });
    const shell = { VOIDBASE_DOMAINS: process.env.VOIDBASE_DOMAINS, VOIDBASE_DEPLOY_NAME: process.env.VOIDBASE_DEPLOY_NAME, VOIDBASE_SUPERUSER_PASSWORD: process.env.VOIDBASE_SUPERUSER_PASSWORD };
    process.env.VOIDBASE_DOMAINS = "site.example"; process.env.VOIDBASE_DEPLOY_NAME = "someone-else"; process.env.VOIDBASE_SUPERUSER_PASSWORD = "the shell's";
    try {
      const made = await createFromTemplate({ template: "voidbase-demo", name: "vbstories-et", email: "admin@example.com", log: () => undefined, ...f });
      expect(f.seen.sync).toMatchObject({ name: "vbstories-et", data: false, ci: false });
      expect(f.seen.installed).toBe(f.seen.dir);
      for (const k of TARGET_KNOBS) expect(f.seen.env![k]).toBeUndefined();
      expect(f.seen.env!.VOIDBASE_SUPERUSER_EMAIL).toBe("admin@example.com");
      expect(f.seen.env!.VOIDBASE_SUPERUSER_PASSWORD).toBe(made.password);
      expect(made.password).toMatch(/^[A-Za-z0-9]{24}$/);
      expect(made).toMatchObject({ repository: "voidbase-cloud/voidbase-demo", ref: "master", email: "admin@example.com" });
      // the shell is as it was, and nothing of the template stays on this machine
      expect(process.env.VOIDBASE_DOMAINS).toBe("site.example");
      expect(process.env.VOIDBASE_DEPLOY_NAME).toBe("someone-else");
      expect(process.env.VOIDBASE_SUPERUSER_PASSWORD).toBe("the shell's");
      expect(existsSync(f.seen.dir!)).toBe(false);
    } finally { for (const [k, v] of Object.entries(shell)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });

  test("a template with no package.json installs nothing; a failed deploy still removes the scratch directory", async () => {
    const f = fakes({ "pb_hooks/demo.pb.js": "" });
    const before = process.env.VOIDBASE_SUPERUSER_EMAIL;
    const failing = { ...f, sync: async (o: SyncOptions) => { await f.sync(o); throw new Error("deploy refused"); } };
    await expect(createFromTemplate({ template: "voidbase-demo", name: "vbstories-et", email: "a@b.c", log: () => undefined, ...failing })).rejects.toThrow("deploy refused");
    expect(f.seen.installed).toBeUndefined();
    expect(existsSync(f.seen.dir!)).toBe(false);
    expect(process.env.VOIDBASE_SUPERUSER_EMAIL).toBe(before);
  });
});
