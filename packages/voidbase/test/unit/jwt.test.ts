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
    // base64url of a 32-byte HMAC ends in a character carrying 4 signature bits and 2 padding bits. Go's
    // RawURLEncoding (non-strict) ignores those two, and so does atob, so a token that differs only there is the
    // same signature to both servers. Flipping the low padding bit keeps the four that matter.
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const t = await signJWT({ id: "u1", type: "auth" }, "secret", 60);
    const [h, b, sig] = t.split(".") as [string, string, string];
    const last = B64.indexOf(sig.at(-1)!);
    expect(last).toBeGreaterThanOrEqual(0);
    const repadded = `${h}.${b}.${sig.slice(0, -1)}${B64[last ^ 1]}`;
    expect(repadded).not.toBe(t);
    expect((await verifyJWT(repadded, "secret"))?.id).toBe("u1");
  });
});
