import { describe, expect, test } from "bun:test";
import { isCanonicalB64url, signJWT, verifyJWT } from "../../src/server/jwt";

describe("jwt", () => {
  test("a signed token verifies", async () => {
    const t = await signJWT({ id: "abc", type: "auth" }, "secret", 60);
    expect((await verifyJWT(t, "secret"))?.id).toBe("abc");
    expect(await verifyJWT(t, "other")).toBeNull();
  });
  test("a flipped padding bit in the signature is rejected even though it decodes to the same bytes (Go rejects it)", async () => {
    for (let i = 0; i < 40; i++) {  // enough tokens to hit signatures whose last character carries padding bits
      const t = await signJWT({ id: `u${i}`, type: "auth" }, "secret", 60);
      const [h, b, sig] = t.split(".") as [string, string, string];
      const last = sig.at(-1)!; const flipped = last === "A" ? "B" : "A";
      const tampered = `${h}.${b}.${sig.slice(0, -1)}${flipped}`;
      expect(await verifyJWT(tampered, "secret")).toBeNull();
    }
  });
  test("padding characters and non-canonical segments are rejected", async () => {
    const t = await signJWT({ id: "abc", type: "auth" }, "secret", 60);
    const [h, b, sig] = t.split(".") as [string, string, string];
    expect(await verifyJWT(`${h}.${b}.${sig}=`, "secret")).toBeNull();
    expect(isCanonicalB64url("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB")).toBe(false);
    expect(isCanonicalB64url("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    expect(isCanonicalB64url(sig)).toBe(true);
  });
});
