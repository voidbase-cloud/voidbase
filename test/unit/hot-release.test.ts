// Hot mode's version bump: the prerelease counter moves, nothing else.
import { describe, expect, test } from "bun:test";
import { nextPrerelease } from "../../scripts/hot-release";

describe("the hot release bump", () => {
  test("moves the prerelease number", () => {
    expect(nextPrerelease("0.9.0-beta.24")).toBe("0.9.0-beta.25");
    expect(nextPrerelease("1.2.3-rc.9")).toBe("1.2.3-rc.10");
  });
  test("refuses a version that is not a prerelease", () => {
    expect(() => nextPrerelease("1.0.0")).toThrow(/prerelease/);
  });
});
