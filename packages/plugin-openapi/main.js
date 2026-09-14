import { decideRule, hookRouteDocs, isAuth, isMultiple, isSuperuser, listCollections, loadSettings, VERSION, isView } from "@voidbase-cloud/voidbase/sdk";
import { serve } from "@voidbase-cloud/voidbase/kernel";
const defaultSource = {
  collections: (env) => listCollections(env.DB),
  appName: async (env) => String((await loadSettings(env.DB)).meta.appName ?? ""),
};
export const SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
export const callerOf = (auth) => !auth ? { kind: "anonymous" } : { kind: isSuperuser(auth) ? "superuser" : "user", collection: auth.collection.name };
const accessOf = (rule) => (rule === null ? "superuser" : rule.trim() === "" ? "public" : "signed-in");
const may = (caller, access) => access === "public" || caller.kind === "superuser" || (access === "signed-in" && caller.kind === "user");
/**
 * whether this caller is shown what a rule gates: a rule decided for the caller (a vendor's `@request.auth.vendor = "acme"`)
 * is shown or not as it decided; a rule that reads the record or the call is shown to anyone signed in, as before
 */
const admits = (caller, rule, verdict) => caller.kind === "superuser" || rule === null || rule.trim() === "" || verdict === undefined || verdict === "per-record" ? may(caller, accessOf(rule)) : verdict === "yes";
const ruleNote = (rule) => rule === null ? "Superusers only: the rule is locked." : rule.trim() === "" ? "Public: anyone may call this." : `Gated by the rule \`${rule.trim()}\`, judged against the signed-in record and the request.`;
const str = (extra = {}) => ({ type: "string", ...extra });
const many = (f, item) => (isMultiple(f) ? { type: "array", items: item, ...(Number(f.maxSelect) > 0 ? { maxItems: Number(f.maxSelect) } : {}) } : item);
/** the JSON schema of one field's value, as a record answers it */
export function fieldSchema(f, byId) {
  const help = f.help ? { description: String(f.help) } : {};
  switch (f.type) {
    case "text": return str({ ...help, ...(f.primaryKey ? { description: "15-character id" } : {}) });
    case "editor": return str({ description: "HTML", ...help });
    case "email": return str({ format: "email", ...help });
    case "url": return str({ format: "uri", ...help });
    case "date": return str({ description: "YYYY-MM-DD HH:mm:ss.SSSZ, empty when unset", ...help });
    case "autodate": return str({ readOnly: true, description: "set by the instance", ...help });
    case "number": return { type: f.onlyInt ? "integer" : "number", ...(f.min != null ? { minimum: Number(f.min) } : {}), ...(f.max != null ? { maximum: Number(f.max) } : {}), ...help };
    case "bool": return { type: "boolean", ...help };
    case "select": return many(f, str({ enum: Array.isArray(f.values) ? f.values : [], ...help }));
    case "json": return { description: "any JSON value", ...help };
    case "file": return many(f, str({ description: "file name; send the file itself as multipart/form-data", ...help }));
    case "relation": {
      const target = byId.get(String(f.collectionId ?? ""));
      return many(f, str({ description: `id of a ${target ? target.name : "related"} record`, ...(target ? { "x-collection": target.name } : {}), ...help }));
    }
    case "password": return str({ format: "password", writeOnly: true, ...help });
    case "geoPoint": return { type: "object", properties: { lon: { type: "number" }, lat: { type: "number" } }, required: ["lon", "lat"], ...help };
  }
}
const fields = (c) => c.fields;
const hasField = (c, name) => fields(c).some((f) => f.name === name);
/** what a record of the collection looks like in a response: hidden fields dropped, ids and names added. Every
 * field is answered, zero-valued when unset, so all of them are required; only expand comes when asked for. A
 * relation names its target in x-collection, which is what the typed client (voidbase types) reads. */
