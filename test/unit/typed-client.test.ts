// `voidbase types`: the typed client generated from a superuser's OpenAPI document. The document comes from
// buildDocument over fake collections that cover every field type; the generated file is checked as text, then
// written to a temporary directory and compiled by tsc under strict, alone and beside a file that applies it to the
// real PocketBase SDK (a devDependency here), so the cast and the narrowing are proven, not described.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkDocument, collectionsOf, fetchDocument, generateTypes, pascal, readDocument, type OpenApiDocument } from "../../src/node/typed-client";
import type { Collection } from "../../src/server/collections/model";
import { buildDocument } from "../../src/server/plugins/openapi";

const ROOT = resolve(import.meta.dir, "../..");
const f = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f_${name}`, name, type, system: false, hidden: false, presentable: false, required: false, help: "", ...extra });
const collection = (name: string, type: Collection["type"], fields: Record<string, unknown>[], system = false): Collection =>
  ({ id: `c_${name}`, name, type, system, fields: fields as Collection["fields"], indexes: [], options: {}, created: "", updated: "", listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "" }) as Collection;
const AUTH_FIELDS = [
  f("password", "password", { system: true, hidden: true, required: true }), f("tokenKey", "text", { system: true, hidden: true, required: true }),
  f("email", "email", { system: true, required: true }), f("emailVisibility", "bool", { system: true }), f("verified", "bool", { system: true }),
];
const COLLECTIONS: Collection[] = [
  collection("_superusers", "auth", [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS, f("created", "autodate", { onCreate: true }), f("updated", "autodate", { onCreate: true, onUpdate: true })], true),
  collection("users", "auth", [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS, f("name", "text"), f("avatar", "file", { maxSelect: 1 })]),
  collection("posts", "base", [
    f("id", "text", { primaryKey: true, system: true }), f("title", "text", { required: true, help: "shown in lists" }), f("body", "editor"), f("views", "number", { onlyInt: true, min: 0 }), f("score", "number"),
    f("published", "bool"), f("contact", "email"), f("site", "url"), f("when", "date"), f("status", "select", { maxSelect: 1, values: ["draft", "live"] }),
    f("tags", "select", { maxSelect: 3, values: ["a", "b", "c"] }), f("meta", "json"), f("cover", "file", { maxSelect: 1 }), f("gallery", "file", { maxSelect: 5 }),
    f("author", "relation", { collectionId: "c_users", maxSelect: 1 }), f("editors", "relation", { collectionId: "c_users", maxSelect: 4 }), f("orphan", "relation", { collectionId: "c_gone", maxSelect: 1 }),
    f("where", "geoPoint"), f("created", "autodate", { onCreate: true }), f("updated", "autodate", { onCreate: true, onUpdate: true }),
  ]),
  collection("blog-comments", "base", [f("id", "text", { primaryKey: true, system: true }), f("post", "relation", { collectionId: "c_posts", maxSelect: 1 }), f("text", "text")]),
  collection("stats", "view", [f("id", "text", { primaryKey: true, system: true }), f("total", "number")]),
];
const document = (caller: Parameters<typeof buildDocument>[0]["caller"] = { kind: "superuser", collection: "_superusers" }) =>
  buildDocument({ collections: COLLECTIONS, caller, title: "Shop", origin: "http://shop.example", version: "0.9.0" }) as OpenApiDocument;
const OPTS = { source: "http://shop.example/api/openapi.json", regenerate: "voidbase types --url http://shop.example --out src/voidbase.ts" };
const generated = () => generateTypes(document(), OPTS);
/** the body of one interface, without its doc comment lines */
const iface = (text: string, name: string) => { const m = text.match(new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`)); expect(m, name).toBeTruthy(); return m![1]!.split("\n").map((l) => l.trim()).filter((l) => !l.startsWith("/**")); };

