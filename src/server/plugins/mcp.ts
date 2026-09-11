// The stateless MCP server: an agent discovers this instance through the Model Context Protocol instead of being
// told about it, and what it discovers is what its token may call.
//
// POST /api/mcp speaks the Streamable HTTP transport in its stateless form: one JSON-RPC 2.0 request in, one JSON
// response out, no session id ever issued and none read. Stateless because a voidbase instance is a Worker: there
// is no process to keep a session in, so each call carries its own auth, the same `Authorization: <token>` header
// the REST API reads. GET and DELETE, which the transport uses to open and close a session, answer 405 and say so.
//
// The tools are not written by hand. They are derived at request time from the OpenAPI document the openapi plugin
// builds for the same token (openapi.ts, buildDocument): per collection the caller may reach, list, get and, where
// the rule allows, create, update and delete, an auth collection's auth-with-password, plus voidbase_describe (the
// document itself) and voidbase_health. A tool's inputSchema comes from the operation's parameters and body schema,
// and its description quotes the gating rule the document quotes. Calling a tool calls the instance's own route in
// process, through the Hono app the plugin is mounted on, with the caller's token forwarded, so the rules judge the
// call the way they judge any request and nothing here decides access on its own.
//
// The protocol surface is small enough to write out: initialize, notifications/initialized, ping, tools/list and
// tools/call. No dependency.
import type { Context, ExecutionContext, Hono } from "hono";
import { listCollections } from "../collections/model";
import type { Kernel } from "../kernel";
import { loadSettings } from "../settings";
import type { AppEnv, Bindings } from "../types";
import { VERSION } from "../version";
import type { Plugin } from "./manifest";
import { buildDocument, callerOf, type OpenApiSource } from "./openapi";

/** the instance's own collections and settings: what the shipped mcp and ai plugins read */
export const defaultSource: OpenApiSource = {
  collections: (env) => listCollections(env.DB),
  appName: async (env) => String((await loadSettings(env.DB)).meta.appName ?? ""),
};

/** the protocol versions this server knows; the first is what it proposes */
export const PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2024-11-05"] as const;
export const STATELESS_MESSAGE = "This MCP server is stateless: POST one JSON-RPC request at a time to /api/mcp with your token in the Authorization header; there is no session to open, resume or close.";

// --- JSON-RPC --------------------------------------------------------------------------------------------------------
type Id = string | number | null;
interface RpcRequest { jsonrpc?: unknown; id?: Id; method?: unknown; params?: unknown }
const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602;
class RpcError extends Error { constructor(public code: number, message: string, public data?: unknown) { super(message); } }
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// --- tools from the document -----------------------------------------------------------------------------------------
export type Schema = Record<string, unknown>;
interface Parameter { name: string; in: "query" | "path"; description?: string; required?: boolean; schema?: Schema }
interface Operation { summary?: string; description?: string; parameters?: Parameter[]; requestBody?: { content?: Record<string, { schema?: Schema }> } }
export type Document = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema> } };

/** what a tool runs: the route, and where each argument goes */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  method: string;
  /** the path with {id} left to fill from the arguments */
  path: string;
  pathParams: string[];
  queryParams: string[];
  /** "data": the `data` argument is the body; "self": the arguments themselves are the body; "none" */
  body: "data" | "self" | "none";
  /** a tool that does not go through a route */
  builtin?: "describe" | "health";
}

/** a schema with its $refs to the document's components inlined, so a tool's inputSchema stands on its own */
function deref(schema: Schema, components: Record<string, Schema>, depth = 0): Schema {
  if (depth > 8) return schema;
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) { const target = components[ref.slice("#/components/schemas/".length)]; return target ? deref(target, components, depth + 1) : {}; }
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "properties" && isObject(v)) out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, isObject(s) ? deref(s, components, depth + 1) : s]));
    else if (k === "items" && isObject(v)) out[k] = deref(v, components, depth + 1);
    else out[k] = v;
  }
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const describe = (o: Operation) => oneLine(`${(o.summary ?? "").replace(/\.?$/, ".")} ${o.description ?? ""}`);
const EMPTY_INPUT: Schema = { type: "object", properties: {}, additionalProperties: false };

const RECORDS = /^\/api\/collections\/([^/{}]+)\/records(\/\{id\})?$/;
const PASSWORD = /^\/api\/collections\/([^/{}]+)\/auth-with-password$/;