function recordSchema(c, byId) {
  const properties = { id: str({ description: "15-character id" }), collectionId: str({ readOnly: true }), collectionName: str({ readOnly: true, enum: [c.name] }) };
  for (const f of fields(c)) {
    if (f.hidden || f.name === "id")
      continue;
    properties[f.name] = fieldSchema(f, byId);
  }
  for (const name of ["created", "updated"])
    if (!hasField(c, name))
      properties[name] = str({ readOnly: true, description: "set by the instance" });
  const required = Object.keys(properties);
  properties.expand = { type: "object", description: "the related records named by ?expand", additionalProperties: true };
  return { type: "object", properties, required };
}
/** what a request may send to create or update a record of the collection */
function bodySchema(c, byId, mode) {
  const properties = {};
  const required = [];
  if (mode === "create")
    properties.id = str({ description: "15-character id, generated when omitted", pattern: "^[a-z0-9]{15}$" });
  for (const f of fields(c)) {
    if (f.name === "id" || f.type === "autodate")
      continue;
    if (f.hidden && f.type !== "password")
      continue;
    properties[f.name] = fieldSchema(f, byId);
    if (f.required && mode === "create" && f.type !== "password")
      required.push(f.name);
  }
  if (isAuth(c)) {
    properties.password = str({ format: "password", writeOnly: true });
    properties.passwordConfirm = str({ format: "password", writeOnly: true });
    if (mode === "create")
      required.push("password", "passwordConfirm");
    else
      properties.oldPassword = str({ format: "password", writeOnly: true, description: "required when password changes" });
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}
const listSchema = (c) => ({
  type: "object",
  properties: { page: { type: "integer" }, perPage: { type: "integer" }, totalItems: { type: "integer", description: "-1 when skipTotal was asked for" }, totalPages: { type: "integer" }, items: { type: "array", items: { $ref: `#/components/schemas/${c.name}` } } },
  required: ["page", "perPage", "totalItems", "totalPages", "items"],
});
// --- the operations ------------------------------------------------------------------------------------------------
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ content: { "application/json": { schema } } });
const errors = { "400": { description: "Bad request: the body failed validation, or the rule refused the request", ...json(ref("Error")) }, "401": { description: "No usable token", ...json(ref("Error")) }, "403": { description: "The token may not do this", ...json(ref("Error")) }, "404": { description: "Not found", ...json(ref("Error")) } };
const query = (name, description, schema = { type: "string" }) => ({ name, in: "query", description, schema });
const path = (name, description) => ({ name, in: "path", required: true, description, schema: { type: "string" } });
const LIST_QUERY = [
  query("page", "1-based page", { type: "integer", minimum: 1, default: 1 }),
  query("perPage", "records per page", { type: "integer", minimum: 1, maximum: 1000, default: 30 }),
  query("sort", "comma-separated fields, - for descending, e.g. -created,title"),
  query("filter", "PocketBase filter expression, e.g. status = \"published\" && views > 10"),
  query("expand", "comma-separated relation fields to embed, dots for nesting"),
  query("fields", "comma-separated fields to keep in the answer"),
  query("skipTotal", "1 to skip counting: totalItems and totalPages answer -1", { type: "boolean" }),
];
const VIEW_QUERY = [query("expand", "comma-separated relation fields to embed"), query("fields", "comma-separated fields to keep in the answer")];
const canUpdateSchema = {
  type: "object",
  properties: {
    allowed: { type: "boolean", description: "whether the update rule admits this token for this record" },
    fields: { type: "array", items: str(), description: "the field names a PATCH would take; empty when allowed is false" },
    reason: str({ nullable: true, description: "why not, when allowed is false; null otherwise" }),
  },
  required: ["allowed", "fields", "reason"],
};
const op = (tag, summary, description, extra) => ({ tags: [tag], summary, description, ...extra });
function collectionPaths(c, caller, byId, paths, verdict = () => undefined) {
  const base = `/api/collections/${c.name}/records`;
  const add = (p, method, o) => { (paths[p] ??= {})[method] = o; };
  const gated = (rule, method, p, summary, extra) => {
    if (!admits(caller, rule, verdict(c.name, rule)))
      return;
    add(p, method, op(c.name, summary, ruleNote(rule), extra));
  };
  gated(c.listRule, "get", base, `List ${c.name} records`, { parameters: LIST_QUERY, responses: { "200": { description: "A page of records", ...json(ref(`${c.name}List`)) }, "400": errors["400"], "403": errors["403"] } });
  gated(c.viewRule, "get", `${base}/{id}`, `View one ${c.name} record`, { parameters: [path("id", "the record id"), ...VIEW_QUERY], responses: { "200": { description: "The record", ...json(ref(c.name)) }, "403": errors["403"], "404": errors["404"] } });
  if (!isView(c)) {
    gated(c.createRule, "post", base, `Create a ${c.name} record`, { parameters: VIEW_QUERY, requestBody: { required: true, content: { "application/json": { schema: ref(`${c.name}Create`) }, "multipart/form-data": { schema: ref(`${c.name}Create`) } } }, responses: { "200": { description: "The created record", ...json(ref(c.name)) }, "400": errors["400"], "403": errors["403"] } });
    gated(c.updateRule, "patch", `${base}/{id}`, `Update a ${c.name} record`, { parameters: [path("id", "the record id"), ...VIEW_QUERY], requestBody: { required: true, content: { "application/json": { schema: ref(`${c.name}Update`) }, "multipart/form-data": { schema: ref(`${c.name}Update`) } } }, responses: { "200": { description: "The updated record", ...json(ref(c.name)) }, "400": errors["400"], "403": errors["403"], "404": errors["404"] } });
    gated(c.deleteRule, "delete", `${base}/{id}`, `Delete a ${c.name} record`, { parameters: [path("id", "the record id")], responses: { "204": { description: "Deleted" }, "403": errors["403"], "404": errors["404"] } });
    // voidbase's own: gated by the view rule, since that is the access it needs, and it never quotes the update
    // rule back (a caller who may not call the PATCH is not shown the PATCH either)
    if (admits(caller, c.viewRule, verdict(c.name, c.viewRule))) {
      add(`${base}/{id}/can-update`, "get", op(c.name, `May I edit this ${c.name} record`, `${ruleNote(c.viewRule)} Answers whether a PATCH of this record with this token would be allowed and which fields it would take, writing nothing.`, {
        parameters: [path("id", "the record id")],
        responses: { "200": { description: "The verdict", ...json(canUpdateSchema) }, "403": errors["403"], "404": errors["404"] },
      }));
    }
  }
  if (isAuth(c)) {
    const authResponse = { "200": { description: "A token and the record it belongs to", ...json(ref(`${c.name}Auth`)) }, "400": errors["400"] };
    add(`/api/collections/${c.name}/auth-with-password`, "post", op(c.name, `Sign in to ${c.name} with a password`, "Public: anyone may try. The answer's token goes in the Authorization header of what follows.", { security: [], requestBody: { required: true, ...json({ type: "object", properties: { identity: str({ description: "email, or another identity field the collection allows" }), password: str({ format: "password" }) }, required: ["identity", "password"] }) }, responses: authResponse }));
    add(`/api/collections/${c.name}/auth-methods`, "get", op(c.name, `How ${c.name} may sign in`, "Public: which of password, OAuth2, OTP and MFA this collection has turned on.", { security: [], responses: { "200": { description: "The methods", ...json({ type: "object", properties: { password: { type: "object", additionalProperties: true }, oauth2: { type: "object", additionalProperties: true }, mfa: { type: "object", additionalProperties: true }, otp: { type: "object", additionalProperties: true } } }) } } }));
    // a token refreshes in its own collection: the caller's, and for a superuser every collection, since the
    // document is then the whole map
    if (caller.kind === "superuser" || (caller.kind === "user" && caller.collection === c.name)) {
      add(`/api/collections/${c.name}/auth-refresh`, "post", op(c.name, `Refresh a ${c.name} token`, `Needs a valid ${c.name} token; answers a fresh one for the same record.`, { responses: { ...authResponse, "401": errors["401"] } }));
    }
  }
}
function superuserPaths(paths) {
  const tag = "system";
  const add = (p, method, o) => { (paths[p] ??= {})[method] = o; };
  const object = (description) => ({ description, ...json({ type: "object", additionalProperties: true }) });
  const collectionBody = { required: true, ...json({ type: "object", description: "a collection in PocketBase's JSON: name, type, fields, indexes, the five rules and the type's options", additionalProperties: true }) };
  add("/api/collections", "get", op(tag, "List collections", "Superusers only.", { parameters: [query("page", "1-based page", { type: "integer" }), query("perPage", "collections per page", { type: "integer" }), query("sort", "name, type, system, created, updated, id"), query("filter", "over name, type, system, created, updated, id")], responses: { "200": object("A page of collections"), "401": errors["401"], "403": errors["403"] } }));
  add("/api/collections", "post", op(tag, "Create a collection", "Superusers only. The table is created with it.", { requestBody: collectionBody, responses: { "200": object("The collection"), "400": errors["400"], "403": errors["403"] } }));
  add("/api/collections/{collection}", "get", op(tag, "View a collection", "Superusers only.", { parameters: [path("collection", "id or name")], responses: { "200": object("The collection"), "403": errors["403"], "404": errors["404"] } }));
  add("/api/collections/{collection}", "patch", op(tag, "Update a collection", "Superusers only. Fields added, renamed and removed change the table.", { parameters: [path("collection", "id or name")], requestBody: collectionBody, responses: { "200": object("The collection"), "400": errors["400"], "403": errors["403"], "404": errors["404"] } }));
  add("/api/collections/{collection}", "delete", op(tag, "Delete a collection", "Superusers only. The table and its records go with it.", { parameters: [path("collection", "id or name")], responses: { "204": { description: "Deleted" }, "403": errors["403"], "404": errors["404"] } }));
  add("/api/settings", "get", op(tag, "Read the settings", "Superusers only. Secrets are stored but never returned.", { responses: { "200": object("The settings"), "401": errors["401"], "403": errors["403"] } }));
  add("/api/settings", "patch", op(tag, "Change the settings", "Superusers only. A partial object is merged over what is stored.", { requestBody: { required: true, ...json({ type: "object", additionalProperties: true }) }, responses: { "200": object("The settings"), "400": errors["400"], "403": errors["403"] } }));
  add("/api/logs", "get", op(tag, "List request logs", "Superusers only.", { parameters: [query("page", "1-based page", { type: "integer" }), query("perPage", "logs per page", { type: "integer" }), query("sort", "-created by default"), query("filter", "a filter over level, message, data.*, created")], responses: { "200": object("A page of logs"), "403": errors["403"] } }));
  add("/api/logs/stats", "get", op(tag, "Log counts by hour", "Superusers only.", { parameters: [query("filter", "the same filter as the list")], responses: { "200": { description: "Counts", ...json({ type: "array", items: { type: "object", properties: { date: str(), total: { type: "integer" } } } }) }, "403": errors["403"] } }));
  add("/api/logs/{id}", "get", op(tag, "View one log", "Superusers only.", { parameters: [path("id", "the log id")], responses: { "200": object("The log"), "403": errors["403"], "404": errors["404"] } }));
  add("/api/backups", "get", op(tag, "List backups", "Superusers only.", { responses: { "200": { description: "The backups", ...json({ type: "array", items: { type: "object", properties: { key: str(), size: { type: "integer" }, modified: str(), kind: str({ enum: ["full", "data", "legacy"] }), verified: { type: "boolean" }, voidbase: str({ nullable: true }), offsite: { type: "boolean" }, offsiteError: str() } } }) }, "403": errors["403"] } }));
  add("/api/backups", "post", op(tag, "Take a backup", "Superusers only. One at a time: /api/health says canBackup. Written, read back and verified; copied off-site when VOIDBASE_BACKUP_S3_* are set.", { requestBody: { ...json({ type: "object", properties: { name: str({ description: "optional file name ending in .zip" }), kind: str({ enum: ["full", "data"], description: "full (default): tables, files, settings, schema; data: the non-system collections' rows and files" }) } }) }, responses: { "204": { description: "Started" }, "400": errors["400"], "403": errors["403"] } }));
  add("/api/backups/{key}", "get", op(tag, "Download a backup", "Superusers only, or a file token in ?token.", { parameters: [path("key", "the backup file name"), query("token", "a file token instead of the header")], responses: { "200": { description: "The zip", content: { "application/zip": { schema: str({ format: "binary" }) } } }, "403": errors["403"], "404": errors["404"] } }));
  add("/api/backups/{key}", "delete", op(tag, "Delete a backup", "Superusers only.", { parameters: [path("key", "the backup file name")], responses: { "204": { description: "Deleted" }, "403": errors["403"], "404": errors["404"] } }));
  add("/api/backups/{key}/verify", "post", op(tag, "Verify a backup", "Superusers only. Reads the archive back, hashes every entry and compares the manifest.", { parameters: [path("key", "the backup file name")], responses: { "200": { description: "The result", ...json({ type: "object", properties: { key: str(), kind: str(), verified: { type: "boolean" }, voidbase: str({ nullable: true }), checksum: str({ nullable: true }), entries: { type: "integer" }, corrupted: { type: "array", items: str() }, missing: { type: "array", items: str() }, error: str() } }) }, "400": errors["400"], "403": errors["403"] } }));
  add("/api/backups/{key}/restore", "post", op(tag, "Restore a backup", "Superusers only. A full or legacy archive replaces the instance's data; a data archive replaces the rows and files of the collections it holds on the existing schema (createMissing creates the ones the instance lacks). Refused when the archive was written by a newer voidbase.", { parameters: [path("key", "the backup file name")], requestBody: { ...json({ type: "object", properties: { createMissing: { type: "boolean" } } }) }, responses: { "204": { description: "Started" }, "400": errors["400"], "403": errors["403"], "404": errors["404"] } }));
  add("/api/plugins", "get", op(tag, "What this instance loaded", "Superusers only: the plugins, their tiers and origins, the interfaces and who provides them, any core interface nobody provides, and where the plugins live.", { responses: { "200": object("The inventory"), "403": errors["403"] } }));
}
/** the OpenAPI 3.1 document for these collections as this caller sees them */
export function buildDocument(input) {
  const { collections, caller } = input;
  const byId = new Map(collections.map((c) => [c.id, c]));
  const paths = {};
  const schemas = {
    Error: { type: "object", properties: { status: { type: "integer" }, message: str(), data: { type: "object", additionalProperties: true } }, required: ["status", "message", "data"] },
  };
  paths["/api/health"] = { get: op("system", "Is the API up", "Public. A superuser's token adds canBackup, possibleProxyHeader and realIP under data.", { security: [], responses: { "200": { description: "Healthy", ...json({ type: "object", properties: { code: { type: "integer" }, message: str(), data: { type: "object", additionalProperties: true } }, required: ["code", "message", "data"] }) } } }) };
  const tags = [{ name: "system", description: "the instance itself" }];
  for (const c of collections) {
    const before = Object.keys(paths).length;
    collectionPaths(c, caller, byId, paths, input.verdict);
    if (Object.keys(paths).length === before)
      continue;
    tags.push({ name: c.name, description: `${c.type} collection${c.system ? ", system" : ""}` });
    schemas[c.name] = recordSchema(c, byId);
    schemas[`${c.name}List`] = listSchema(c);
    if (!isView(c)) {
      schemas[`${c.name}Create`] = bodySchema(c, byId, "create");
      schemas[`${c.name}Update`] = bodySchema(c, byId, "update");
    }
    if (isAuth(c))
      schemas[`${c.name}Auth`] = { type: "object", properties: { token: str(), record: ref(c.name) }, required: ["token", "record"] };
  }
  if (caller.kind === "superuser")
    superuserPaths(paths);
  // the instance's own routes: everyone's, unless a superuser's guard is on one; what each answers is what its source
  // says, and any JSON object where the source did not say
  const own = (input.routes ?? []).filter((r) => !r.superuser || caller.kind === "superuser");
  if (own.length)
    tags.push({ name: "hooks", description: "routes this instance's own code adds" });
  for (const r of own) {
    const method = r.method === "ALL" ? "get" : r.method.toLowerCase();
    if (paths[r.path]?.[method])
      continue;
    const parameters = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => path(m[1], "a path parameter"));
    const answer = r.response && Object.keys(r.response).length ? r.response : { type: "object", additionalProperties: true };
    (paths[r.path] ??= {})[method] = op("hooks", `${r.method} ${r.path}`, r.superuser ? "Superusers only. Added by this instance's own code." : "Added by this instance's own code.", { ...(parameters.length ? { parameters } : {}), responses: { "200": { description: "What the route answers", ...json(answer) } } });
  }
  // what plugins added, for a superuser: by method and path, since a plugin's route says nothing about its answer
  if (caller.kind === "superuser") {
    const added = (input.pluginRoutes ?? []).filter((r) => !paths[r.path]?.[r.method.toLowerCase()]);
    if (added.length)
      tags.push({ name: "plugins", description: "routes the instance's plugins add" });
    for (const r of added) {
      const parameters = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => path(m[1], "a path parameter"));
      (paths[r.path] ??= {})[r.method.toLowerCase()] = op("plugins", `${r.method} ${r.path}`, "Added by a plugin.", { ...(parameters.length ? { parameters } : {}), responses: { "200": { description: "What the route answers", ...json({ type: "object", additionalProperties: true }) } } });
    }
  }
  const scope = caller.kind === "anonymous" ? "what an anonymous request may call" : caller.kind === "user" ? `what a signed-in ${caller.collection} record may call` : "everything, as a superuser sees it";
  return {
    openapi: "3.1.0",
    info: {
      title: input.title,
      version: input.version,
      description: `The API of this voidbase instance, generated from its collections and scoped to the token that asked: ${scope}. Sign in through an auth collection's auth-with-password and send the token as \`Authorization: <token>\`, which is what the PocketBase SDKs do.`,
      "x-voidbase": { scope: caller.kind, ...(caller.kind === "anonymous" ? {} : { collection: caller.collection }) },
    },
    servers: [{ url: input.origin }],
    tags,
    paths,
    components: { schemas, securitySchemes: { token: { type: "apiKey", in: "header", name: "Authorization", description: "the token from auth-with-password or auth-refresh, sent as is (no Bearer prefix needed; one is accepted)" } } },
    security: caller.kind === "anonymous" ? [] : [{ token: [] }],
  };
}
// --- the page --------------------------------------------------------------------------------------------------------
// Scalar over the document. The browser cannot put a token on the navigation that opens this page, so the page
// fetches the document itself with the token it has: one pasted here (kept in sessionStorage), else the panel's
// session on this origin (the SDK's localStorage entry), else none. No build step: the reference comes from a CDN.
const DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API reference</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
  #note { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; padding: .6rem 1rem; background: #f4f4f5; border-bottom: 1px solid #d4d4d8; font-size: .9rem; color: #27272a; }
  #note strong { font-weight: 600; }
  #note input { min-width: 22rem; padding: .3rem .5rem; border: 1px solid #a1a1aa; border-radius: 4px; font: inherit; }
  #note button { padding: .3rem .7rem; border: 1px solid #a1a1aa; border-radius: 4px; background: #fff; font: inherit; cursor: pointer; }
  #app:empty::before { content: "Loading the API reference from ${SCALAR_CDN} ..."; display: block; padding: 2rem 1rem; color: #52525b; }
