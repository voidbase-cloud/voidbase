// pb_public on a vanilla instance on Cloudflare (src/server/public-r2.ts): an upload kept in the instance's bucket with an
// index, served at its path straight away, and anything nobody uploaded left to the assets the Worker was deployed with.
import { expect, test } from "bun:test";
import { publicObjectKey, r2PublicFiles, servePublic } from "../../src/server/public-r2";

function bucket() {
  const objects = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  return {
    objects,
    async put(key: string, value: string | Uint8Array) { objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value.slice()); return {}; },
    async get(key: string) { const v = objects.get(key); return v ? { body: new Blob([v as BlobPart]).stream(), text: async () => dec.decode(v) } : null; },
  } as unknown as R2Bucket & { objects: Map<string, Uint8Array> };
}
const req = (path: string, method = "GET") => new Request(`https://shop.example.workers.dev${path}`, { method });

test("an upload is listed, and served at its path with its content type, a directory meaning its index.html", async () => {
  const b = bucket(); const files = r2PublicFiles(b);
  await files.write("index.html", new TextEncoder().encode("<h1>my password manager</h1>"));
  await files.write("img/logo.png", new Uint8Array([137, 80, 78, 71]));
  expect(await files.list()).toEqual([{ path: "img/logo.png", size: 4 }, { path: "index.html", size: 28 }]);
  const home = await servePublic(b, req("/"));
  expect(home?.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await home?.text()).toBe("<h1>my password manager</h1>");
  const logo = await servePublic(b, req("/img/logo.png"));
  expect(logo?.headers.get("content-type")).toBe("image/png");
  const head = await servePublic(b, req("/index.html", "HEAD"));
  expect(head?.status).toBe(200);
  expect(await head?.text()).toBe("");
});

test("a path nobody uploaded, the API, the panel and anything but a read are left to the rest of the instance", async () => {
  const b = bucket(); await r2PublicFiles(b).write("index.html", new TextEncoder().encode("x"));
  for (const r of [req("/nope.html"), req("/api/health"), req("/_/"), req("/__void/ready"), req("/index.html", "POST"), req("/..%2F..%2Fsecrets")]) expect(await servePublic(b, r)).toBeNull();
});

test("an upload named with three dots is kept under a key the bucket's REST API can delete", async () => {
  const b = bucket(); await r2PublicFiles(b).write("a...b.txt", new TextEncoder().encode("x"));
  expect(publicObjectKey("a...b.txt")).not.toContain("..");
  expect([...b.objects.keys()].every((k) => !k.includes(".."))).toBe(true);
  expect(await (await servePublic(b, req("/a...b.txt")))?.text()).toBe("x");
});
