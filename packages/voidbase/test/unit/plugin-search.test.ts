// Finding a plugin in the marketplace: the ones that match, whether each is official or community, and the commit
// that was approved -- read from an index as a marketplace serves it, with no network.
import { expect, test } from "bun:test";
import { searchPlugins, standingOf } from "../../src/node/plugin-search";

// a valid index, shaped like the one marketplace.voidbase.cloud serves: fetchIndex refuses anything else
const version = (name: string, v: string, tier: string, provides: string[], repository: string, commit: string) => ({
  version: v,
  manifest: { name, version: v, tier, voidbase: ">=0.9.0-beta.1", provides, collections: [] },
  integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  bundle: `plugins/${name}/${v}/bundle.js`,
  bytes: 10,
  source: { repository, commit },
  publishedOn: "2026-09-13T00:00:00Z",
  audit: { ranOn: "2026-09-13T00:00:00Z", checks: [] },
});
const index = {
  schemaVersion: 1,
  marketplace: { name: "test", url: "https://market.test" },
  generatedOn: "2026-09-13T00:00:00Z",
  plugins: [
    { kind: "plugin", name: "backups", repository: "voidbase-cloud/voidbase-plugin-backups", title: "Backups", summary: "Scheduled backups to R2", latest: "0.2.0",
      versions: [
        version("backups", "0.1.0", "official", ["backups@1"], "voidbase-cloud/voidbase-plugin-backups", "1111111111111111111111111111111111111111"),
        version("backups", "0.2.0", "official", ["backups@1"], "voidbase-cloud/voidbase-plugin-backups", "2222222222222222222222222222222222222222"),
      ] },
    { kind: "plugin", name: "offsite-copy", repository: "someone/offsite-copy", title: "Off-site copy", summary: "Copies every backup elsewhere", latest: "1.0.0",
      versions: [version("offsite-copy", "1.0.0", "community", [], "someone/offsite-copy", "3333333333333333333333333333333333333333")] },
    { kind: "plugin", name: "hardening", repository: "voidbase-cloud/voidbase-plugin-hardening", title: "Hardening", summary: "Security headers", latest: "0.1.0",
      versions: [version("hardening", "0.1.0", "official", ["hardening@1"], "voidbase-cloud/voidbase-plugin-hardening", "4444444444444444444444444444444444444444")] },
  ],
  templates: [],
  themes: [],
};
const fakeFetch = (async () => new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("searching for backup finds the plugins that match, and only those", async () => {
  const { plugins, problems } = await searchPlugins("backup", ["https://market.test"], fakeFetch);
  expect(problems).toEqual([]);
  expect(plugins.map((p) => p.name).sort()).toEqual(["backups", "offsite-copy"]);
});

test("each one says whether it is official or community, and names the approved commit of its latest version", async () => {
  const { plugins } = await searchPlugins("backup", ["https://market.test"], fakeFetch);
  const backups = plugins.find((p) => p.name === "backups")!;
  expect(backups.standing).toBe("official");
  expect(backups.version).toBe("0.2.0");
  expect(backups.commit).toBe("2222222222222222222222222222222222222222");
  expect(plugins.find((p) => p.name === "offsite-copy")!.standing).toBe("community");
});

test("a capability it provides matches too, and an empty query lists everything", async () => {
  expect((await searchPlugins("hardening@1", ["https://market.test"], fakeFetch)).plugins.map((p) => p.name)).toEqual(["hardening"]);
  expect((await searchPlugins("", ["https://market.test"], fakeFetch)).plugins.length).toBe(3);
});

test("core and official are ours; anything else is community", () => {
  expect([standingOf("core"), standingOf("official"), standingOf("community"), standingOf(undefined)]).toEqual(["official", "official", "community", "community"]);
});