</style>
</head>
<body>
<div id="note">
  <span>This page shows <strong id="who">what your token may call</strong>: with no token, the public API; with a user's, that user's; with a superuser's, everything. The document is <a href="/api/openapi.json">/api/openapi.json</a>, fetched with the same token.</span>
  <form id="token-form"><input id="token" type="password" placeholder="paste a token to see the API as that caller" autocomplete="off"> <button type="submit">Use</button> <button type="button" id="forget">Forget</button></form>
</div>
<div id="app"></div>
<script src="${SCALAR_CDN}"></script>
<script>
(function () {
  var KEY = "voidbase:openapi:token";
  function tokenOf() {
  try { var t = sessionStorage.getItem(KEY); if (t) return t; } catch (e) {}
  try { var pb = JSON.parse(localStorage.getItem("pocketbase_auth") || "null"); if (pb && pb.token) return String(pb.token); } catch (e) {}
  return "";
  }
  document.getElementById("token-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var t = document.getElementById("token").value.trim();
  try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch (e) {}
  location.reload();
  });
  document.getElementById("forget").addEventListener("click", function () { try { sessionStorage.removeItem(KEY); } catch (e) {} location.reload(); });
  var token = tokenOf();
  fetch("/api/openapi.json", { headers: token ? { authorization: token } : {} })
  .then(function (r) { return r.json(); })
  .then(function (spec) {
    var scope = spec.info && spec.info["x-voidbase"] ? spec.info["x-voidbase"] : { scope: "anonymous" };
    document.getElementById("who").textContent = scope.scope === "anonymous" ? "the public API (no token)" : scope.scope === "superuser" ? "everything (a superuser token)" : "what a " + scope.collection + " record may call (a user token)";
    var config = { content: spec };
    if (token) config.authentication = { preferredSecurityScheme: "token", securitySchemes: { token: { value: token } } };
    window.Scalar.createApiReference("#app", config);
  })
  .catch(function (err) { document.getElementById("app").textContent = "Could not load /api/openapi.json: " + err; });
})();
</script>
</body>
</html>
`;
/** the core's own routes, which the document already describes one collection at a time, or deliberately leaves out */
const CORE_PREFIXES = ["/api/collections", "/api/settings", "/api/logs", "/api/backups", "/api/files", "/api/realtime", "/api/batch", "/api/crons", "/api/health", "/api/openapi.json", "/api/docs", "/api/sql", "/api/oauth2-redirect"];
/** the routes registered on the app that are neither the core's own nor a catch-all, in OpenAPI's path form */
function pluginRoutesOf(app) {
  const seen = new Set();
  return (app.routes ?? []).flatMap((r) => {
    if (!r.path.startsWith("/api/") || r.path.includes("*") || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(r.method))
      return [];
    if (CORE_PREFIXES.some((p) => r.path === p || r.path.startsWith(`${p}/`)))
      return [];
    const path = r.path.replace(/:(\w+)/g, "{$1}");
    const k = `${r.method} ${path}`;
    if (seen.has(k))
      return [];
    seen.add(k);
    return [{ method: r.method, path }];
  });
}
// --- the plugin --------------------------------------------------------------------------------------------------------
/** each rule of each collection decided for this caller, keyed by collection and rule; no database, nothing decided */
async function verdictsFor(env, collections, auth) {
  const verdicts = new Map();
  if (!env?.DB)
    return verdicts;
  const byKey = new Map(collections.flatMap((x) => [[x.name, x], [x.id, x]]));
  for (const c of collections) {
    for (const rule of new Set([c.listRule, c.viewRule, c.createRule, c.updateRule, c.deleteRule])) {
      if (rule === null || rule.trim() === "")
        continue;
      verdicts.set(`${c.name}\n${rule}`, await decideRule({ db: env.DB, collections: byKey, collection: c, rule, auth: auth ? { collection: auth.collection, row: auth.row } : null }));
    }
  }
  return verdicts;
}
function mountRoutes(app, version, source) {
  app.get("/api/openapi.json", async (c) => {
    const collections = await source.collections(c.env);
    const name = (await source.appName(c.env).catch(() => "")).trim();
    const caller = callerOf(c.get("auth"));
    const verdicts = caller.kind === "superuser" ? new Map() : await verdictsFor(c.env, collections, c.get("auth") ?? null);
    const doc = buildDocument({ collections, caller, verdict: (collection, rule) => verdicts.get(`${collection}\n${rule}`), title: name || "voidbase", origin: new URL(c.req.url).origin, version, routes: hookRouteDocs(), pluginRoutes: pluginRoutesOf(app) });
    c.header("Cache-Control", "no-store");
    return c.json(doc);
  });
  app.get("/api/docs", (c) => { c.header("Cache-Control", "no-store"); return c.html(DOCS_PAGE); });
}
/** the plugin over a source of its own: tests hand in collections and a name without a database */
export const openapiWith = (source = {}, version = VERSION) => ({
  apply(ctx) {
    mountRoutes(ctx.app, version, { ...defaultSource, ...source });
    serve(ctx, "openapi@1", { document: (input) => buildDocument(input) });
  },
});
/** the shipped plugin: the instance's own collections and settings */
const openapi = openapiWith();

// what the plugin does; its declaration is manifest.json beside this file, which the instance reads
export default openapi;
