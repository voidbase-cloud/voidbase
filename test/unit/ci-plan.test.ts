import { describe, expect, test } from "bun:test";
import { AREAS, KEYS, decide, keyHash, selected } from "../../scripts/ci-plan";

const areasWith = (changed: string[] = []) => { const a: Record<string, string> = {}; for (const name of Object.keys(AREAS)) a[name] = changed.includes(name) ? `new-${name}` : `same-${name}`; return a; };
const hashesFor = (areas: Record<string, string>) => { const h: Record<string, string> = {}; for (const [k, d] of Object.entries(KEYS)) h[k] = keyHash(areas, d.inputs); return h; };
const baseline = hashesFor(areasWith());

describe("ci plan", () => {
  test("no previous record: everything runs", () => {
    const d = decide(baseline, null);
    expect(Object.values(d).every((x) => x.run)).toBe(true);
    expect(d["step:suites"]!.reason).toBe("suites selected");
  });
  test("nothing changed: nothing runs, not even the servers", () => {
    const d = decide(baseline, baseline);
    expect(Object.values(d).some((x) => x.run)).toBe(false);
    expect(d["step:boot"]!.reason).toBe("nothing needs the dev server");
  });
  test("one conformance suite edited: that suite on both runtimes plus the servers it needs", () => {
    const d = decide(hashesFor(areasWith(["test:conformance/auth-flows"])), baseline);
    expect(selected(d, "suite:")).toEqual(["auth-flows"]);
    expect(selected(d, "bun:")).toEqual(["auth-flows"]);
    expect(d["step:boot"]!.run && d["step:reference"]!.run && d["step:suites"]!.run && d["step:suites-bun"]!.run).toBe(true);
    expect(d["step:browser"]!.run || d["step:typecheck"]!.run || d["step:fresh-db"]!.run || d["step:starter"]!.run).toBe(false);
  });
  test("a server change reruns every suite and every boot", () => {
    const d = decide(hashesFor(areasWith(["server"])), baseline);
    expect(selected(d, "suite:").length).toBe(24 + 1 + 5);  // conformance, sdk, browser; cloud-rest does not touch the server
    expect(d["step:fresh-db"]!.run && d["step:exe-smoke"]!.run && d["step:browser"]!.run).toBe(true);
  });
  test("the CLI alone: typecheck, unit, deploy dry run, executable, the Bun pass, no Workers suites", () => {
    const d = decide(hashesFor(areasWith(["node"])), baseline);
    expect(d["step:typecheck"]!.run && d["step:unit"]!.run && d["step:deploy-cf"]!.run && d["step:exe-smoke"]!.run).toBe(true);
    expect(selected(d, "suite:")).toEqual(["cloud-rest"]);
    expect(selected(d, "bun:").length).toBe(25);
    expect(d["step:boot"]!.run).toBe(false);
    expect(d["step:reference"]!.run).toBe(true);
  });
  test("a browser suite: Chrome and the dev server, nothing on Bun", () => {
    const d = decide(hashesFor(areasWith(["test:panel-login"])), baseline);
    expect(selected(d, "suite:")).toEqual(["panel-login"]);
    expect(d["step:browser"]!.run && d["step:boot"]!.run).toBe(true);
    expect(selected(d, "bun:")).toEqual([]);
  });
  test("CI_BROWSER=0 drops the browser suites and the starter even when they changed", () => {
    const d = decide(hashesFor(areasWith(["test:panel-smoke", "test:starter-smoke"])), baseline, { browser: false });
    expect(d["suite:panel-smoke"]!.reason).toBe("CI_BROWSER=0");
    expect(d["step:starter"]!.run || d["step:browser"]!.run).toBe(false);
  });
  test("a key the record never verified runs", () => {
    const prev = { ...baseline }; delete prev["suite:thumbs"];
    const d = decide(baseline, prev);
    expect(selected(d, "suite:")).toEqual(["thumbs"]);
    expect(d["suite:thumbs"]!.reason).toBe("never verified");
  });
  test("full run ignores the record", () => {
    const d = decide(baseline, baseline, { full: true });
    expect(Object.values(d).every((x) => x.run)).toBe(true);
  });
});
