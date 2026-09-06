import { expect, test } from "bun:test";
import { archiveSuffix, compareVersions, parseChecksums, sha256 } from "../../src/node/update";

test("archive suffix follows PocketBase's naming for the platforms Bun builds", () => {
  expect(archiveSuffix("linux", "x64")).toBe("_linux_amd64.zip");
  expect(archiveSuffix("linux", "arm64")).toBe("_linux_arm64.zip");
  expect(archiveSuffix("darwin", "arm64")).toBe("_darwin_arm64.zip");
  expect(archiveSuffix("win32", "x64")).toBe("_windows_amd64.zip");
  expect(archiveSuffix("freebsd", "x64")).toBeNull();
  expect(archiveSuffix("linux", "ia32")).toBeNull();
});

test("version comparison handles v prefixes, missing parts and pre-releases", () => {
  expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
  expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
});

test("checksums.txt parses goreleaser's format", async () => {
  const sum = await sha256(new TextEncoder().encode("hello"));
  expect(sum).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  const parsed = parseChecksums(`${sum}  voidbase_0.1.0_linux_amd64.zip\nnot a line\n${"a".repeat(64)} *voidbase_0.1.0_windows_amd64.zip\n`);
  expect(parsed.get("voidbase_0.1.0_linux_amd64.zip")).toBe(sum);
  expect(parsed.get("voidbase_0.1.0_windows_amd64.zip")).toBe("a".repeat(64));
  expect(parsed.size).toBe(2);
});
