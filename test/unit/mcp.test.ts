// The mcp plugin: a stateless MCP server whose tools are the scoped OpenAPI document, and whose calls are the
// instance's own routes, in process, with the caller's token forwarded.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import { createKernel, load } from "../../src/server/kernel";
import { auth, provider } from "../../src/server/plugins/auth";
import { mcpWith, PROTOCOL_VERSIONS } from "../../src/server/plugins/mcp";
import { openapiWith } from "../../src/server/plugins/openapi";
import type { AppEnv, AuthRecord, Bindings } from "../../src/server/types";

// the collections: an auth collection gated to its own record, a public base collection with gated writes and a
// locked delete, a locked collection, a view
const f = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f_${name}`, name, type, system: false, hidden: false, presentable: false, required: false, help: "", ...extra });
const collection = (name: string, type: Collection["type"], rules: Partial<Pick<Collection, "listRule" | "viewRule" | "createRule" | "updateRule" | "deleteRule">>, fields: Record<string, unknown>[], system = false): Collection =>
  ({ id: `c_${name}`, name, type, system, fields: fields as Collection["fields"], indexes: [], options: {}, created: "", updated: "", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules }) as Collection;
const AUTH_FIELDS = [
  f("password", "password", { system: true, hidden: true, required: true }), f("tokenKey", "text", { system: true, hidden: true, required: true }),
  f("email", "email", { system: true, required: true }), f("emailVisibility", "bool", { system: true }), f("verified", "bool", { system: true }),
];
const COLLECTIONS: Collection[] = [
  collection("_superusers", "auth", {}, [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS], true),
  collection("users", "auth", { listRule: "id = @request.auth.id", viewRule: "id = @request.auth.id", createRule: "", updateRule: "id = @request.auth.id", deleteRule: "id = @request.auth.id" }, [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS, f("name", "text")]),
  collection("posts", "base", { listRule: "", viewRule: "", createRule: '@request.auth.id != ""', updateRule: "author = @request.auth.id", deleteRule: null }, [
    f("id", "text", { primaryKey: true, system: true }), f("title", "text", { required: true }), f("views", "number", { onlyInt: true, min: 0 }), f("status", "select", { maxSelect: 1, values: ["draft", "live"] }), f("author", "relation", { collectionId: "c_users", maxSelect: 1 }),
  ]),
  collection("secrets", "base", {}, [f("id", "text", { primaryKey: true, system: true }), f("value", "text")]),
  collection("stats", "view", { listRule: "", viewRule: "" }, [f("id", "text", { primaryKey: true, system: true }), f("total", "number")]),
];
const superuser = { collection: COLLECTIONS[0], row: { id: "s1" } } as AuthRecord;
const user = { collection: COLLECTIONS[1], row: { id: "u1" } } as AuthRecord;
// the tokens: the test's auth middleware reads them the way the auth plugin reads a real one, from Authorization
const TOKENS: Record<string, AuthRecord> = { "su-token": superuser, "user-token": user };

type Rpc = { jsonrpc: string; id: unknown; result?: any; error?: { code: number; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
type ToolDesc = { name: string; description: string; inputSchema: { type: string; properties: Record<string, Record<string, unknown>>; required?: string[] } };
type Seen = { method: string; path: string; query: Record<string, string>; body: unknown; authorization: string | undefined };

async function appWith() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("auth", TOKENS[c.req.header("authorization") ?? ""] ?? null); await next(); });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message }, err.status as 400) : c.json({ message: String(err) }, 500)));
  // the records routes, faked: they record what reached them and answer a fixed record, so the test proves the
  // forwarding without a database
  const seen: Seen[] = [];
  const record = async (c: { req: { method: string; path: string; query(): Record<string, string>; header(n: string): string | undefined; json(): Promise<unknown>; param(n: string): string | undefined } }) => {
    let body: unknown = null; try { body = await c.req.json(); } catch { body = null; }
    seen.push({ method: c.req.method, path: c.req.path, query: c.req.query(), body, authorization: c.req.header("authorization") });
  };
  app.get("/api/collections/:c/records", async (c) => { await record(c); return c.json({ page: 1, perPage: 30, totalItems: 1, totalPages: 1, items: [{ id: "r1", collectionName: c.req.param("c"), title: "hello" }] }); });
  app.post("/api/collections/:c/records", async (c) => { await record(c); return c.get("auth") ? c.json({ id: "new1", collectionName: c.req.param("c"), title: "made" }) : c.json({ status: 403, message: "Only authenticated records can access this action.", data: {} }, 403); });
  app.get("/api/collections/:c/records/:id", async (c) => { await record(c); return c.req.param("id") === "missing" ? c.json({ status: 404, message: "The requested resource wasn't found.", data: {} }, 404) : c.json({ id: c.req.param("id"), collectionName: c.req.param("c"), title: "one" }); });
  app.patch("/api/collections/:c/records/:id", async (c) => { await record(c); return c.json({ id: c.req.param("id"), collectionName: c.req.param("c"), title: "changed" }); });
  app.delete("/api/collections/:c/records/:id", async (c) => { await record(c); return c.body(null, 204); });
  app.post("/api/collections/:c/auth-with-password", async (c) => { await record(c); return c.json({ token: "fresh-token", record: { id: "u1", collectionName: c.req.param("c") } }); });
  app.get("/api/health", (c) => c.json({ code: 200, message: "API is healthy.", data: {} }));
  const kernel = createKernel(app);
  const source = { collections: async () => COLLECTIONS, appName: async () => "Shop" };
  await load(kernel, [auth, openapiWith(source), mcpWith(source, "0.9.0")], "0.9.0");
  provideAuthLookup(() => provider);
  const post = async (body: unknown, token = "", raw = false) => {
    const r = await app.request("http://shop.example/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: token } : {}) }, body: raw ? String(body) : JSON.stringify(body) }, {} as Bindings);
    return { status: r.status, headers: r.headers, json: r.status === 202 ? null : ((await r.json()) as Rpc) };
  };
  const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  const tools = async (token = "") => { const r = await post(rpc("tools/list"), token); expect(r.status).toBe(200); return r.json!.result.tools as ToolDesc[]; };
  const call = async (name: string, args: Record<string, unknown> | undefined, token = "") => { const r = await post(rpc("tools/call", { name, arguments: args }, 7), token); return { status: r.status, ...r.json! }; };
  return { app, post, rpc, tools, call, seen };
}
const names = (tools: ToolDesc[]) => tools.map((t) => t.name).sort();
const byName = (tools: ToolDesc[], name: string) => tools.find((t) => t.name === name)!;

describe("the transport is stateless", () => {
  test("initialize: our version by default, the client's when we know it; tools only; no session id", async () => {
    const { post, rpc } = await appWith();
    const r = await post(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    expect(r.json).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "voidbase", version: "0.9.0" } } });
    expect((await post(rpc("initialize", { protocolVersion: "2024-11-05" }))).json!.result.protocolVersion).toBe("2024-11-05");
    expect((await post(rpc("initialize", { protocolVersion: "1999-01-01" }))).json!.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect((await post(rpc("initialize"))).json!.result.protocolVersion).toBe("2025-03-26");
  });

  test("notifications/initialized is 202 with no body; ping answers an empty result", async () => {
    const { post } = await appWith();
    const n = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(n.status).toBe(202);
    expect(n.headers.get("mcp-session-id")).toBeNull();
    const p = await post({ jsonrpc: "2.0", id: "p", method: "ping" });
    expect(p.status).toBe(200);
    expect(p.json).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  test("GET and DELETE answer 405 and say the server is stateless", async () => {
    const { app } = await appWith();
    for (const method of ["GET", "DELETE"]) {
      const r = await app.request("http://shop.example/api/mcp", { method }, {} as Bindings);
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
      const body = (await r.json()) as { message: string };
      expect(Object.keys(body)).toEqual(["message"]);
      expect(body.message).toMatch(/stateless/);
      expect(body.message).not.toContain("\n");
    }
  });
});

describe("tools/list follows the caller's scope", () => {
  test("anonymous: the public collections' read tools, sign-in, the two voidbase tools; nothing gated or locked", async () => {
    const { tools } = await appWith();
    const t = await tools();
    expect(names(t)).toEqual(["_superusers_auth_with_password", "posts_get", "posts_list", "stats_get", "stats_list", "users_auth_with_password", "users_create", "voidbase_describe", "voidbase_health"]);
    expect(byName(t, "posts_list").description).toBe("List posts records. Public: anyone may call this.");
    const input = byName(t, "posts_list").inputSchema;
    expect(input.type).toBe("object");
    expect(Object.keys(input.properties)).toEqual(["page", "perPage", "sort", "filter", "expand", "fields", "skipTotal"]);
    expect(input.properties.page).toMatchObject({ type: "integer", minimum: 1, description: "1-based page" });
    expect(input.required).toBeUndefined();
    expect(byName(t, "posts_get").inputSchema).toMatchObject({ required: ["id"], properties: { id: { type: "string" }, expand: { type: "string" }, fields: { type: "string" } } });
    // the sign-in tool's arguments are the body itself
    expect(byName(t, "users_auth_with_password").inputSchema).toMatchObject({ required: ["identity", "password"], properties: { identity: { type: "string" }, password: { type: "string", format: "password" } } });
    expect(byName(t, "users_auth_with_password").description).toMatch(/^Sign in to users with a password\. Public/);
    // a public create takes the record's fields, shaped by the schema, with the $ref inlined
    const create = byName(t, "users_create").inputSchema;
    expect(create.required).toEqual(["data"]);
    expect(create.properties.data).toMatchObject({ type: "object", required: ["email", "password", "passwordConfirm"] });
    expect((create.properties.data as { properties: Record<string, unknown> }).properties.email).toMatchObject({ type: "string", format: "email" });
    expect(JSON.stringify(t)).not.toContain("$ref");
    for (const tool of t) expect(tool.description).not.toContain("\n");
  });

  test("a user: the gated tools too, with the rule in the description; still nothing locked", async () => {
    const { tools } = await appWith();
    const t = await tools("user-token");
    expect(names(t)).toEqual(["_superusers_auth_with_password", "posts_create", "posts_get", "posts_list", "posts_update", "stats_get", "stats_list", "users_auth_with_password", "users_create", "users_delete", "users_get", "users_list", "users_update", "voidbase_describe", "voidbase_health"]);
    expect(byName(t, "posts_create").description).toBe('Create a posts record. Gated by the rule `@request.auth.id != ""`, judged against the signed-in record and the request.');
    expect(byName(t, "posts_update").description).toContain("`author = @request.auth.id`");
    expect(byName(t, "posts_update").inputSchema).toMatchObject({ required: ["id", "data"] });
    const data = byName(t, "posts_update").inputSchema.properties.data as { properties: Record<string, unknown> };
    expect(data.properties.status).toMatchObject({ type: "string", enum: ["draft", "live"] });
    expect(data.properties.author).toMatchObject({ type: "string", description: "id of a users record" });
    expect(data.properties.id).toBeUndefined();
    expect(byName(t, "users_delete").inputSchema).toMatchObject({ required: ["id"] });
  });

  test("a superuser: everything, the locked delete and the locked collection included; a view has no writes", async () => {
    const { tools } = await appWith();
    const t = await tools("su-token");
    expect(names(t).filter((n) => n.startsWith("posts_"))).toEqual(["posts_create", "posts_delete", "posts_get", "posts_list", "posts_update"]);
    expect(byName(t, "posts_delete").description).toBe("Delete a posts record. Superusers only: the rule is locked.");
    expect(names(t).filter((n) => n.startsWith("secrets_"))).toEqual(["secrets_create", "secrets_delete", "secrets_get", "secrets_list", "secrets_update"]);
    expect(names(t).filter((n) => n.startsWith("_superusers_"))).toEqual(["_superusers_auth_with_password", "_superusers_create", "_superusers_delete", "_superusers_get", "_superusers_list", "_superusers_update"]);
    expect(names(t).filter((n) => n.startsWith("stats_"))).toEqual(["stats_get", "stats_list"]);
  });
});

describe("tools/call runs the instance's own route, in process", () => {
  test("list: the query and the token reach the records route; the answer comes back as text", async () => {
    const { call, seen } = await appWith();
    const r = await call("posts_list", { page: 2, perPage: 5, sort: "-created", filter: 'status = "live"', expand: "author", fields: "id,title" }, "user-token");
    expect(r.status).toBe(200);
    expect(r.id).toBe(7);
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content).toHaveLength(1);
    expect(r.result.content[0].type).toBe("text");
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({ totalItems: 1, items: [{ id: "r1", collectionName: "posts" }] });
    expect(seen).toEqual([{ method: "GET", path: "/api/collections/posts/records", query: { page: "2", perPage: "5", sort: "-created", filter: 'status = "live"', expand: "author", fields: "id,title" }, body: null, authorization: "user-token" }]);
  });

  test("create: the data argument is the JSON body, the token goes with it", async () => {
    const { call, seen } = await appWith();
    const r = await call("posts_create", { data: { title: "hi", status: "draft" } }, "user-token");
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.result.content[0].text)).toEqual({ id: "new1", collectionName: "posts", title: "made" });
    expect(seen).toEqual([{ method: "POST", path: "/api/collections/posts/records", query: {}, body: { title: "hi", status: "draft" }, authorization: "user-token" }]);
  });

  test("get, update, delete: the id fills the path; a 204 is reported as its status", async () => {
    const { call, seen } = await appWith();
    await call("posts_get", { id: "abc", expand: "author" }, "su-token");
    await call("posts_update", { id: "abc", data: { title: "x" } }, "su-token");
    const d = await call("posts_delete", { id: "abc" }, "su-token");
    expect(seen.map((s) => [s.method, s.path, s.query, s.body])).toEqual([["GET", "/api/collections/posts/records/abc", { expand: "author" }, null], ["PATCH", "/api/collections/posts/records/abc", {}, { title: "x" }], ["DELETE", "/api/collections/posts/records/abc", {}, null]]);
    expect(seen.every((s) => s.authorization === "su-token")).toBe(true);
    expect(d.result.isError).toBeUndefined();
    expect(JSON.parse(d.result.content[0].text)).toEqual({ status: 204 });
  });

  test("auth_with_password: the arguments are the body, no token needed, the token comes back", async () => {
    const { call, seen } = await appWith();
    const r = await call("users_auth_with_password", { identity: "a@b.c", password: "pw" });
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({ token: "fresh-token", record: { id: "u1" } });
    expect(seen).toEqual([{ method: "POST", path: "/api/collections/users/auth-with-password", query: {}, body: { identity: "a@b.c", password: "pw" }, authorization: undefined }]);
  });

  test("a non-2xx answer is the tool's error, not the protocol's", async () => {
    const { call } = await appWith();
    const r = await call("posts_get", { id: "missing" });
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({ status: 404 });
  });

  test("voidbase_describe answers the scoped document; voidbase_health calls /api/health", async () => {
    const { call } = await appWith();
    const d = await call("voidbase_describe", {}, "user-token");
    const doc = JSON.parse(d.result.content[0].text) as { openapi: string; info: { title: string; "x-voidbase": unknown }; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Shop");
    expect(doc.info["x-voidbase"]).toEqual({ scope: "user", collection: "users" });
    expect(doc.paths["/api/collections/posts/records"]).toBeDefined();
    const h = await call("voidbase_health", undefined);
    expect(JSON.parse(h.result.content[0].text)).toMatchObject({ code: 200 });
  });
});

describe("the error codes", () => {
  test("bad JSON is -32700", async () => {
    const { post } = await appWith();
    const r = await post("{not json", "", true);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  });

  test("a batch and a non-request are -32600", async () => {
    const { post, rpc } = await appWith();
    const b = await post([rpc("ping"), rpc("ping", undefined, 2)]);
    expect(b.status).toBe(400);
    expect(b.json!.error).toMatchObject({ code: -32600 });
    expect(b.json!.error!.message).toMatch(/[Bb]atch/);
    expect((await post({ hello: "world" })).json!.error).toMatchObject({ code: -32600 });
    expect((await post({ jsonrpc: "1.0", id: 1, method: "ping" })).json!.error).toMatchObject({ code: -32600 });
  });

  test("an unknown method is -32601", async () => {
    const { post, rpc } = await appWith();
    const r = await post(rpc("resources/list", undefined, 9));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 9, error: { code: -32601 } });
  });

  test("a missing tool, a tool outside the caller's scope and a missing argument are -32602", async () => {
    const { call } = await appWith();
    expect((await call("nothing_here", {})).error).toMatchObject({ code: -32602 });
    // locked for anyone but a superuser: the tool does not exist for this token
    expect((await call("posts_delete", { id: "abc" }, "user-token")).error).toMatchObject({ code: -32602 });
    expect((await call("posts_get", {})).error).toMatchObject({ code: -32602 });
    expect((await call("posts_create", { data: "not an object" }, "user-token")).error).toMatchObject({ code: -32602 });
  });
});
