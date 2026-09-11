// A chat over the instance on Workers AI, as the plugin `ai`: the model talks to whoever is asking, with the
// instance's own API as its tools, scoped to the token the request carries.
//
// POST /api/ai/chat takes a conversation and answers it. The tools the model may call are the MCP server's tool
// list for the same caller (mcp.ts, toolsOf over the caller's OpenAPI document): anonymous sees the public API,
// a user what that user may call, a superuser everything. A call the model makes runs the way tools/call runs it,
// the instance's own route in process with the caller's token forwarded (mcp.ts, runTool), so the rules judge it
// and nothing here decides access. The loop is the traditional function-calling loop Workers AI documents
// (developers.cloudflare.com/workers-ai/features/function-calling/traditional, and Cloudflare's own
// @cloudflare/ai-utils runWithTools): `env.AI.run(model, { messages, tools })` answers `response` and, when it
// wants a tool, `tool_calls: [{ name, arguments }]`; each call's result goes back as an assistant message carrying
// the call and a `{ role: "tool", name, content }` message carrying the answer, and the model is asked again, until
// it answers without a call or maxSteps is reached. The OpenAI-style call (`{ id, type, function: { name,
// arguments } }`, which @cloudflare/workers-types also declares) is read the same way.
//
// Streaming is left out: Workers AI streams a call's text, but a call that streams cannot also hand back
// tool_calls to act on, and Cloudflare's own helper streams only one extra final call made without tools. The
// answer is one JSON body; `stream: true` is refused and says so.
//
// The binding arrives with the request, not at load: without it the route answers 503 and names the knob, and
// GET /api/plugins reports `ai: { via: "none" }`. The rate cap is per caller, in memory, so per isolate: the
// hardening plugin's rules are keyed by settings, not by a route a plugin registers, and Workers AI is metered.
import { env as voidEnv } from "#platform/env";
import type { Context, Hono } from "hono";
import type { Kernel } from "../kernel";
import type { AppEnv, AuthRecord, Bindings } from "../types";
import { VERSION } from "../version";
import type { Plugin } from "./manifest";
import { defaultSource, documentFor, runTool, toolsOf, type Document, type Tool } from "./mcp";
import type { OpenApiSource } from "./openapi";

import { AI_BINDING, AI_VAR, DEFAULT_MODEL, aiModelOf } from "./ai-binding";
export { AI_BINDING, AI_VAR, DEFAULT_MODEL, aiModelOf };

/** the model these bindings name: the knob's value, or the default when the binding is there and the knob says only that */
export const aiModel = (env: Bindings): string =>
  aiModelOf(String((env as unknown as Record<string, unknown>)[AI_VAR] ?? (voidEnv as Record<string, unknown>)[AI_VAR] ?? "")) || (env.AI ? DEFAULT_MODEL : "");

/** what GET /api/plugins says in its `ai` field */
export const aiRoute = (env: Bindings): { via: "none" } | { via: "workers-ai"; model: string } => (env.AI ? { via: "workers-ai", model: aiModel(env) } : { via: "none" });

export const NOT_BOUND = `Workers AI is not bound; deploy with ${AI_VAR}=1`;
export const RATE = { limit: 30, periodMs: 60_000 } as const;
export const DEFAULT_MAX_STEPS = 6;
export const MAX_STEPS_CEILING = 20;
/** how much of a tool's answer a step reports */
export const RESULT_SUMMARY = 500;

// --- the shapes Workers AI answers and takes (pinned to @cloudflare/workers-types 4.20260702.1 and ai-utils) -------
type Message = { role: string; content: string; name?: string };
type ToolCall = { name: string; arguments: Record<string, unknown> };
type AiOutput = { response?: string; tool_calls?: unknown[] } | string;
type AiTool = { type: "function"; function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } } };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** the tool list in Workers AI's OpenAI-style `tools` shape, from the MCP tool list */
export const aiToolsOf = (tools: Tool[]): AiTool[] =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: { type: "object", properties: isObject(t.inputSchema.properties) ? t.inputSchema.properties : {}, required: Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : [] } } }));

/** the calls a response carries, in the legacy `{ name, arguments }` shape or the OpenAI `{ function: { name, arguments } }` one */
export function toolCallsOf(output: AiOutput): ToolCall[] {
  if (!isObject(output) || !Array.isArray(output.tool_calls)) return [];
  const calls: ToolCall[] = [];
  for (const raw of output.tool_calls) {
    if (!isObject(raw)) continue;
    const fn = isObject(raw.function) ? raw.function : raw;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    let args: unknown = fn.arguments;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
    calls.push({ name, arguments: isObject(args) ? args : {} });
  }
  return calls;
}

const responseOf = (output: AiOutput): string => (typeof output === "string" ? output : typeof output.response === "string" ? output.response : "");

/** who the caller is, for the system prompt */
export function describeCaller(auth: AuthRecord | null | undefined): string {
  if (!auth) return "anonymous: nobody is signed in, so only the public API is reachable";
  if (auth.collection.name === "_superusers") return `a superuser (${String(auth.row.id)}): every collection and every write is reachable`;
  return `a signed-in record of the ${auth.collection.name} collection (id ${String(auth.row.id)}): what its own token may call is reachable`;
}

export const systemPrompt = (appName: string, auth: AuthRecord | null | undefined, toolCount: number) =>
  `You are the assistant of ${JSON.stringify(appName || "voidbase")}, a voidbase instance (a PocketBase-compatible backend of collections and records). ` +
  `The person asking is ${describeCaller(auth)}. ` +
  (toolCount ? `Use the tools for facts: they are this instance's own API as this caller may call it (${toolCount} tools), so list or get records before stating what they hold, and never invent an id, a field or a value. A tool's answer is the instance's answer; a non-2xx is a refusal to report, not to work around. ` : "") +
  `Answer briefly and plainly.`;