/** the tools this caller's document yields, in the document's order */
export function toolsOf(doc: Document): Tool[] {
  const components = doc.components.schemas;
  const tools: Tool[] = [];
  const inputOf = (o: Operation, bodyAs: Tool["body"]): { inputSchema: Schema; pathParams: string[]; queryParams: string[] } => {
    const properties: Record<string, Schema> = {}; const required: string[] = []; const pathParams: string[] = []; const queryParams: string[] = [];
    for (const p of o.parameters ?? []) {
      properties[p.name] = { ...(p.schema ?? { type: "string" }), ...(p.description ? { description: p.description } : {}) };
      if (p.in === "path") { pathParams.push(p.name); required.push(p.name); } else queryParams.push(p.name);
    }
    const body = o.requestBody?.content?.["application/json"]?.schema;
    if (body && bodyAs === "data") { properties.data = { ...deref(body, components), description: "the record's fields" }; required.push("data"); }
    if (body && bodyAs === "self") { const b = deref(body, components); Object.assign(properties, isObject(b.properties) ? b.properties : {}); if (Array.isArray(b.required)) required.push(...(b.required as string[])); }
    return { inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false }, pathParams, queryParams };
  };
  const add = (name: string, method: string, path: string, o: Operation, body: Tool["body"]) => tools.push({ name, description: describe(o), method, path, body, ...inputOf(o, body) });
  for (const [path, ops] of Object.entries(doc.paths)) {
    const records = RECORDS.exec(path); const password = PASSWORD.exec(path);
    if (records) {
      const [, collection, one] = records;
      for (const [method, o] of Object.entries(ops)) {
        if (!one && method === "get") add(`${collection}_list`, "GET", path, o, "none");
        else if (one && method === "get") add(`${collection}_get`, "GET", path, o, "none");
        else if (!one && method === "post") add(`${collection}_create`, "POST", path, o, "data");
        else if (one && method === "patch") add(`${collection}_update`, "PATCH", path, o, "data");
        else if (one && method === "delete") add(`${collection}_delete`, "DELETE", path, o, "none");
      }
    } else if (password && ops.post) add(`${password[1]}_auth_with_password`, "POST", path, ops.post, "self");
  }
  tools.push({ name: "voidbase_describe", description: "The OpenAPI 3.1 document of this instance scoped to your token: every route you may call, the record schemas and the rules that gate them.", inputSchema: EMPTY_INPUT, method: "GET", path: "/api/openapi.json", pathParams: [], queryParams: [], body: "none", builtin: "describe" });
  tools.push({ name: "voidbase_health", description: "Is the API up: GET /api/health.", inputSchema: EMPTY_INPUT, method: "GET", path: "/api/health", pathParams: [], queryParams: [], body: "none", builtin: "health" });
  return tools;
}

/** the request a tool call becomes, against the instance's own routes */
export function requestOf(tool: Tool, args: Record<string, unknown>, base: string, authorization: string): { url: string; init: RequestInit } {
  let path = tool.path;
  for (const p of tool.pathParams) { const v = args[p]; if (v === undefined || v === null || String(v) === "") throw new RpcError(INVALID_PARAMS, `${tool.name} needs ${p}.`); path = path.replace(`{${p}}`, encodeURIComponent(String(v))); }
  const url = new URL(path, base);
  for (const q of tool.queryParams) { const v = args[q]; if (v !== undefined && v !== null && v !== "") url.searchParams.set(q, String(v)); }
  const headers: Record<string, string> = { accept: "application/json" };
  if (authorization) headers.authorization = authorization;
  let body: string | undefined;
  if (tool.body === "data") { if (!isObject(args.data)) throw new RpcError(INVALID_PARAMS, `${tool.name} needs data, an object of the record's fields.`); body = JSON.stringify(args.data); }
  if (tool.body === "self") { const rest = { ...args }; for (const p of [...tool.pathParams, ...tool.queryParams]) delete rest[p]; body = JSON.stringify(rest); }
  if (body !== undefined) headers["content-type"] = "application/json";
  return { url: url.toString(), init: { method: tool.method, headers, body } };
}

/** the caller's document, from the source: the routes this request's token may call (the ai plugin asks the same) */
export async function documentFor(source: OpenApiSource, c: Context<AppEnv>, version: string): Promise<Document> {
  const collections = await source.collections(c.env);
  const name = (await source.appName(c.env).catch(() => "")).trim();
  return buildDocument({ collections, caller: callerOf(c.get("auth")), title: name || "voidbase", origin: new URL(c.req.url).origin, version }) as unknown as Document;
}

