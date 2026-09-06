import { describe, expect, test } from "bun:test";
import { signJWT, verifyJWT } from "../../src/server/jwt";

describe("jwt", () => {
  test("a signed token verifies; the wrong secret and a changed signature byte do not", async () => {
    const t = await signJWT({ id: "abc", type: "auth" }, "secret", 60);
    expect((await verifyJWT(t, "secret"))?.id).toBe("abc");
    expect(await verifyJWT(t, "other")).toBeNull();
    const [h, b, sig] = t.split(".") as [string, string, string];
    const tampered = `${h}.${b}.${sig.slice(0, 5)}${sig[5] === "A" ? "B" : "A"}${sig.slice(6)}`;
    expect(await verifyJWT(tampered, "secret")).toBeNull();
  });
  test("padding bits of the last signature character do not count, like PocketBase's Go decoder", async () => {
    // base64url of 32 bytes ends in a character with two padding bits; Go's RawURLEncoding (non-strict) ignores them
    // and so does atob, so a token that only differs there is the same signature to both servers
    let sameSeen = false;
    for (let i = 0; i < 64 && !sameSeen; i++) {
      const t = await signJWT({ id: `u${i}`, type: "auth" }, "secret", 60);
      const [h, b, sig] = t.split(".") as [string, string, string];
      if (sig.at(-1) !== "A") continue;
      sameSeen = true;
      expect((await verifyJWT(`${h}.${b}.${sig.slice(0, -1)}B`, "secret"))?.id).toBe(`u${i}`);
    }
    expect(sameSeen).toBe(true);
  });
});
