// `voidbase types`: a typed client for the PocketBase JS SDK, generated from the instance's own OpenAPI description.
//
// The openapi plugin (src/server/plugins/openapi.ts) already describes every collection from the same definitions the
// server enforces, so the client is generated from that document rather than from a second reading of the
// collections: the client and the documentation cannot disagree about what the API is. The document is fetched as a
// superuser, the one scope that describes every collection, and turned into one TypeScript file: an interface per
// collection, a map of collection names to those interfaces, and a `TypedPocketBase` type that narrows the SDK's
// `collection(name)` to the right record type. The file declares the little it needs of the SDK's shape itself, so
// it depends on nothing this package does not ship; the SDK is whatever the project installed.
//
// What is not here: `--watch` (the build refreshing the file on its own) and the client plugin surface the roadmap
// names beside this. The generator is pure (generateTypes) so the command and the tests share it.

/** the parts of an OpenAPI document the generator reads */
export interface OpenApiDocument {
  info?: { title?: string; version?: string; "x-voidbase"?: { scope?: string; collection?: string } };
  components?: { schemas?: Record<string, JsonSchema> };
  [key: string]: unknown;
}
/** a JSON schema as the openapi plugin writes them */
export interface JsonSchema {
  type?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  readOnly?: boolean;
  $ref?: string;
  "x-collection"?: string;
  [key: string]: unknown;
}

// --- names -----------------------------------------------------------------------------------------------------------
/** `_superusers` -> `Superusers`, `blog_posts` -> `BlogPosts`, `2fa-codes` -> `_2faCodes`: a TypeScript identifier */
export function pascal(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return /^[0-9]/.test(out) ? `_${out}` : out || "_";
}
const isIdentifier = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
/** a property or map key, quoted when it has to be */
const key = (s: string) => (isIdentifier(s) ? s : JSON.stringify(s));
const literal = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

// --- one collection ------------------------------------------------------------------------------------------------------
/** a collection's record schema in the document: the one whose collectionName is an enum of its name */
export interface CollectionSchema { name: string; interfaceName: string; schema: JsonSchema }

/** the collections the document describes, in the document's order, with unique interface names */
export function collectionsOf(doc: OpenApiDocument): CollectionSchema[] {
  const out: CollectionSchema[] = [];
  const taken = new Set<string>();
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    const tag = schema.properties?.collectionName?.enum;
    if (schema.type !== "object" || !Array.isArray(tag) || tag[0] !== name) continue;
    let interfaceName = `${pascal(name)}Record`;
    for (let n = 2; taken.has(interfaceName); n++) interfaceName = `${pascal(name)}${n}Record`;
    taken.add(interfaceName);
    out.push({ name, interfaceName, schema });
  }
  return out;
}

