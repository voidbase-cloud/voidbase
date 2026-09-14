// A deploy that went live reports success. At the Workers Free limit of five cron triggers `void deploy` exits 1 after
// the upload, with the instance up and answering; the deploy now asks whether that happened before it fails.
import { describe, expect, test } from "bun:test";
import { deployWentLive, waitForHealth } from "../../src/node/deploy-cf";

describe("whether a failed deploy went live anyway", () => {
  const startedAt = Date.parse("2026-09-13T02:00:00Z");
  test("written by this deploy and answering: live, so the deploy succeeds", () => {
    expect(deployWentLive({ startedAt, modifiedOn: "2026-09-13T02:00:40Z", health: 200 })).toBe(true);
  });
  test("a minute of clock skew is allowed", () => {
    expect(deployWentLive({ startedAt, modifiedOn: "2026-09-13T01:59:30Z", health: 200 })).toBe(true);
  });
  test("still the previous version, which answers too: not this deploy, so it fails", () => {
    expect(deployWentLive({ startedAt, modifiedOn: "2026-09-12T18:00:00Z", health: 200 })).toBe(false);
  });
  test("written but not answering: it fails", () => {
    expect(deployWentLive({ startedAt, modifiedOn: "2026-09-13T02:00:40Z", health: 0 })).toBe(false);
    expect(deployWentLive({ startedAt, modifiedOn: "2026-09-13T02:00:40Z", health: 500 })).toBe(false);
  });
  test("no Worker found, or no time on it: it fails", () => {
    expect(deployWentLive({ startedAt, modifiedOn: undefined, health: 200 })).toBe(false);
    expect(deployWentLive({ startedAt, modifiedOn: "not a date", health: 200 })).toBe(false);
  });
});

describe("a freshly uploaded Worker gets time to answer", () => {
  const answers = (statuses: (number | "down")[]) => {
    let calls = 0;
    const fetchImpl = (async () => { const s = statuses[Math.min(calls++, statuses.length - 1)]; if (s === "down") throw new Error("connection refused"); return new Response("", { status: s }); }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  };
  test("not answering yet, then answering: the wait ends at the first 200", async () => {
    const a = answers(["down", 503, 200]);
    expect(await waitForHealth("https://shop.acct.workers.dev", 5_000, 10, a.fetchImpl)).toBe(200);
    expect(a.calls()).toBe(3);
  });
  test("never answering: the last status once the budget is spent, so the deploy still fails", async () => {
    const a = answers([503]);
    expect(await waitForHealth("https://shop.acct.workers.dev", 60, 10, a.fetchImpl)).toBe(503);
    expect(a.calls()).toBeGreaterThan(1);
  });
});

