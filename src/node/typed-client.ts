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
// `--watch` (watchTypes, at the end) polls the same document and rewrites the file when the collections change; what
// is not here is the client plugin surface the roadmap names beside this. The generator is pure (generateTypes), so
// the one-shot command, the watch and the tests all share it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

/** a token the instance stopped accepting: a run with credentials signs in again, a run given a raw --token cannot */
export class TokenExpired extends Error { constructor(message: string) { super(message); this.name = "TokenExpired"; } }

/** a sign-in that lasts: the document, again and again, on one token minted when there is none and when one expires */
export interface DocumentSession { document(): Promise<OpenApiDocument> }

/** the session behind both the one-shot command and the watch: one GET per document, a sign-in only when needed */
export function openSession(opts: FetchOptions): DocumentSession {
  const f = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/$/, "");
  const canSignIn = !!(opts.email && opts.password);
  let token = opts.token;
  const signIn = async (): Promise<string> => {
    if (!canSignIn) throw new Error("a superuser is needed: --token <token>, or --email and --password");
    const r = await f(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: opts.email, password: opts.password }) });
    if (!r.ok) throw new Error(`sign-in as ${opts.email} at ${base} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const minted = String(((await r.json()) as { token?: string }).token ?? "");
    if (!minted) throw new Error(`sign-in at ${base} answered no token`);
    return minted;
  };
  const get = () => f(`${base}/api/openapi.json`, { headers: { authorization: token ?? "" } });
  return {
    async document(): Promise<OpenApiDocument> {
      if (!token) token = await signIn();
      let r = await get();
      if (r.status === 401) { // a superuser token expires; a long watch mints another rather than stopping
        if (!canSignIn) throw new TokenExpired(`${base} no longer accepts the token (401): give --email and --password instead, and a long run signs in again by itself`);
        token = await signIn();
        r = await get();
      }
      if (!r.ok) throw new Error(`GET ${base}/api/openapi.json failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return checkDocument((await r.json()) as OpenApiDocument, base);
    },
  };
}

/** the document as the superuser sees it: every collection, which is what the client has to know about */
export async function fetchDocument(opts: FetchOptions): Promise<OpenApiDocument> { return openSession(opts).document(); }

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

// --- watching ---------------------------------------------------------------------------------------------------------
// `voidbase types --watch`: the file written once, then the same document fetched again every few seconds and the file
// rewritten only when it would come out different. The comparison is the generated text against what is on disk, which
// is the cheapest correct thing here: it ignores every part of the document the types do not express (the paths, the
// examples, the instance's own version), so a poll that changes nothing writes nothing and prints nothing, and a poll
// that does is compared to the file a build or an editor is actually reading.

/** how long a watch waits between polls when nothing is failing; --interval sets it, in seconds */
export const WATCH_INTERVAL_MS = 5000;
/** the longest a run of failed polls backs off to: an instance that is restarting is worth waiting for, quietly */
export const WATCH_MAX_BACKOFF_MS = 30_000;

export interface WatchOptions extends FetchOptions {
  /** the file to write, as --out gives it */
  out: string;
  /** the header's "generated from": the instance's document URL */
  source: string;
  /** the header's "to regenerate" line */
  regenerate: string;
  /** milliseconds between polls (default WATCH_INTERVAL_MS) */
  intervalMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}
/** what the caller's Ctrl-C handler reads: how often the file was rewritten after the first write */
export interface WatchRun { rewrites: number }

/** every collection of a document with its field names: what the one-line summary compares */
export function collectionFields(doc: OpenApiDocument): Map<string, string[]> {
  return new Map(collectionsOf(doc).map((c) => [c.name, Object.keys(c.schema.properties ?? {})]));
}

/** one line for what changed between two documents: which collections came, went, or changed their fields */
export function summarizeChanges(before: OpenApiDocument, after: OpenApiDocument): string {
  const was = collectionFields(before), now = collectionFields(after);
  const parts: string[] = [];
  for (const name of now.keys()) if (!was.has(name)) parts.push(`added ${name}`);
  for (const name of was.keys()) if (!now.has(name)) parts.push(`removed ${name}`);
  for (const [name, fields] of now) {
    const old = was.get(name);
    if (!old) continue;
    const gained = fields.filter((f) => !old.includes(f)), lost = old.filter((f) => !fields.includes(f));
    if (gained.length || lost.length) parts.push(`changed ${name} (${[...gained.map((f) => `+${f}`), ...lost.map((f) => `-${f}`)].join(", ")})`);
  }
  if (!parts.length) return "the same collections, with a different shape"; // a field's type or its help text
  return parts.length > 5 ? `${parts.slice(0, 5).join("; ")}; and ${parts.length - 5} more` : parts.join("; ");
}

/** Writes the file, then polls until the process is interrupted: never returns, and never exits on a failed poll. */
export async function watchTypes(opts: WatchOptions, run: WatchRun = { rewrites: 0 }): Promise<never> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const interval = opts.intervalMs ?? WATCH_INTERVAL_MS;
  const file = resolve(opts.out);
  const session = openSession(opts);
  const generate = (doc: OpenApiDocument) => generateTypes(doc, { source: opts.source, regenerate: opts.regenerate });
  const onDisk = (): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  const write = (text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

  let doc = await session.document();
  let text = generate(doc);
  const n = collectionsOf(doc).length, count = `${n} collection${n === 1 ? "" : "s"}`;
  if (onDisk() === text) log(`${opts.out} is already what ${opts.source} describes: ${count}`);
  else { write(text); log(`wrote ${opts.out}: ${count} from ${opts.source}`); }
  log(`watching ${opts.source} every ${Math.round(interval / 100) / 10}s; Ctrl-C to stop`);

  for (let failures = 0; ; ) {
    await Bun.sleep(failures ? Math.min(interval * 2 ** failures, WATCH_MAX_BACKOFF_MS) : interval);
    let next: OpenApiDocument;
    try {
      next = await session.document();
    } catch (err) {
      if (err instanceof TokenExpired) throw err; // a raw token cannot be renewed: the caller says so and stops
      if (!failures) warn(`poll of ${opts.source} failed: ${err instanceof Error ? err.message : String(err)} (still trying)`);
      failures++;
      continue;
    }
    if (failures) { log(`${opts.source} is answering again`); failures = 0; }
    const generated = generate(next);
    const changed = generated !== text;
    if (!changed && onDisk() === text) continue; // an unchanged poll: nothing written, nothing said
    const what = changed ? summarizeChanges(doc, next) : `${opts.out} no longer matched the instance`;
    doc = next; text = generated;
    write(text); run.rewrites++;
    log(`rewrote ${opts.out}: ${what}`);
  }
}
