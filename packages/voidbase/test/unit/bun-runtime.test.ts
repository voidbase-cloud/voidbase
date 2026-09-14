// The plain Bun `voidbase build --compile` compiles onto from the prebuilt executable (src/node/bun-runtime.ts):
// VOIDBASE_BUN, a `bun` of the same version on PATH outside the toolchain's directories, or that release, downloaded
// once and refused when it does not match the release's checksum.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { bunAsset, ensureBun, systemBun } from "../../src/node/bun-runtime";

const fakeBun = (dir: string, answer: string) => { mkdirSync(dir, { recursive: true }); const f = join(dir, "bun"); writeFileSync(f, `#!/bin/sh\necho ${answer}\n`); chmodSync(f, 0o755); return f; };

describe("the Bun a project is compiled onto from the executable", () => {
  test("release asset names follow Bun's: aarch64 for arm64, windows for win32, -musl on a musl Linux", () => {
    expect(bunAsset("linux", "x64", false)).toBe("bun-linux-x64");
    expect(bunAsset("linux", "arm64", true)).toBe("bun-linux-aarch64-musl");
    expect(bunAsset("darwin", "arm64", true)).toBe("bun-darwin-aarch64");
    expect(bunAsset("darwin", "x64", false)).toBe("bun-darwin-x64");
    expect(bunAsset("win32", "x64", false)).toBe("bun-windows-x64");
  });

  test("a bun of this version on PATH is used; another version, or the toolchain's own bun, is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-bun-runtime-"));
    try {
      const toolchain = join(dir, "cache", "voidbase", "toolchain", "1.0.0-linux-x64", "bin"); fakeBun(toolchain, "1.3.14");
      const older = join(dir, "older"); fakeBun(older, "1.2.0");
      const real = join(dir, "real"); const realBun = fakeBun(real, "1.3.14");
      expect(systemBun([toolchain, real].join(":"), "1.3.14")).toBe(realBun);
      expect(systemBun(toolchain, "1.3.14")).toBeNull();
      expect(systemBun(older, "1.3.14")).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("without one, the release is downloaded once and checked against SHASUMS256.txt; a mismatch installs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-bun-runtime-"));
    try {
      const zip = zipSync({ "bun-linux-x64/bun": new TextEncoder().encode("#!/bin/sh\necho 1.3.14\n") });
      const sha = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
      let sums = `${sha}  bun-linux-x64.zip\n${"0".repeat(64)}  bun-darwin-x64.zip\n`;
      let downloads = 0;
      const fetchImpl = (async (url: string) => {
        if (url.endsWith("/SHASUMS256.txt")) return new Response(sums);
        if (url.endsWith("/bun-linux-x64.zip")) { downloads++; return new Response(zip); }
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      const common = { version: "1.3.14", asset: "bun-linux-x64", cacheBase: join(dir, "cache"), path: "", env: {}, log: () => undefined, fetchImpl };
      const bin = await ensureBun(common);
      expect(bin).toBe(join(dir, "cache", "voidbase", "bun", "v1.3.14-bun-linux-x64", "bun"));
      expect(Bun.spawnSync([bin]).stdout.toString().trim()).toBe("1.3.14");
      expect(await ensureBun(common)).toBe(bin);
      expect(downloads).toBe(1);
      // a release whose checksum does not match is refused and leaves nothing behind
      sums = `${"f".repeat(64)}  bun-linux-x64.zip\n`;
      const other = { ...common, cacheBase: join(dir, "other-cache") };
      await expect(ensureBun(other)).rejects.toThrow(/does not match its checksum/);
      expect(existsSync(join(dir, "other-cache", "voidbase", "bun", "v1.3.14-bun-linux-x64"))).toBe(false);
      // VOIDBASE_BUN wins over everything
      expect(await ensureBun({ ...common, env: { VOIDBASE_BUN: bin } })).toBe(bin);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
