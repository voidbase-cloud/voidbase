// `voidbase init --template` against a fake GitHub and a fake marketplace: the fetch is a function here, so nothing
// leaves the machine, and the one tarball is built by the same tar that unpacks it.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBranch, fetchTemplate, isEmpty, listTemplates, nextSteps, parseRepository, resolveTemplate, tarMissing } from "../../src/node/template";

const MARKET = "https://market.example";
const index = {
  schemaVersion: 1,
  marketplace: { name: "fake", url: MARKET },
  generatedOn: "2026-09-11",
  plugins: [],
  templates: [
    { name: "blank", repository: "example/voidbase-template-blank", title: "Blank", summary: "An empty project." },
    { repository: "someone/blog-starter", title: "Blog with comments", summary: "A blog." },
  ],
};

/** a fetch that answers from a table of URLs and records what was asked */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch & { asked: string[] } {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    asked.push(url);
    return routes[url]?.() ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch & { asked: string[] };
  f.asked = asked;
  return f;
}
const json = (body: unknown) => () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const INDEX_URL = `${MARKET}/registry/v1/index.json`;

test("a template is owner/name, or a GitHub URL; a bare word is a name to look up", () => {
  expect(parseRepository("voidbase-cloud/voidbase-site")).toBe("voidbase-cloud/voidbase-site");
  expect(parseRepository("https://github.com/voidbase-cloud/voidbase-site.git")).toBe("voidbase-cloud/voidbase-site");
  expect(parseRepository("blank")).toBeNull();
  expect(parseRepository("owner/name/extra")).toBeNull();
  expect(parseRepository("")).toBeNull();
});

test("the listing comes from the index: name, title, summary, repository, and the name falls back to the repository's", async () => {
  const fetchImpl = fakeFetch({ [INDEX_URL]: json(index) });
  const { templates, problems } = await listTemplates([MARKET], fetchImpl);
  expect(problems).toEqual([]);
  expect(templates).toEqual([
    { name: "blank", repository: "example/voidbase-template-blank", title: "Blank", summary: "An empty project.", marketplace: MARKET },
    { name: "blog-starter", repository: "someone/blog-starter", title: "Blog with comments", summary: "A blog.", marketplace: MARKET },
  ]);
  // a marketplace that cannot be read is reported beside the ones that could
  const two = await listTemplates([MARKET, "https://down.example"], fetchImpl);
  expect(two.templates.length).toBe(2);
  expect(two.problems).toEqual(["https://down.example/registry/v1/index.json answered 404"]);
});

test("a listed name resolves through the index and owner/name never asks it", async () => {
  const fetchImpl = fakeFetch({ [INDEX_URL]: json(index) });
  const blank = await resolveTemplate("blank", [MARKET], fetchImpl);
  expect(blank.repository).toBe("example/voidbase-template-blank");
  expect(blank.listed?.marketplace).toBe(MARKET);
  // by title too, and case does not matter: nobody types a listing's capitalisation back exactly
  expect((await resolveTemplate("BLOG WITH COMMENTS", [MARKET], fetchImpl)).repository).toBe("someone/blog-starter");
  expect(fetchImpl.asked.filter((u) => u === INDEX_URL).length).toBe(2);
  const direct = await resolveTemplate("other/thing", [MARKET], fetchImpl);
  expect(direct).toEqual({ repository: "other/thing" });
  expect(fetchImpl.asked.length).toBe(2);
  // a name nobody listed says what is listed instead of failing blankly
  await expect(resolveTemplate("nothing", [MARKET], fetchImpl)).rejects.toThrow(/no template called "nothing".*blank, blog-starter/s);
});

test("the default branch comes from GitHub's API, and a 404 is named as private or missing", async () => {
  const fetchImpl = fakeFetch({ "https://api.github.com/repos/example/thing": json({ default_branch: "trunk" }) });
  expect(await defaultBranch("example/thing", fetchImpl)).toBe("trunk");
  await expect(defaultBranch("example/secret", fetchImpl)).rejects.toThrow(/private, or it does not exist/);
});

