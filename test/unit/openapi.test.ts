// The openapi plugin: one document per caller, generated from the collections, and the page that reads it.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import { invalidateCollections, type Collection } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import { createKernel, load } from "../../src/server/kernel";
import { auth, provider } from "../../src/server/plugins/auth";
import { openapi, openapiWith } from "../../src/server/plugins/openapi";
import { invalidateSettings } from "../../src/server/settings";
import type { AppEnv, AuthRecord, Bindings } from "../../src/server/types";

// the collections an instance might have: every field type, every shape of rule
const f = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f_${name}`, name, type, system: false, hidden: false, presentable: false, required: false, help: "", ...extra });
const collection = (name: string, type: Collection["type"], rules: Partial<Pick<Collection, "listRule" | "viewRule" | "createRule" | "updateRule" | "deleteRule">>, fields: Record<string, unknown>[], system = false): Collection =>
  ({ id: `c_${name}`, name, type, system, fields: fields as Collection["fields"], indexes: [], options: {}, created: "", updated: "", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules }) as Collection;
const AUTH_FIELDS = [
  f("password", "password", { system: true, hidden: true, required: true }), f("tokenKey", "text", { system: true, hidden: true, required: true }),
  f("email", "email", { system: true, required: true }), f("emailVisibility", "bool", { system: true }), f("verified", "bool", { system: true }),
];
const COLLECTIONS: Collection[] = [
  collection("_superusers", "auth", {}, [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS, f("created", "autodate", { onCreate: true }), f("updated", "autodate", { onCreate: true, onUpdate: true })], true),
  collection("users", "auth", { listRule: "id = @request.auth.id", viewRule: "id = @request.auth.id", createRule: "", updateRule: "id = @request.auth.id", deleteRule: "id = @request.auth.id" }, [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS, f("name", "text"), f("avatar", "file", { maxSelect: 1 })]),
  collection("posts", "base", { listRule: "", viewRule: "", createRule: '@request.auth.id != ""', updateRule: "author = @request.auth.id", deleteRule: null }, [
    f("id", "text", { primaryKey: true, system: true }), f("title", "text", { required: true }), f("body", "editor"), f("views", "number", { onlyInt: true, min: 0 }), f("score", "number"),
    f("published", "bool"), f("contact", "email"), f("site", "url"), f("when", "date"), f("status", "select", { maxSelect: 1, values: ["draft", "live"] }),
    f("tags", "select", { maxSelect: 3, values: ["a", "b", "c"] }), f("meta", "json"), f("cover", "file", { maxSelect: 1 }), f("gallery", "file", { maxSelect: 5 }),
    f("author", "relation", { collectionId: "c_users", maxSelect: 1 }), f("where", "geoPoint"), f("created", "autodate", { onCreate: true }), f("updated", "autodate", { onCreate: true, onUpdate: true }),
  ]),
  collection("secrets", "base", {}, [f("id", "text", { primaryKey: true, system: true }), f("value", "text")]),
  collection("stats", "view", { listRule: "", viewRule: "" }, [f("id", "text", { primaryKey: true, system: true }), f("total", "number")]),
];

type Doc = { info: { title: string; "x-voidbase": { scope: string; collection?: string } }; servers: { url: string }[]; paths: Record<string, Record<string, { description: string; security?: unknown[] }>>; components: { schemas: Record<string, { properties: Record<string, Record<string, unknown>>; required?: string[] }>; securitySchemes: Record<string, Record<string, unknown>> }; security: unknown[] };
const superuser = { collection: COLLECTIONS[0], row: { id: "s1" } } as AuthRecord;
const user = { collection: COLLECTIONS[1], row: { id: "u1" } } as AuthRecord;

async function appWith(plugin = openapiWith({ collections: async () => COLLECTIONS, appName: async () => "Shop" }), env: Partial<Bindings> = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { const as = c.req.header("x-as"); c.set("auth", as === "superuser" ? superuser : as === "user" ? user : null); await next(); });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message }, err.status as 400) : c.json({ message: String(err) }, 500)));
  const kernel = createKernel(app);
  await load(kernel, [auth, plugin], "0.9.0");
  provideAuthLookup(() => provider);
  const doc = async (as: "anonymous" | "user" | "superuser") => { const r = await app.request("http://shop.example/api/openapi.json", { headers: as === "anonymous" ? {} : { "x-as": as } }, env as Bindings); expect(r.status).toBe(200); return (await r.json()) as Doc; };
  return { app, doc };
}
const methods = (doc: Doc, p: string) => Object.keys(doc.paths[p] ?? {}).sort();

describe("the document is scoped to the caller", () => {
  test("anonymous: only public operations, no locked and no rule-gated ones", async () => {
    const { doc } = await appWith();
    const d = await doc("anonymous");
    expect(d.info["x-voidbase"]).toEqual({ scope: "anonymous" });
    expect(d.security).toEqual([]);
    expect(methods(d, "/api/collections/posts/records")).toEqual(["get"]);
    expect(methods(d, "/api/collections/posts/records/{id}")).toEqual(["get"]);
    expect(d.paths["/api/collections/posts/records"]!.get!.description).toMatch(/^Public/);
    // voidbase's own can-update is gated by the view rule, so it is described wherever the record's GET is
    expect(methods(d, "/api/collections/posts/records/{id}/can-update")).toEqual(["get"]);
    expect(d.paths["/api/collections/posts/records/{id}/can-update"]!.get!.description).not.toContain("author = @request.auth.id");
    expect(methods(d, "/api/collections/users/records")).toEqual(["post"]);
    expect(d.paths["/api/collections/users/records/{id}"]).toBeUndefined();
    expect(methods(d, "/api/collections/stats/records")).toEqual(["get"]);
    expect(Object.keys(d.paths).filter((p) => p.includes("/secrets/"))).toEqual([]);
    expect(Object.keys(d.paths).filter((p) => p.includes("/_superusers/records"))).toEqual([]);
    // signing in is public; refreshing needs a token
    expect(methods(d, "/api/collections/users/auth-with-password")).toEqual(["post"]);
    expect(methods(d, "/api/collections/users/auth-methods")).toEqual(["get"]);
    expect(d.paths["/api/collections/users/auth-refresh"]).toBeUndefined();
    expect(methods(d, "/api/collections/_superusers/auth-with-password")).toEqual(["post"]);
    expect(methods(d, "/api/health")).toEqual(["get"]);
    for (const p of ["/api/collections", "/api/settings", "/api/logs", "/api/backups", "/api/plugins"]) expect(d.paths[p]).toBeUndefined();
    // a collection with nothing to show has no schema either
    expect(d.components.schemas.secrets).toBeUndefined();
    expect(d.components.schemas.posts).toBeDefined();
  });

  test("a signed-in user: the rule-gated operations too, with the rule quoted; still nothing locked", async () => {
    const { doc } = await appWith();
    const d = await doc("user");
    expect(d.info["x-voidbase"]).toEqual({ scope: "user", collection: "users" });
    expect(d.security).toEqual([{ token: [] }]);
    expect(methods(d, "/api/collections/posts/records")).toEqual(["get", "post"]);
    expect(methods(d, "/api/collections/posts/records/{id}")).toEqual(["get", "patch"]);
    expect(d.paths["/api/collections/posts/records"]!.post!.description).toContain('`@request.auth.id != ""`');
    expect(d.paths["/api/collections/posts/records/{id}"]!.patch!.description).toContain("`author = @request.auth.id`");
    expect(methods(d, "/api/collections/users/records/{id}")).toEqual(["delete", "get", "patch"]);
    expect(methods(d, "/api/collections/users/auth-refresh")).toEqual(["post"]);
    expect(d.paths["/api/collections/_superusers/auth-refresh"]).toBeUndefined();
    expect(Object.keys(d.paths).filter((p) => p.includes("/secrets/"))).toEqual([]);
    for (const p of ["/api/collections", "/api/settings", "/api/logs", "/api/backups", "/api/plugins"]) expect(d.paths[p]).toBeUndefined();
  });

  test("a superuser: everything, the locked operations and the system routes included", async () => {
    const { doc } = await appWith();
    const d = await doc("superuser");
    expect(d.info["x-voidbase"]).toEqual({ scope: "superuser", collection: "_superusers" });
    expect(methods(d, "/api/collections/posts/records/{id}")).toEqual(["delete", "get", "patch"]);
    expect(d.paths["/api/collections/posts/records/{id}"]!.delete!.description).toMatch(/^Superusers only/);
    expect(methods(d, "/api/collections/secrets/records")).toEqual(["get", "post"]);
    expect(methods(d, "/api/collections/secrets/records/{id}")).toEqual(["delete", "get", "patch"]);
    expect(methods(d, "/api/collections/_superusers/records")).toEqual(["get", "post"]);
    expect(methods(d, "/api/collections/users/auth-refresh")).toEqual(["post"]);
    expect(methods(d, "/api/collections/_superusers/auth-refresh")).toEqual(["post"]);
    // a view has no writes whoever asks, and so no can-update either
    expect(methods(d, "/api/collections/stats/records")).toEqual(["get"]);
    expect(d.paths["/api/collections/stats/records/{id}/can-update"]).toBeUndefined();
    expect(methods(d, "/api/collections/secrets/records/{id}/can-update")).toEqual(["get"]);
    expect(methods(d, "/api/collections")).toEqual(["get", "post"]);
    expect(methods(d, "/api/collections/{collection}")).toEqual(["delete", "get", "patch"]);
    expect(methods(d, "/api/settings")).toEqual(["get", "patch"]);
    expect(methods(d, "/api/logs")).toEqual(["get"]);
    expect(methods(d, "/api/backups")).toEqual(["get", "post"]);
    expect(methods(d, "/api/backups/{key}/restore")).toEqual(["post"]);
    expect(methods(d, "/api/plugins")).toEqual(["get"]);
    expect(d.components.schemas.secrets).toBeDefined();
  });
});

describe("the document's shape", () => {
  test("title from the settings, the request origin as the server, the token as an API key header", async () => {
    const { doc } = await appWith();
    const d = await doc("anonymous");
    expect(d.info.title).toBe("Shop");
    expect(d.servers).toEqual([{ url: "http://shop.example" }]);
    expect(d.components.securitySchemes.token).toMatchObject({ type: "apiKey", in: "header", name: "Authorization" });
    expect((d as unknown as { openapi: string }).openapi).toBe("3.1.0");
  });

  test("an instance without a name is called voidbase", async () => {
    const { doc } = await appWith(openapiWith({ collections: async () => COLLECTIONS, appName: async () => "  " }));
    expect((await doc("anonymous")).info.title).toBe("voidbase");
  });

  test("the record schema follows the fields; hidden ones are dropped; created and updated are read-only", async () => {
    const { doc } = await appWith();
    const p = (await doc("superuser")).components.schemas.posts!.properties;
    expect(p.id).toMatchObject({ type: "string" });
    expect(p.collectionName).toMatchObject({ enum: ["posts"] });
    expect(p.title).toEqual({ type: "string" });
    expect(p.body).toMatchObject({ type: "string", description: "HTML" });
    expect(p.views).toMatchObject({ type: "integer", minimum: 0 });
    expect(p.score).toEqual({ type: "number" });
    expect(p.published).toEqual({ type: "boolean" });
    expect(p.contact).toMatchObject({ type: "string", format: "email" });
    expect(p.site).toMatchObject({ type: "string", format: "uri" });
    expect(p.when).toMatchObject({ type: "string" });
    expect(p.status).toMatchObject({ type: "string", enum: ["draft", "live"] });
    expect(p.tags).toMatchObject({ type: "array", maxItems: 3, items: { type: "string", enum: ["a", "b", "c"] } });
    expect(p.meta).toEqual({ description: "any JSON value" });
    expect(p.cover).toMatchObject({ type: "string" });
    expect(p.gallery).toMatchObject({ type: "array", items: { type: "string" } });
    expect(p.author).toMatchObject({ type: "string", description: "id of a users record", "x-collection": "users" });
    expect(p.where).toMatchObject({ type: "object", properties: { lon: { type: "number" }, lat: { type: "number" } }, required: ["lon", "lat"] });
    // every answered field is required, expand alone is optional: a record always carries all of its fields
    const required = (await doc("superuser")).components.schemas.posts!.required!;
    expect(required).toEqual(Object.keys(p).filter((k) => k !== "expand"));
    expect(required).toContain("created");
    expect(p.created).toMatchObject({ type: "string", readOnly: true });
    expect(p.updated).toMatchObject({ type: "string", readOnly: true });
    const users = (await doc("superuser")).components.schemas.users!.properties;
    expect(users.tokenKey).toBeUndefined();
    expect(users.password).toBeUndefined();
    expect(users.email).toMatchObject({ type: "string", format: "email" });
    expect(users.verified).toEqual({ type: "boolean" });
    // a collection without autodate fields still answers created and updated
    const secrets = (await doc("superuser")).components.schemas.secrets!.properties;
    expect(secrets.created).toMatchObject({ readOnly: true });
  });

  test("the bodies: required fields on create, the auth passwords, no autodate", async () => {
    const { doc } = await appWith();
    const s = (await doc("superuser")).components.schemas;
    expect(s.postsCreate!.required).toEqual(["title"]);
    expect(s.postsCreate!.properties.created).toBeUndefined();
    expect(s.postsCreate!.properties.id).toMatchObject({ pattern: "^[a-z0-9]{15}$" });
    expect(s.postsUpdate!.properties.id).toBeUndefined();
    expect(s.postsUpdate!.required).toBeUndefined();
    expect(s.usersCreate!.required).toEqual(["email", "password", "passwordConfirm"]);
    expect(s.usersCreate!.properties.tokenKey).toBeUndefined();
    expect(s.usersUpdate!.properties.oldPassword).toBeDefined();
    expect(s.statsCreate).toBeUndefined();
  });

  test("the list answer and its query parameters", async () => {
    const { doc } = await appWith();
    const d = await doc("anonymous");
    expect(d.components.schemas.postsList!.required).toEqual(["page", "perPage", "totalItems", "totalPages", "items"]);
    expect(d.components.schemas.postsList!.properties.items).toEqual({ type: "array", items: { $ref: "#/components/schemas/posts" } });
    const params = (d.paths["/api/collections/posts/records"]!.get as unknown as { parameters: { name: string }[] }).parameters.map((p) => p.name);
    expect(params).toEqual(["page", "perPage", "sort", "filter", "expand", "fields", "skipTotal"]);
    expect(d.components.schemas.usersAuth!.required).toEqual(["token", "record"]);
  });
});

describe("the page", () => {
  test("/api/docs is HTML that loads Scalar from the CDN over /api/openapi.json and says what it shows", async () => {
    const { app } = await appWith();
    const r = await app.request("http://shop.example/api/docs", {}, {} as Bindings);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toContain("/api/openapi.json");
    expect(html).toContain('src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"');
    expect(html).toContain("what your token may call");
  });
});

describe("the shipped plugin reads the instance", () => {
  test("the collections table and the settings row, through the database", async () => {
    invalidateCollections(); invalidateSettings();
    const rows = COLLECTIONS.map((c) => ({ ...c, system: c.system ? 1 : 0, fields: JSON.stringify(c.fields), indexes: "[]", options: "{}" }));
    const db = { prepare: (sql: string) => ({ bind: () => ({
      all: async () => ({ results: /_collections/.test(sql) ? rows : [] }),
      first: async () => (/_params/.test(sql) ? { value: JSON.stringify({ meta: { appName: "From the row" } }) } : null),
    }) }) } as unknown as D1Database;
    const { doc } = await appWith(openapi, { DB: db });
    const d = await doc("anonymous");
    expect(d.info.title).toBe("From the row");
    expect(methods(d, "/api/collections/posts/records")).toEqual(["get"]);
    invalidateCollections(); invalidateSettings();
  });
});
