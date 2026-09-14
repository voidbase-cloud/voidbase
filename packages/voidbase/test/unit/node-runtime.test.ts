// The Node the executable's toolchain runs Void, Vite and wrangler with (src/node/node-runtime.ts): VOIDBASE_NODE, a
// Node on PATH that is not the toolchain's own shim, or the pinned release, downloaded once and refused when its checksum
// is not the one written down.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNode, NODE_ARCHIVES, NODE_VERSION, nodeTarget, systemNode } from "../../src/node/node-runtime";
import { TARGETS } from "../../../../scripts/build-exe";

const fakeNode = (dir: string, answer: string) => { mkdirSync(dir, { recursive: true }); const f = join(dir, "node"); writeFileSync(f, `#!/bin/sh\necho ${answer}\n`); chmodSync(f, 0o755); return f; };

describe("the Node for the executable's toolchain", () => {
  test("every platform an executable is built for has a pinned Node with a sha256", () => {
    const key = (t: string) => t.replace(/^windows-/, "win32-");
    for (const t of Object.keys(TARGETS)) {
      const a = NODE_ARCHIVES[key(t)];
      expect(a, `no Node pinned for ${t}`).toBeDefined();
      expect(a!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a!.url).toContain(`v${NODE_VERSION}`);
    }
    expect(nodeTarget("linux", "x64", true)).toBe("linux-x64-musl");
    expect(nodeTarget("darwin", "arm64", true)).toBe("darwin-arm64");
  });

  test("a Node 20+ on PATH is used; the toolchain's own shim, an old Node, or Bun answering as node are not", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-node-runtime-"));
    try {
      const shims = join(dir, "toolchain-bin"); fakeNode(shims, "v22.0.0");
      const old = join(dir, "old"); fakeNode(old, "v18.19.0");
      const bun = join(dir, "bun"); fakeNode(bun, "v1.3.14-bun");
      const real = join(dir, "real"); const realNode = fakeNode(real, "v22.23.2");
      expect(systemNode([shims, real].join(":"), [shims])).toBe(realNode);
      expect(systemNode([shims].join(":"), [shims])).toBeNull();
      expect(systemNode(old)).toBeNull();
      expect(systemNode(bun)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("without one, the pinned archive is downloaded once and verified; a wrong checksum installs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-node-runtime-"));
    try {
      // an archive shaped like Node's: one top directory holding bin/node
      const src = join(dir, "src", `node-v${NODE_VERSION}-test`, "bin"); mkdirSync(src, { recursive: true }); writeFileSync(join(src, "node"), "#!/bin/sh\necho v22.23.2\n");
      const tgz = join(dir, "node.tar.gz");
      expect(Bun.spawnSync(["tar", "-czf", tgz, "-C", join(dir, "src"), `node-v${NODE_VERSION}-test`]).exitCode).toBe(0);
      const bytes = readFileSync(tgz); const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      let downloads = 0;
      const fetchImpl = (async () => { downloads++; return new Response(bytes); }) as unknown as typeof fetch;
      const common = { cacheBase: join(dir, "cache"), target: "test-x64", path: "", env: {}, log: () => undefined, fetchImpl };
      await expect(ensureNode({ ...common, archives: { "test-x64": { url: "https://example.test/node.tar.gz", sha256: "0".repeat(64), bin: "bin/node" } } })).rejects.toThrow(/does not match the checksum/);
      expect(existsSync(join(dir, "cache", "voidbase", "node", `v${NODE_VERSION}-test-x64`))).toBe(false);
      const archives = { "test-x64": { url: "https://example.test/node.tar.gz", sha256, bin: "bin/node" } };
      const bin = await ensureNode({ ...common, archives });
      expect(bin).toBe(join(dir, "cache", "voidbase", "node", `v${NODE_VERSION}-test-x64`, "bin", "node"));
      expect(Bun.spawnSync([bin]).stdout.toString().trim()).toBe("v22.23.2");
      expect(await ensureNode({ ...common, archives })).toBe(bin);
      expect(downloads).toBe(2);
      // VOIDBASE_NODE wins over everything
      expect(await ensureNode({ ...common, archives, env: { VOIDBASE_NODE: bin } })).toBe(bin);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
