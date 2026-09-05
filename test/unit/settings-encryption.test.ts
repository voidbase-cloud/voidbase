import { expect, test } from "bun:test";
import { decryptSettings, encryptSettings } from "../../src/server/settings";
test("settings round-trip through AES-GCM with a 32-char key", async () => {
  const key = "0123456789abcdef0123456789abcdef";
  const json = JSON.stringify({ smtp: { password: "s3cret" } });
  const sealed = await encryptSettings(json, key);
  expect(sealed.startsWith("{")).toBe(false);
  expect(await decryptSettings(sealed, key)).toBe(json);
  expect((await encryptSettings(json, key)) === sealed).toBe(false); // fresh nonce every time
  await expect(decryptSettings(sealed, "ffffffffffffffffffffffffffffffff")).rejects.toThrow();
});