describe("the generated interfaces", () => {
  test("one per collection, named from the collection, with the record's fixed fields", () => {
    const text = generated();
    expect(collectionsOf(document()).map((c) => c.interfaceName)).toEqual(["SuperusersRecord", "UsersRecord", "PostsRecord", "BlogCommentsRecord", "StatsRecord"]);
    const posts = iface(text, "PostsRecord");
    expect(posts).toContain("id: string;");
    expect(posts).toContain("collectionId: string;");
    expect(posts).toContain('collectionName: "posts";');
    expect(posts).toContain("created: string;");
    expect(posts).toContain("updated: string;");
    // a collection without autodate fields answers created and updated all the same
    expect(iface(text, "StatsRecord")).toContain("created: string;");
    // a hidden field is not in the record
    expect(text).not.toContain("tokenKey");
    expect(iface(text, "UsersRecord")).not.toContain("password: string;");
  });

  test("every field type maps to its TypeScript type", () => {
    const posts = iface(generated(), "PostsRecord");
    expect(posts).toContain("title: string;");
    expect(posts).toContain("body: string;");
    expect(posts).toContain("views: number;");
    expect(posts).toContain("score: number;");
    expect(posts).toContain("published: boolean;");
    expect(posts).toContain("contact: string;");
    expect(posts).toContain("site: string;");
    expect(posts).toContain("when: string;");
    expect(posts).toContain('status: "draft" | "live";');
    expect(posts).toContain('tags: ("a" | "b" | "c")[];');
    expect(posts).toContain("meta: unknown;");
    expect(posts).toContain("cover: string;");
    expect(posts).toContain("gallery: string[];");
    expect(posts).toContain("author: string;");
    expect(posts).toContain("editors: string[];");
    expect(posts).toContain("where: { lon: number; lat: number };");
    const users = iface(generated(), "UsersRecord");
    expect(users).toContain("email: string;");
    expect(users).toContain("verified: boolean;");
    expect(users).toContain("avatar: string;");
  });

  test("a field's help text becomes its doc comment", () => {
    expect(generated()).toMatch(/\/\*\* shown in lists \*\/\n {2}title: string;/);
  });

  test("optional is what the document says: expand is, the answered fields are not", () => {
    const doc = document();
    const posts = doc.components!.schemas!.posts!;
    expect(posts.required).toContain("title");
    expect(posts.required).not.toContain("expand");
    // a document that leaves a field out of required gets a ? for it
    posts.required = posts.required!.filter((n) => n !== "score");
    expect(iface(generateTypes(doc, OPTS), "PostsRecord")).toContain("score?: number;");
  });

  test("expand is typed from the relations when the document names their targets, else a plain object", () => {
    const text = generated();
    // single and multiple relations to users; the relation to a collection the document does not know is left out
    expect(iface(text, "PostsRecord")).toContain("expand?: { author?: UsersRecord; editors?: UsersRecord[] };");
    expect(iface(text, "BlogCommentsRecord")).toContain("expand?: { post?: PostsRecord };");
    expect(iface(text, "UsersRecord")).toContain("expand?: Record<string, unknown>;");
    expect(iface(text, "StatsRecord")).toContain("expand?: Record<string, unknown>;");
  });

  test("the Collections map keys every collection by its name, quoted when it has to be", () => {
    const map = iface(generated(), "Collections");
    expect(map).toEqual(["_superusers: SuperusersRecord;", "users: UsersRecord;", "posts: PostsRecord;", '"blog-comments": BlogCommentsRecord;', "stats: StatsRecord;"]);
  });

  test("the header says the file is generated, from where, and how to regenerate it", () => {
    const [first, second, third] = generated().split("\n");
    expect(first).toBe('// Generated by voidbase types from http://shop.example/api/openapi.json: the API of "Shop" (voidbase 0.9.0), 5 collections.');
    expect(second).toContain("Do not edit by hand");
    expect(third).toBe("//   voidbase types --url http://shop.example --out src/voidbase.ts");
  });

  test("the TypedPocketBase type narrows collection() and takes the SDK's class as a parameter", () => {
    const text = generated();
    expect(text).toContain("collection<K extends keyof Collections>(name: K): RecordService<Collections[K]>;");
    expect(text).toContain("collection(name: string): RecordService<AnyRecord>;");
    expect(text).toContain('export type TypedPocketBase<Client = BaseClient> = Omit<Client, "collection"> & TypedCollectionAccess;');
    expect(text).not.toMatch(/^import /m);
  });

  test("names: PascalCase from the collection name, an identifier whatever the name was", () => {
    expect(pascal("users")).toBe("Users");
    expect(pascal("_superusers")).toBe("Superusers");
    expect(pascal("blog_posts")).toBe("BlogPosts");
    expect(pascal("blog-comments")).toBe("BlogComments");
    expect(pascal("2fa")).toBe("_2fa");
    // two names that pascal the same way get distinct interfaces
    const doc = document();
    doc.components!.schemas!["blog_comments"] = structuredClone(doc.components!.schemas!["blog-comments"]!);
    doc.components!.schemas!["blog_comments"]!.properties!.collectionName!.enum = ["blog_comments"];
    expect(collectionsOf(doc).map((c) => c.interfaceName)).toContain("BlogComments2Record");
  });

  test("the same document generates the same file", () => {
    expect(generated()).toBe(generated());
  });
});

