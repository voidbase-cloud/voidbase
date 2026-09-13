// Auto-merge (src/server/auto-merge.ts): where a side-loaded file changed from the panel goes. The instance's own
// files when it holds them, a commit when it is connected to git with auto-merge on, and a refusal otherwise that
// names what to set; and a binary asset committed as the bytes it is.
import { expect, test } from "bun:test";
import { autoMergeOn, sideLoadedChange } from "../../src/server/auto-merge";
import { commitFiles } from "../../src/server/project-sync";
import type { Bindings } from "../../src/server/types";

const env = (vars: Record<string, string>) => vars as unknown as Bindings;
const connected = { VOIDBASE_PROJECT_REPO: "me/app", VOIDBASE_GH_TOKEN: "t" };

test("a change goes to the instance's files, to a commit, or is refused naming what to set", () => {
  expect(autoMergeOn({})).toBe(false);
  expect(sideLoadedChange(env({}), true)).toEqual({ to: "instance" });
  expect(sideLoadedChange(env({ ...connected, VOIDBASE_AUTO_MERGE: "on" }), false)).toMatchObject({ to: "repository", repo: { fullName: "me/app", branch: "master" } });

  const off = sideLoadedChange(env(connected), false);
  expect(off.to).toBe("refused");
  expect((off as { message: string }).message).toContain("connected to me/app with auto-merge off");
  expect((off as { message: string }).message).toContain("VOIDBASE_AUTO_MERGE=on");

  const nowhere = sideLoadedChange(env({ VOIDBASE_AUTO_MERGE: "on" }), false);
  expect(nowhere.to).toBe("refused");
  for (const name of ["VOIDBASE_PROJECT_REPO", "VOIDBASE_GH_TOKEN", "VOIDBASE_AUTO_MERGE=on"]) expect((nowhere as { message: string }).message).toContain(name);
});

test("a binary asset is committed as its bytes, a text file as its text", async () => {
  const blobs: Record<string, unknown>[] = []; let tree: unknown = null;
  const github = Bun.serve({ port: 0, fetch: async (req) => {
    const path = new URL(req.url).pathname; const body = req.method === "GET" ? null : ((await req.json()) as Record<string, unknown>);
    if (path.endsWith("/git/ref/heads/master")) return Response.json({ object: { sha: "head1" } });
    if (path.endsWith("/git/commits/head1")) return Response.json({ tree: { sha: "tree1" } });
    if (path.endsWith("/git/blobs")) { blobs.push(body!); return Response.json({ sha: `blob${blobs.length}` }); }
    if (path.endsWith("/git/trees")) { tree = body; return Response.json({ sha: "tree2" }); }
    if (path.endsWith("/git/commits")) return Response.json({ sha: "commit2" });
    return Response.json({});
  } });
  try {
    const repo = { fullName: "me/app", token: "t", branch: "master", api: `http://127.0.0.1:${github.port}` };
    const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const c = await commitFiles(repo, [{ path: "pb_public/logo.png", content: logo }, { path: "pb_public/index.html", content: "<h1>hi</h1>" }], "chore(pb_public): from the admin panel");
    expect(c).toEqual({ sha: "commit2", url: "https://github.com/me/app/commit/commit2", branch: "master" });
    expect(blobs).toEqual([{ content: Buffer.from(logo).toString("base64"), encoding: "base64" }, { content: "<h1>hi</h1>", encoding: "utf-8" }]);
    expect(tree).toEqual({ base_tree: "tree1", tree: [{ path: "pb_public/logo.png", mode: "100644", type: "blob", sha: "blob1" }, { path: "pb_public/index.html", mode: "100644", type: "blob", sha: "blob2" }] });
  } finally { github.stop(true); }
});
