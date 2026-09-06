import { describe, expect, test } from "bun:test";
import { BROWSER, CONFORMANCE, KEYS, KEY_META, Tree, decide, keyFiles, parseCommits, selected } from "../../scripts/ci-plan";

const same: Record<string, string> = Object.fromEntries(KEYS.map((k) => [k, `h-${k}`]));
const changed = (...keys: string[]) => ({ ...same, ...Object.fromEntries(keys.map((k) => [k, `new-${k}`])) });

describe("ci plan: what runs", () => {
  test("no previous record: everything runs", () => {
    const d = decide(same, null);
    expect(KEYS.every((k) => d[k]!.run)).toBe(true);
  });
  test("nothing changed: nothing runs, no servers, no oracles", () => {
    const d = decide(same, same);
    expect(Object.values(d).some((x) => x.run)).toBe(false);
    expect(d["step:oracles"]!.reason).toBe("nothing needs the oracles");
  });
  test("one suite's inputs changed: that suite on both runtimes with the servers it needs", () => {
    const d = decide(changed("suite:auth-flows", "bun:auth-flows"), same);
    expect(selected(d, "suite:")).toEqual(["auth-flows"]);
    expect(selected(d, "bun:")).toEqual(["auth-flows"]);
    expect(d["step:boot"]!.run && d["step:reference"]!.run && d["step:oracles"]!.run).toBe(true);
    expect(d["step:browser"]!.run || d["step:typecheck"]!.run).toBe(false);
  });
  test("CI_BROWSER=0 drops the browser suites and the starter", () => {
    const d = decide(changed("suite:panel-smoke", "step:starter"), same, { browser: false });
    expect(d["suite:panel-smoke"]!.reason).toBe("CI_BROWSER=0");
    expect(d["step:starter"]!.run || d["step:browser"]!.run).toBe(false);
  });
  test("a key the record never verified runs", () => {
    const prev = { ...same }; delete prev["suite:thumbs"];
    expect(decide(same, prev)["suite:thumbs"]!.reason).toBe("never verified");
  });
  test("Tests: all in a commit forces a full run", () => {
    const d = decide(same, same, { signals: { scopes: [], tests: [], full: true, changed: [] } });
    expect(KEYS.every((k) => d[k]!.run)).toBe(true);
  });
});

describe("ci plan: hot mode", () => {
  const all = Object.fromEntries(KEYS.map((k) => [k, `new-${k}`]));
  test("typecheck and unit always, the Bun pass, browser suites and starter deferred, the rest within the budget", () => {
    const d = decide(all, same, { hot: true, budget: 60 });
    expect(d["step:typecheck"]!.run && d["step:unit"]!.run).toBe(true);
    expect(selected(d, "bun:")).toEqual([]);
    expect(BROWSER.every((p) => !d[`suite:${p}`]!.run) && !d["step:starter"]!.run).toBe(true);
    const spent = KEYS.filter((k) => d[k]!.run).reduce((a, k) => a + KEY_META[k]!.seconds, 0);
    expect(spent).toBeLessThanOrEqual(60);
    expect(selected(d, "suite:").length).toBeGreaterThan(5);
    expect(d["suite:hardening"]!.reason).toBe("deferred (hot mode, budget 60s)");
  });
  test("the commits' scopes go first, a Tests: trailer and a changed test file are never deferred", () => {
    const d = decide(all, same, { hot: true, budget: 30, signals: { scopes: ["auth"], tests: ["hardening"], full: false, changed: ["test/conformance/thumbs.ts"] } });
    expect(d["suite:auth-flows"]!.reason).toBe("hot mode: scope auth");
    expect(d["suite:otp-mfa"]!.run).toBe(true);
    expect(d["suite:hardening"]!.reason).toBe("hot mode: named by the commits");
    expect(d["suite:thumbs"]!.reason).toBe("hot mode: its test changed");
    expect(d["suite:filter-corpus"]!.run).toBe(false);
  });
  test("recorded durations replace the defaults", () => {
    const d = decide(all, same, { hot: true, budget: 20, seconds: { "suite:hardening": 1, "suite:batch": 100 } });
    expect(d["suite:hardening"]!.run).toBe(true);
    expect(d["suite:batch"]!.run).toBe(false);
  });
  test("Tests: bun brings the Bun pass back", () => {
    const d = decide(all, same, { hot: true, budget: 10, signals: { scopes: [], tests: ["bun"], full: false, changed: [] } });
    expect(selected(d, "bun:").length).toBe(CONFORMANCE.length + 1);
  });
});

describe("ci plan: commits", () => {
  test("scopes and Tests: trailers are read from the messages", () => {
    const s = parseCommits(["feat(records, auth): a thing\n\nbody\n\nTests: thumbs s3", "fix(mail)!: other\n\ntests: all"]);
    expect(s.scopes).toEqual(["records", "auth", "mail"]);
    expect(s.tests).toEqual(["thumbs", "s3"]);
    expect(s.full).toBe(true);
  });
});

describe("ci plan: the import graph of this repository", () => {
  const files = keyFiles(new Tree());
  const keysWith = (f: string) => KEYS.filter((k) => files[k]!.has(f));
  test("the deploy code reaches the CLI checks, not the Bun pass or the Workers suites", () => {
    const k = keysWith("src/node/deploy-cf.ts");
    expect(k).toContain("step:deploy-cf"); expect(k).toContain("step:exe-smoke"); expect(k).toContain("step:typecheck");
    expect(k.some((x) => x.startsWith("bun:"))).toBe(false);
    expect(k.some((x) => x.startsWith("suite:") && x !== "suite:cloud-rest")).toBe(false);
  });
  test("the server reaches every suite on both runtimes and the boots", () => {
    const k = keysWith("src/server/app.ts");
    expect(CONFORMANCE.every((s) => k.includes(`suite:${s}`) && k.includes(`bun:${s}`))).toBe(true);
    expect(k).toContain("step:fresh-db"); expect(k).toContain("step:mail-http"); expect(k).toContain("suite:panel-smoke");
  });
  test("the Bun runtime reaches the Bun pass only", () => {
    const k = keysWith("src/node/serve.ts");
    expect(k.some((x) => x.startsWith("bun:"))).toBe(true);
    expect(k.some((x) => x.startsWith("suite:") && x !== "suite:cloud-rest")).toBe(false);
  });
  test("platform flavours: the Workers flavour reaches the Workers suites, the Bun flavour the Bun pass", () => {
    expect(keysWith("src/platform/workers/env.ts").some((x) => x.startsWith("bun:"))).toBe(false);
    expect(keysWith("src/platform/node/env.ts").some((x) => x.startsWith("suite:") && x !== "suite:cloud-rest")).toBe(false);
  });
  test("a suite's own file reaches that suite only", () => {
    expect(keysWith("test/conformance/thumbs.ts").sort()).toEqual(["bun:thumbs", "suite:thumbs"]);
  });
});