/**
 * Run one tool the way tools/call does: voidbase_describe answers the document, everything else calls the
 * instance's own route in process on the app the plugin is mounted on, the caller's token forwarded, so the rules
 * judge the call the way they judge any request. The answer is the route's text and whether it was a non-2xx;
 * a missing argument throws (an RpcError for the MCP handler, an Error for anyone else).
 */
export async function runTool(app: Hono<AppEnv>, c: Context<AppEnv>, doc: Document, tool: Tool, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (tool.builtin === "describe") return { text: JSON.stringify(doc), isError: false };
  const { url, init } = requestOf(tool, args, c.req.url, c.req.header("authorization") ?? "");
  let executionCtx: ExecutionContext | undefined;
  try { executionCtx = c.executionCtx; } catch { executionCtx = undefined; }
  const r = await app.request(url, init, c.env, executionCtx);
  const answer = await r.text();
  return { text: answer.trim() || JSON.stringify({ status: r.status }), isError: r.status < 200 || r.status >= 300 };
}

// --- the server ------------------------------------------------------------------------------------------------------
const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

function mountRoutes(app: Hono<AppEnv>, version: string, source: OpenApiSource) {
  const stateless = (c: Context<AppEnv>) => { c.header("Allow", "POST"); return c.json({ message: STATELESS_MESSAGE }, 405); };
  app.get("/api/mcp", stateless);
  app.delete("/api/mcp", stateless);
  app.post("/api/mcp", async (c: Context<AppEnv>) => {
    c.header("Cache-Control", "no-store");
    let message: unknown;
    try { message = await c.req.json(); } catch { return c.json(rpcError(null, PARSE_ERROR, "The body is not JSON."), 400); }
    if (Array.isArray(message)) return c.json(rpcError(null, INVALID_REQUEST, "Batches are not supported: send one JSON-RPC request per POST."), 400);
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return c.json(rpcError(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 request: it needs jsonrpc \"2.0\" and a method."), 400);
    const req = message as unknown as RpcRequest & { method: string };
    const id: Id = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
    const isNotification = !("id" in req) || req.id === null || req.id === undefined;
    // a notification expects nothing back; the transport says 202 and no body
    if (req.method.startsWith("notifications/")) return c.body(null, 202);
    if (isNotification) return c.json(rpcError(null, INVALID_REQUEST, "A request needs an id; only notifications/* go without one."), 400);
    const params = isObject(req.params) ? req.params : {};
    const document = () => documentFor(source, c, version);
    try {
      switch (req.method) {
        case "initialize": {
          const asked = String(params.protocolVersion ?? "");
          const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
          return c.json(rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "voidbase", version }, instructions: "The tools are this voidbase instance's collections as your token may call them: <collection>_list, _get, _create, _update, _delete and, for auth collections, _auth_with_password. voidbase_describe answers the full OpenAPI document for your scope." }));
        }
        case "ping": return c.json(rpcResult(id, {}));
        case "tools/list": {
          const tools = toolsOf(await document()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
          return c.json(rpcResult(id, { tools }));
        }
        case "tools/call": {
          const name = String(params.name ?? "");
          const doc = await document();
          const tool = toolsOf(doc).find((t) => t.name === name);
          if (!tool) throw new RpcError(INVALID_PARAMS, `There is no tool called ${JSON.stringify(name)} for this token.`);
          if (params.arguments !== undefined && !isObject(params.arguments)) throw new RpcError(INVALID_PARAMS, "arguments must be an object.");
          const args = isObject(params.arguments) ? params.arguments : {};
          // the instance's own route, in process: the same middleware, the same rules, the caller's own token
          const ran = await runTool(app, c, doc, tool, args);
          return c.json(rpcResult(id, text(ran.text, ran.isError)));
        }
        default: throw new RpcError(METHOD_NOT_FOUND, `${req.method} is not a method this server has: initialize, ping, tools/list, tools/call.`);
      }
    } catch (err) {
      if (err instanceof RpcError) return c.json(rpcError(id, err.code, err.message, err.data));
      throw err;
    }
  });
}

/** the plugin over a source of its own: tests hand in collections and a name without a database */
export const mcpWith = (source: Partial<OpenApiSource> = {}, version: string = VERSION): Plugin => ({
  manifest: { name: "mcp", version: "0.1.0", tier: "official", voidbase: "*" },
  apply(ctx: Kernel) { mountRoutes(ctx.app, version, { ...defaultSource, ...source }); },
});

/** the shipped plugin: the instance's own collections and settings */
export const mcp: Plugin = mcpWith();
