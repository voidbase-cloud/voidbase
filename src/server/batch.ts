// POST /api/batch (apis/batch.go): a list of record create/update/upsert/delete requests executed in order
// through the same handlers. D1 has no interactive transactions, so atomicity is emulated: every applied
// request records an undo statement (delete the created row, restore the previous row) and a failure rolls
// them back in one D1 batch before answering with PocketBase's error shape. Files of rolled-back creates are
// removed; files removed by a rolled-back delete cannot be restored, and cascades are not undone.
import type { Context, Hono } from "hono";
import { loadCollections } from "./collections/model";
import { ident, one, stmt } from "./db";
import { ApiError, badRequest, forbidden } from "./errors";
import { deletePrefix, normalizeFilename } from "./records/files";
import { loadSettings } from "./settings";
import type { AppEnv, Row } from "./types";
import type { Field } from "./collections/fields";
import { toColumn } from "./records/values";

interface InternalRequest { method?: string; url?: string; headers?: Record<string, string>; body?: Record<string, unknown> }
const ACTIONS: { re: RegExp; kind: "upsert" | "create" | "update" | "delete" }[] = [
  { re: /^PUT \/api\/collections\/([^/?]+)\/records(\?.*)?$/, kind: "upsert" },
  { re: /^POST \/api\/collections\/([^/?]+)\/records(\?.*)?$/, kind: "create" },
  { re: /^PATCH \/api\/collections\/([^/?]+)\/records\/([^/?]+)(\?.*)?$/, kind: "update" },
  { re: /^DELETE \/api\/collections\/([^/?]+)\/records\/([^/?]+)(\?.*)?$/, kind: "delete" },
];
export const BATCH_CONTEXT_HEADER = "x-voidbase-internal-context";
// per isolate; external requests cannot forge it. Generated lazily: Workers forbid random values at module scope.
let batchToken: string | null = null;
export const batchContextToken = () => (batchToken ??= crypto.randomUUID());