// --- the rate cap: per caller, in memory, per isolate ----------------------------------------------------------------
type Windows = Map<string, { start: number; count: number }>;
const callerKey = (c: Context<AppEnv>) => {
  const auth = c.get("auth");
  if (auth) return `${auth.collection.name}:${String(auth.row.id)}`;
  return `ip:${c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "anonymous"}`;
};
function allow(windows: Windows, key: string, now: number): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= RATE.periodMs) { windows.set(key, { start: now, count: 1 }); if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= RATE.periodMs) windows.delete(k); return true; }
  w.count++;
  return w.count <= RATE.limit;
}

// --- the route -------------------------------------------------------------------------------------------------------
export interface ChatRequest { messages: { role: string; content: string }[]; model?: string; tools?: boolean; maxSteps?: number; stream?: boolean }
export interface ChatStep { tool: string; arguments: Record<string, unknown>; result: string }
export interface ChatResponse { message: { role: "assistant"; content: string }; steps: ChatStep[]; model: string }

const ROLES = new Set(["user", "assistant", "system", "tool"]);
function parseChat(body: unknown): ChatRequest | string {
  if (!isObject(body)) return "The body must be a JSON object.";
  if (!Array.isArray(body.messages) || !body.messages.length) return "messages must be a non-empty array of { role, content }.";
  const messages: ChatRequest["messages"] = [];
  for (const m of body.messages) {
    if (!isObject(m) || typeof m.role !== "string" || !ROLES.has(m.role) || typeof m.content !== "string") return "Each message needs a role (user, assistant, system or tool) and a string content.";
    messages.push({ role: m.role, content: m.content });
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) return "model must be a Workers AI model name.";
  if (body.tools !== undefined && typeof body.tools !== "boolean") return "tools must be a boolean.";
  if (body.maxSteps !== undefined && (typeof body.maxSteps !== "number" || !Number.isInteger(body.maxSteps) || body.maxSteps < 0 || body.maxSteps > MAX_STEPS_CEILING)) return `maxSteps must be an integer from 0 to ${MAX_STEPS_CEILING}.`;
  if (body.stream === true) return "stream is not supported: Workers AI cannot stream a call that may answer with tool calls, so the answer is one JSON body.";
  return { messages, model: body.model as string | undefined, tools: body.tools as boolean | undefined, maxSteps: body.maxSteps as number | undefined };
}

function mountRoutes(app: Hono<AppEnv>, version: string, source: OpenApiSource, now: () => number) {
  const windows: Windows = new Map();
  app.post("/api/ai/chat", async (c: Context<AppEnv>) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.AI) return c.json({ message: NOT_BOUND }, 503);
    if (!allow(windows, callerKey(c), now())) { c.header("Retry-After", String(Math.ceil(RATE.periodMs / 1000))); return c.json({ message: `Too many requests: ${RATE.limit} per minute per caller.` }, 429); }
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ message: "The body is not JSON." }, 400); }
    const parsed = parseChat(body);
    if (typeof parsed === "string") return c.json({ message: parsed }, 400);
    const model = parsed.model?.trim() || aiModel(c.env);
    const useTools = parsed.tools ?? true;
    const maxSteps = parsed.maxSteps ?? DEFAULT_MAX_STEPS;
    // the caller's tools: the MCP list for this token, none when the request turned them off
    const doc: Document | null = useTools ? await documentFor(source, c, version) : null;
    const tools = doc ? toolsOf(doc) : [];
    const appName = (await source.appName(c.env).catch(() => "")).trim();
    const messages: Message[] = [{ role: "system", content: systemPrompt(appName, c.get("auth"), tools.length) }, ...parsed.messages];
    const aiTools = aiToolsOf(tools);
    const steps: ChatStep[] = [];
    let content = "";
    for (let step = 0; ; step++) {
      const output = (await c.env.AI.run(model, { messages, ...(aiTools.length ? { tools: aiTools } : {}) })) as AiOutput;
      content = responseOf(output);
      const calls = aiTools.length ? toolCallsOf(output) : [];
      if (!calls.length) break;
      if (step >= maxSteps) { content = content || `I stopped after ${maxSteps} tool calls without a final answer; ask again with a higher maxSteps or a narrower question.`; break; }
      for (const call of calls) {
        messages.push({ role: "assistant", content: JSON.stringify(call) });
        const tool = tools.find((t) => t.name === call.name);
        let result: string;
        if (!tool) result = JSON.stringify({ error: `There is no tool called ${JSON.stringify(call.name)} for this caller.` });
        else {
          try { result = (await runTool(app, c, doc!, tool, call.arguments)).text; }
          catch (err) { result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) }); }
        }
        messages.push({ role: "tool", name: call.name, content: result });
        steps.push({ tool: call.name, arguments: call.arguments, result: result.slice(0, RESULT_SUMMARY) });
      }
    }
    const answer: ChatResponse = { message: { role: "assistant", content }, steps, model };
    return c.json(answer);
  });
}

/** the plugin over a source of its own: tests hand in collections, a name and a clock without a database */
export const aiWith = (source: Partial<OpenApiSource> = {}, version: string = VERSION, now: () => number = Date.now): Plugin => ({
  manifest: { name: "ai", version: "0.1.0", tier: "official", voidbase: "*" },
  apply(ctx: Kernel) { mountRoutes(ctx.app, version, { ...defaultSource, ...source }, now); },
});

/** the shipped plugin: the instance's own collections and settings */
export const ai: Plugin = aiWith();
