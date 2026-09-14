import type { AuthRecord, Bindings, Collection, Field } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
/** where the document's facts come from; the defaults read the instance, a test hands in what it likes */
export interface OpenApiSource {
    /** the collections this instance has */
    collections(env: Bindings): Promise<Collection[]>;
    /** the instance's name from its settings, or "" when it has none */
    appName(env: Bindings): Promise<string>;
}
export declare const SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
export type Caller = {
    kind: "anonymous";
} | {
    kind: "user" | "superuser";
    collection: string;
};
export declare const callerOf: (auth: AuthRecord | null | undefined) => Caller;
type Schema = Record<string, unknown>;
/** the JSON schema of one field's value, as a record answers it */
export declare function fieldSchema(f: Field, byId: Map<string, Collection>): Schema;
export interface DocumentInput {
    collections: Collection[];
    caller: Caller;
    title: string;
    origin: string;
    version: string;
    /** routes the instance's own code added: pb_hooks and a project's entry file (core's hookRouteDocs) */
    routes?: {
        method: string;
        path: string;
        superuser: boolean;
        response?: Schema;
    }[];
    /**
     * how a rule was decided for this caller before any record is in question (core's decideRule): "yes" or "no" shows
     * or hides what it gates; "per-record" or nothing leaves it to whether the caller is signed in
     */
    verdict?: (collection: string, rule: string) => "yes" | "no" | "per-record" | undefined;
    /** routes plugins added, by method and path; described to a superuser, who may call them all */
    pluginRoutes?: {
        method: string;
        path: string;
    }[];
}
/** the OpenAPI 3.1 document for these collections as this caller sees them */
export declare function buildDocument(input: DocumentInput): Record<string, unknown>;
/** the plugin over a source of its own: tests hand in collections and a name without a database */
export declare const openapiWith: (source?: Partial<OpenApiSource>, version?: string) => Omit<Plugin, "manifest">;
/** the shipped plugin: the instance's own collections and settings */
declare const openapi: Omit<Plugin, "manifest">;
export default openapi;
export {};