test("an existing directory that is not empty is refused before anything is downloaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-tpl-"));
  try {
    expect(isEmpty(dir)).toBe(true);
    expect(isEmpty(join(dir, "absent"))).toBe(true);
    writeFileSync(join(dir, "README.md"), "mine");
    expect(isEmpty(dir)).toBe(false);
    const fetchImpl = fakeFetch({});
    await expect(fetchTemplate("example/thing", dir, { ref: "main", marketplaces: [MARKET], fetchImpl })).rejects.toThrow(/is not empty/);
    expect(fetchImpl.asked).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the next steps are read from the template's own files", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-next-"));
  try {
    expect(nextSteps(dir)).toEqual(["read its README"]);
    mkdirSync(join(dir, "pb_hooks"));
    expect(nextSteps(dir)).toEqual(["voidbase serve"]);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vp dev" } }));
    expect(nextSteps(dir)).toEqual(["bun install", "bun run dev", "voidbase serve"]);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vp build" } }));
    expect(nextSteps(dir)).toEqual(["bun install", "voidbase serve"]);
    writeFileSync(join(dir, "void.json"), "{}");
    expect(nextSteps(dir)).toEqual(["bun install", "bun run dev", "voidbase serve"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const noTar = tarMissing();
test.skipIf(!!noTar)(noTar ? `a template is unpacked from GitHub's tarball (skipped: ${noTar})` : "a template is unpacked from GitHub's tarball, its top-level directory stripped and any .git removed", async () => {
  const work = mkdtempSync(join(tmpdir(), "vb-tar-"));
  try {
    // a repository the way codeload serves it: everything under "<name>-<ref>/"
    const src = join(work, "thing-trunk");
    mkdirSync(join(src, "pb_hooks"), { recursive: true });
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git", "HEAD"), "ref: refs/heads/trunk");
    writeFileSync(join(src, "pb_hooks", "main.pb.js"), "// hook");
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "thing", scripts: { dev: "vp dev" } }));
    const tgz = join(work, "thing.tar.gz");
    const tar = Bun.spawnSync(["tar", "-czf", tgz, "-C", work, "thing-trunk"]);
    expect(tar.exitCode).toBe(0);
    const bytes = readFileSync(tgz);
    const fetchImpl = fakeFetch({
      [INDEX_URL]: json(index),
      "https://api.github.com/repos/example/thing": json({ default_branch: "trunk" }),
      "https://codeload.github.com/example/thing/tar.gz/trunk": () => new Response(bytes),
    });
    const dir = join(work, "out");
    const r = await fetchTemplate("example/thing", dir, { marketplaces: [MARKET], fetchImpl });
    expect(r.ref).toBe("trunk");
    expect(r.dir).toBe(dir);
    expect(readFileSync(join(dir, "pb_hooks", "main.pb.js"), "utf8")).toBe("// hook");
    expect(isEmpty(join(dir, "thing-trunk"))).toBe(true); // the wrapper directory is gone
    expect(isEmpty(join(dir, ".git"))).toBe(true);
    expect(r.files).toBe(2);
    expect(r.next).toEqual(["bun install", "bun run dev", "voidbase serve"]);
    // the tarball at an explicit --ref is asked for directly, without the API
    const again = fakeFetch({ "https://codeload.github.com/example/thing/tar.gz/trunk": () => new Response(bytes) });
    const r2 = await fetchTemplate("example/thing", join(work, "out2"), { ref: "trunk", marketplaces: [MARKET], fetchImpl: again });
    expect(again.asked).toEqual(["https://codeload.github.com/example/thing/tar.gz/trunk"]);
    expect(r2.files).toBe(2);
    // and a 404 on the tarball is named, whether the ref or the repository is what is missing
    const gone = fakeFetch({});
    await expect(fetchTemplate("example/thing", join(work, "out3"), { ref: "nope", marketplaces: [MARKET], fetchImpl: gone })).rejects.toThrow(/no nope in example\/thing, or the repository is private or missing/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