/** the TypeScript type of one JSON schema, as the record answers it */
export function typeOf(schema: JsonSchema, byName: Map<string, CollectionSchema>): string {
  if (schema.$ref) { const target = byName.get(schema.$ref.replace(/^#\/components\/schemas\//, "")); return target ? target.interfaceName : "unknown"; }
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.map(literal).join(" | ");
  switch (schema.type) {
    case "string": return "string";
    case "number": case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": { const item = schema.items ? typeOf(schema.items, byName) : "unknown"; return item.includes(" | ") ? `(${item})[]` : `${item}[]`; }
    case "object": {
      if (!schema.properties) return "Record<string, unknown>";
      const required = new Set(schema.required ?? []);
      const members = Object.entries(schema.properties).map(([k, v]) => `${key(k)}${required.has(k) ? "" : "?"}: ${typeOf(v, byName)}`);
      return `{ ${members.join("; ")} }`;
    }
    default: return "unknown"; // a json field: the document says "any JSON value"
  }
}

/** the expand type of a record: each relation field to its target's interface when the document names one */
function expandOf(c: CollectionSchema, byName: Map<string, CollectionSchema>): string {
  const members: string[] = [];
  for (const [name, s] of Object.entries(c.schema.properties ?? {})) {
    const inner = s.type === "array" && s.items ? s.items : s;
    const target = inner["x-collection"];
    if (typeof target !== "string") continue;
    const record = byName.get(target)?.interfaceName ?? "Record<string, unknown>";
    members.push(`${key(name)}?: ${s.type === "array" ? `${record}[]` : record}`);
  }
  return members.length ? `{ ${members.join("; ")} }` : "Record<string, unknown>";
}

function interfaceOf(c: CollectionSchema, byName: Map<string, CollectionSchema>): string {
  const required = new Set(c.schema.required ?? []);
  const lines = [`/** a record of the ${c.name} collection */`, `export interface ${c.interfaceName} {`];
  for (const [name, s] of Object.entries(c.schema.properties ?? {})) {
    if (name === "expand") continue;
    if (s.description && !/^(id of a |15-character id$)/.test(s.description)) lines.push(`  /** ${s.description.replace(/\*\//g, "* /")} */`);
    lines.push(`  ${key(name)}${required.has(name) ? "" : "?"}: ${typeOf(s, byName)};`);
  }
  lines.push(`  expand?: ${expandOf(c, byName)};`, "}");
  return lines.join("\n");
}

// --- the file --------------------------------------------------------------------------------------------------------------
// the SDK's shape, the part these types touch: declared here so the generated file imports nothing
const SDK = `// --- the SDK's shape, the part these types touch. Declared here rather than imported so this file depends on nothing;
// the PocketBase JS SDK's own RecordService and Client satisfy these structurally.

/** a record of a collection this file does not know */
export interface AnyRecord { id: string; collectionId: string; collectionName: string; expand?: Record<string, unknown>; [field: string]: unknown }
/** what create and update send: the record's own fields, any of them, plus what the collection accepts besides
 * (password and passwordConfirm on an auth collection, for instance) */
export type RecordBody<M> = Partial<Omit<M, "collectionId" | "collectionName" | "expand">> & { [field: string]: unknown };
/** a page of records, as GET /api/collections/{name}/records answers */
export interface ListResult<M> { page: number; perPage: number; totalItems: number; totalPages: number; items: M[] }
export interface RecordAuthResponse<M> { token: string; record: M; meta?: unknown }
export interface RecordSubscription<M> { action: string; record: M }
export interface RecordOptions { expand?: string; fields?: string; requestKey?: string | null; headers?: Record<string, string>; query?: Record<string, unknown>; signal?: AbortSignal; [option: string]: unknown }
export interface RecordListOptions extends RecordOptions { page?: number; perPage?: number; sort?: string; filter?: string; skipTotal?: boolean }
export interface RecordFullListOptions extends RecordListOptions { batch?: number }

/** the SDK's RecordService with its record type fixed */
export interface RecordService<M> {
  readonly collectionIdOrName: string;
  getList(page?: number, perPage?: number, options?: RecordListOptions): Promise<ListResult<M>>;
  getFullList(options?: RecordFullListOptions): Promise<M[]>;
  getFullList(batch?: number, options?: RecordListOptions): Promise<M[]>;
  getFirstListItem(filter: string, options?: RecordListOptions): Promise<M>;
  getOne(id: string, options?: RecordOptions): Promise<M>;
  create(body?: RecordBody<M> | FormData, options?: RecordOptions): Promise<M>;
  update(id: string, body?: RecordBody<M> | FormData, options?: RecordOptions): Promise<M>;
  delete(id: string, options?: RecordOptions): Promise<boolean>;
  subscribe(topic: string, callback: (data: RecordSubscription<M>) => void, options?: RecordOptions): Promise<() => Promise<void>>;
  unsubscribe(topic?: string): Promise<void>;
  authWithPassword(usernameOrEmail: string, password: string, options?: RecordOptions): Promise<RecordAuthResponse<M>>;
  authRefresh(options?: RecordOptions): Promise<RecordAuthResponse<M>>;
  requestPasswordReset(email: string, options?: RecordOptions): Promise<boolean>;
  requestVerification(email: string, options?: RecordOptions): Promise<boolean>;
}

/** the SDK's Client, the members that do not depend on a collection */
export interface BaseClient {
  baseURL: string;
  authStore: { token: string; record: AnyRecord | null; isValid: boolean; isSuperuser: boolean; save(token: string, record?: AnyRecord | null): void; clear(): void };
  filter(raw: string, params?: Record<string, unknown>): string;
  send<T = unknown>(path: string, options: Record<string, unknown>): Promise<T>;
}

/** the collection method, narrowed: a known name answers its record type, any other name an untyped record */
export interface TypedCollectionAccess {
  collection<K extends keyof Collections>(name: K): RecordService<Collections[K]>;
  collection(name: string): RecordService<AnyRecord>;
}

/** the PocketBase SDK client with collection() narrowed to this instance's collections:
 *   const pb = new PocketBase(url) as TypedPocketBase;             the members declared above
 *   const pb = new PocketBase(url) as TypedPocketBase<PocketBase>; everything the SDK's class has
 */
export type TypedPocketBase<Client = BaseClient> = Omit<Client, "collection"> & TypedCollectionAccess;
`;

export interface GenerateOptions {
  /** where the document came from, for the header: the instance's URL or the file */
  source: string;
  /** the command that regenerates the file */
  regenerate: string;
}

/** the whole generated file for one document */
export function generateTypes(doc: OpenApiDocument, opts: GenerateOptions): string {
  const collections = collectionsOf(doc);
  const byName = new Map(collections.map((c) => [c.name, c]));
  const title = doc.info?.title ?? "voidbase";
  const version = doc.info?.version ? ` (voidbase ${doc.info.version})` : "";
  const header = [
    `// Generated by voidbase types from ${opts.source}: the API of "${title}"${version}, ${collections.length} collection${collections.length === 1 ? "" : "s"}.`,
    "// Do not edit by hand: the next generation overwrites it. To regenerate after the collections change:",
    `//   ${opts.regenerate}`,
    "// The types come from the instance's own OpenAPI description (GET /api/openapi.json as a superuser), which the",
    "// server builds from the same collection definitions it enforces, so this file and /api/docs cannot disagree.",
  ];
  const interfaces = collections.map((c) => interfaceOf(c, byName));
  const map = ["/** every collection of the instance, by name */", "export interface Collections {", ...collections.map((c) => `  ${key(c.name)}: ${c.interfaceName};`), "}"];
  return [header.join("\n"), ...interfaces, map.join("\n"), SDK.trimEnd()].join("\n\n") + "\n";
}

// --- getting the document ----------------------------------------------------------------------------------------------
export interface FetchOptions {
  /** the instance, e.g. http://127.0.0.1:8090 */
  url: string;
  /** a superuser token; without one, email and password sign in through _superusers/auth-with-password */
  token?: string;
  email?: string;
  password?: string;
  fetch?: typeof fetch;
}

/** the document as the superuser sees it: every collection, which is what the client has to know about */
export async function fetchDocument(opts: FetchOptions): Promise<OpenApiDocument> {
  const f = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/$/, "");
  let token = opts.token;
  if (!token) {
    if (!opts.email || !opts.password) throw new Error("a superuser is needed: --token <token>, or --email and --password");
    const r = await f(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: opts.email, password: opts.password }) });
    if (!r.ok) throw new Error(`sign-in as ${opts.email} at ${base} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    token = String(((await r.json()) as { token?: string }).token ?? "");
    if (!token) throw new Error(`sign-in at ${base} answered no token`);
  }
  const r = await f(`${base}/api/openapi.json`, { headers: { authorization: token } });
  if (!r.ok) throw new Error(`GET ${base}/api/openapi.json failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const doc = (await r.json()) as OpenApiDocument;
  return checkDocument(doc, base);
}

/** the document must be an OpenAPI document of a voidbase instance, in the superuser's scope */
export function checkDocument(doc: OpenApiDocument, source: string): OpenApiDocument {
  if (!doc || typeof doc !== "object" || !doc.components?.schemas) throw new Error(`${source} is not an OpenAPI document with components.schemas`);
  const scope = doc.info?.["x-voidbase"]?.scope;
  if (scope !== "superuser") throw new Error(`${source} describes the API as ${scope ?? "an unknown caller"} sees it, not as a superuser: only the superuser's document has every collection`);
  return doc;
}

/** a saved document, for tests and offline use (`--json <file>`) */
export async function readDocument(path: string): Promise<OpenApiDocument> {
  let doc: OpenApiDocument;
  try { doc = JSON.parse(await Bun.file(path).text()) as OpenApiDocument; } catch (err) { throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`); }
  return checkDocument(doc, path);
}