export function mountBatch(app: Hono<AppEnv>) {
  app.post("/api/batch", async (c) => {
    const settings = await loadSettings(c.env.DB);
    if (!settings.batch.enabled || settings.batch.maxRequests <= 0) throw forbidden("Batch requests are not allowed.");
    const { requests, files } = await readBatchBody(c);
    if (!requests) throw new ApiError(400, "Invalid batch request data.", { requests: { code: "validation_required", message: "Cannot be blank." } } as never);
    if (requests.length > settings.batch.maxRequests) throw new ApiError(400, "Invalid batch request data.", { requests: { code: "validation_length_too_long", message: `The length must be no more than ${settings.batch.maxRequests}.`, params: { max: settings.batch.maxRequests, min: 0 } } } as never);
    const collections = await loadCollections(c.env.DB);
    const origin = new URL(c.req.url).origin;
    const results: { body: unknown; status: number }[] = [];
    const undo: { statements: D1PreparedStatement[]; filePrefixes: string[] } = { statements: [], filePrefixes: [] };
    const fail = async (index: number, response: unknown) => {
      if (undo.statements.length) { try { await c.env.DB.batch(undo.statements.reverse()); } catch (err) { console.error("voidbase: batch rollback failed", err); } }
      for (const p of undo.filePrefixes) { try { await deletePrefix(c.env.STORAGE, p); } catch { /* best effort */ } }
      throw new ApiError(400, "Batch transaction failed.", { requests: { [String(index)]: { code: "batch_request_failed", message: "Batch request failed.", response } } } as never);
    };
    for (let i = 0; i < requests.length; i++) {
      const ir = requests[i] ?? {};
      let method = String(ir.method ?? "").toUpperCase(), url = String(ir.url ?? "");
      const action = ACTIONS.map((a) => ({ a, m: a.re.exec(`${method} ${url}`) })).find((x) => x.m);
      if (!action) await fail(i, { data: {}, message: "Something went wrong while processing your request.", status: 400 });
      const [, collName, maybeId] = action!.m!;
      const collection = collections.get(collName!) ?? null;
      let kind = action!.a.kind;
      let id = kind === "update" || kind === "delete" ? maybeId! : "";
      if (kind === "upsert") {
        const bodyId = String(ir.body?.id ?? "");
        const existing = bodyId && collection ? await one<Row>(c.env.DB, `SELECT id FROM ${ident(collection.name)} WHERE id = ? LIMIT 1`, [bodyId]) : null;
        const query = action!.m![2] ?? "";
        if (existing) { kind = "update"; id = bodyId; method = "PATCH"; url = `/api/collections/${collName}/records/${bodyId}${query}`; }
        else { kind = "create"; method = "POST"; url = `/api/collections/${collName}/records${query}`; }
      }
      // snapshot for the undo of updates and deletes
      const before = (kind === "update" || kind === "delete") && collection ? await one<Row>(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE id = ? LIMIT 1`, [id]) : null;
      const headers = new Headers(c.req.raw.headers);
      headers.delete("content-type"); headers.delete("content-length");
      for (const [k, v] of Object.entries(ir.headers ?? {})) if (k.toLowerCase() !== "authorization") headers.set(k, v);
      headers.set(BATCH_CONTEXT_HEADER, batchContextToken());
      let body: BodyInit | undefined;
      const reqFiles = files.get(i);
      if (reqFiles && reqFiles.length) {
        const fd = new FormData();
        fd.append("@jsonPayload", JSON.stringify(ir.body ?? {}));
        // PocketBase normalizes the uploaded name once here (NewFileFromMultipart) and again in the record form
        for (const [field, file] of reqFiles) fd.append(field, file, normalizeFilename(file.name, file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : ""));
        body = fd;
      } else if (method !== "DELETE") { body = JSON.stringify(ir.body ?? {}); headers.set("content-type", "application/json"); }
      const res = await app.fetch(new Request(origin + url, { method, headers, body }), c.env, c.executionCtx);
      const text = await res.text();
      let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      if (res.status >= 400) await fail(i, json);
      results.push({ body: json, status: res.status });
      if (!collection) continue;
      const table = ident(collection.name);
      if (kind === "create") {
        const createdId = String((json as { id?: string })?.id ?? "");
        if (createdId) { undo.statements.push(stmt(c.env.DB, `DELETE FROM ${table} WHERE id = ?`, [createdId])); undo.filePrefixes.push(`${collection.id}/${createdId}/`); }
      } else if (before) {
        const fields = collection.fields as Field[];
        const cols = fields.map((f) => ident(f.name));
        const params = fields.map((f) => before[f.name] === undefined ? null : toColumn(f, before[f.name]));
        undo.statements.push(kind === "delete"
          ? stmt(c.env.DB, `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params)
          : stmt(c.env.DB, `UPDATE ${table} SET ${fields.filter((f) => f.name !== "id").map((f) => `${ident(f.name)} = ?`).join(", ")} WHERE id = ?`, [...fields.filter((f) => f.name !== "id").map((f) => before[f.name] === undefined ? null : toColumn(f, before[f.name])), id]));
      }
    }
    return c.json(results);
  });
}

async function readBatchBody(c: Context<AppEnv>): Promise<{ requests: InternalRequest[] | null; files: Map<number, [string, File][]> }> {
  const ct = c.req.header("content-type") ?? "";
  const files = new Map<number, [string, File][]>();
  try {
    if (ct.includes("multipart/form-data")) {
      const fd = await c.req.formData();
      let payload: { requests?: InternalRequest[] } = {};
      const raw = fd.get("@jsonPayload");
      if (typeof raw === "string") payload = JSON.parse(raw) as typeof payload;
      for (const [key, value] of fd.entries()) {
        const m = /^requests[.[](\d+)[.\]]\.?(.+)$/.exec(key.replace(/\]\./, "."));
        if (!m || !(value instanceof File)) continue;
        const idx = Number(m[1]); const field = m[2]!.replace(/^\./, "");
        if (!files.has(idx)) files.set(idx, []);
        files.get(idx)!.push([field, value]);
      }
      return { requests: Array.isArray(payload.requests) && payload.requests.length ? payload.requests : null, files };
    }
    const json = (await c.req.json()) as { requests?: InternalRequest[] };
    return { requests: Array.isArray(json?.requests) && json.requests.length ? json.requests : null, files };
  } catch { throw badRequest("Failed to read the submitted batch data."); }
}