describe("the generated file compiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "voidbase-types-"));
  const tsc = (files: string[]) => {
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "esnext", module: "esnext", moduleResolution: "bundler", lib: ["esnext", "dom"], skipLibCheck: true, types: [] }, files }));
    const p = Bun.spawnSync([join(ROOT, "node_modules/.bin/tsc"), "-p", join(dir, "tsconfig.json")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` };
  };

  test("on its own, under strict, with no imports to resolve", () => {
    writeFileSync(join(dir, "voidbase.ts"), generated());
    const r = tsc(["voidbase.ts"]);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  test("applied to the PocketBase SDK: the cast holds, a known name is narrowed, a wrong field or value is an error", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules/pocketbase"), join(dir, "node_modules/pocketbase"), "dir");
    writeFileSync(join(dir, "usage.ts"), `import PocketBase from "pocketbase";
import type { Collections, PostsRecord, TypedPocketBase } from "./voidbase";
const pb = new PocketBase("http://shop.example") as TypedPocketBase;
const full = new PocketBase("http://shop.example") as TypedPocketBase<PocketBase>;
export async function main() {
  const post = await pb.collection("posts").getOne("abc", { expand: "author,editors" });
  const status: "draft" | "live" = post.status;
  const tag: "a" | "b" | "c" | undefined = post.tags[0];
  const authorName: string | undefined = post.expand?.author?.name;
  const editorEmail: string | undefined = post.expand?.editors?.[0]?.email;
  const lon: number = post.where.lon;
  // @ts-expect-error a field the collection does not have
  post.nope;
  // @ts-expect-error a value the select does not allow
  const bad: PostsRecord["status"] = "gone";
  const page = await pb.collection("users").getList(1, 20, { filter: pb.filter("name ~ {:q}", { q: "a" }) });
  const name: string = page.items[0]!.name;
  await pb.collection("posts").create({ title: "t", status: "live", tags: ["a"] });
  // @ts-expect-error a value the select does not allow on create
  await pb.collection("posts").create({ title: "t", status: "gone" });
  const other = await pb.collection("something_else").getOne("id");
  const whatever: unknown = other.whatever;
  const auth = await pb.collection("users").authWithPassword("a@b", "p");
  const verified: boolean = auth.record.verified;
  const comment = await pb.collection("blog-comments").getFirstListItem("text != ''", { expand: "post" });
  const postTitle: string | undefined = comment.expand?.post?.title;
  const k: keyof Collections = "stats";
  const total: number = (await full.collection("stats").getFirstListItem("total > 0")).total;
  const url: string = full.files.getURL(post, "x.png");
  const stop = await pb.collection("posts").subscribe("*", (e) => { const s: "draft" | "live" = e.record.status; void s; });
  await stop();
  return [status, tag, authorName, editorEmail, lon, bad, name, whatever, verified, postTitle, k, total, url];
}
`);
    const r = tsc(["voidbase.ts", "usage.ts"]);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("getting the document", () => {
  const superuserDoc = document();
  /** a fetch that plays the instance and records what was asked */
  const fake = (answers: Record<string, (init?: RequestInit) => Response>) => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => { const url = String(input); asked.push({ url, init }); return answers[url]?.(init) ?? new Response("nope", { status: 404 }); }) as unknown as typeof fetch;
    return { f, asked };
  };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

  test("a token is sent as the Authorization header and the superuser's document comes back", async () => {
    const { f, asked } = fake({ "http://vb/api/openapi.json": (init) => ((init?.headers as Record<string, string>).authorization === "tok" ? json(superuserDoc) : json(document({ kind: "anonymous" }))) });
    const doc = await fetchDocument({ url: "http://vb/", token: "tok", fetch: f });
    expect(doc.info?.["x-voidbase"]?.scope).toBe("superuser");
    expect(asked.map((a) => a.url)).toEqual(["http://vb/api/openapi.json"]);
  });

  test("without a token, email and password sign in through _superusers first", async () => {
    const { f, asked } = fake({
      "http://vb/api/collections/_superusers/auth-with-password": (init) => (JSON.parse(String(init?.body)).identity === "a@b" ? json({ token: "signed", record: {} }) : json({ message: "no" }, 400)),
      "http://vb/api/openapi.json": (init) => ((init?.headers as Record<string, string>).authorization === "signed" ? json(superuserDoc) : json(document({ kind: "anonymous" }))),
    });
    await fetchDocument({ url: "http://vb", email: "a@b", password: "p", fetch: f });
    expect(asked.map((a) => a.url)).toEqual(["http://vb/api/collections/_superusers/auth-with-password", "http://vb/api/openapi.json"]);
    await expect(fetchDocument({ url: "http://vb", email: "x@y", password: "p", fetch: f })).rejects.toThrow(/sign-in as x@y at http:\/\/vb failed: 400/);
    await expect(fetchDocument({ url: "http://vb", fetch: f })).rejects.toThrow(/a superuser is needed/);
  });

  test("a document of another scope is refused: it would describe less than every collection", async () => {
    const { f } = fake({ "http://vb/api/openapi.json": () => json(document({ kind: "user", collection: "users" })) });
    await expect(fetchDocument({ url: "http://vb", token: "t", fetch: f })).rejects.toThrow(/as user sees it, not as a superuser/);
    expect(() => checkDocument({ openapi: "3.1.0" }, "x.json")).toThrow(/not an OpenAPI document/);
  });

  test("--json reads a saved document instead of the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voidbase-types-json-"));
    writeFileSync(join(dir, "openapi.json"), JSON.stringify(superuserDoc));
    const doc = await readDocument(join(dir, "openapi.json"));
    expect(generateTypes(doc, OPTS)).toBe(generated());
    writeFileSync(join(dir, "broken.json"), "{");
    await expect(readDocument(join(dir, "broken.json"))).rejects.toThrow(/could not read/);
    rmSync(dir, { recursive: true, force: true });
  });
});
