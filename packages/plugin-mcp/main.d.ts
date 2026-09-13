import type { Context, Hono } from "hono";
import type { AppEnv } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
import { type OpenApiSource } from "@voidbase-cloud/voidbase/plugins/openapi";
/** the instance's own collections and settings: what the shipped mcp and ai plugins read */
export declare const defaultSource: OpenApiSource;
/** the protocol versions this server knows; the first is what it proposes */
export declare const PROTOCOL_VERSIONS: readonly ["2025-03-26", "2025-06-18", "2024-11-05"];
export declare const STATELESS_MESSAGE = "This MCP server is stateless: POST one JSON-RPC request at a time to /api/mcp with your token in the Authorization header; there is no session to open, resume or close.";
export type Schema = Record<string, unknown>;
interface Parameter {
    name: string;
    in: "query" | "path";
    description?: string;
    required?: boolean;
    schema?: Schema;
}
interface Operation {
    summary?: string;
    description?: string;
    parameters?: Parameter[];
    requestBody?: {
        content?: Record<string, {
            schema?: Schema;
        }>;
    };
}
export type Document = {
    paths: Record<string, Record<string, Operation>>;
    components: {
        schemas: Record<string, Schema>;
    };
};
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
/** the tools this caller's document yields, in the document's order */
export declare function toolsOf(doc: Document): Tool[];
/** the request a tool call becomes, against the instance's own routes */
export declare function requestOf(tool: Tool, args: Record<string, unknown>, base: string, authorization: string): {
    url: string;
    init: RequestInit;
};
/** the caller's document, from the source: the routes this request's token may call (the ai plugin asks the same) */
export declare function documentFor(source: OpenApiSource, c: Context<AppEnv>, version: string): Promise<Document>;
/**
 * Run one tool the way tools/call does: voidbase_describe answers the document, everything else calls the
 * instance's own route in process on the app the plugin is mounted on, the caller's token forwarded, so the rules
 * judge the call the way they judge any request. The answer is the route's text and whether it was a non-2xx;
 * a missing argument throws (an RpcError for the MCP handler, an Error for anyone else).
 */
export declare function runTool(app: Hono<AppEnv>, c: Context<AppEnv>, doc: Document, tool: Tool, args: Record<string, unknown>): Promise<{
    text: string;
    isError: boolean;
}>;
/** the plugin over a source of its own: tests hand in collections and a name without a database */
export declare const mcpWith: (source?: Partial<OpenApiSource>, version?: string) => Omit<Plugin, "manifest">;
/** what mcp@1 hands a plugin that builds on it */
export interface McpTools {
    documentFor: typeof documentFor;
    runTool: typeof runTool;
    toolsOf: typeof toolsOf;
}
/** the shipped plugin: the instance's own collections and settings */
declare const mcp: Omit<Plugin, "manifest">;
export default mcp;
export {};
